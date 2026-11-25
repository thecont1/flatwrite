/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * For commercial, closed-source embedding, and SaaS deployment exemptions,
 * a valid Commercial License Agreement is required. Contact: sales@flatwrite.md
 */

import {
  mintToken,
  verifyToken,
  constantTimeEqual,
} from '../../../public/webmcp-shared.js';
import { convert, ExtractError } from '../../../public/extract-core.js';
import { enginesReady } from './engines.js';

/**
 * Cloudflare Worker: extract.flatwrite.md
 *
 * Multipart upload endpoint that converts documents to Markdown in-process
 * with WASM engines (@firecrawl/anydoc-wasm + @firecrawl/pdf-inspector-wasm).
 * No upstream service: conversion happens inside this isolate. Auth and CORS
 * mirror flatwrite-render.
 *
 *   - POST /extract         → multipart/form-data with a `file` field;
 *                             converts in-process and returns
 *                             { markdown, metadata } as JSON.
 *   - POST /mcp-token       → mints a short-lived HMAC-signed token for
 *                             browser-side WebMCP clients (mirrors render).
 *   - OPTIONS               → 204 with CORS headers (only for trusted
 *                             origins).
 *
 * Accepted file types on this API: pdf, word, powerpoint, excel, csv, epub.
 * Images and audio are deliberately rejected with 415 UNSUPPORTED_FILE_TYPE
 * (browser-side extraction handles those locally instead; this public API
 * is document-only).
 *
 * Auth model:
 *   - X-Api-Key    — long-lived key, server-to-server only. Rejected if
 *                    the request carries an Origin header.
 *   - X-Mcp-Token  — short-lived HMAC token (60s default). Browser-safe.
 *                    The Worker validates the signature against env.API_KEY.
 *
 * Error wire contract (preserved from the previous Fly-hosted service):
 *   - Worker-level validation errors (method, auth, content-type, boundary,
 *     size pre-check, missing file field) are flat: { error, code }.
 *   - Conversion-stage errors mirror the old FastAPI service's wrapped
 *     shape: { detail: { error, code } } with the ExtractError's
 *     status/code/message (EMPTY_FILE 400, PAYLOAD_TOO_LARGE 413,
 *     UNSUPPORTED_FILE_TYPE 415, ENCRYPTED 422, NEEDS_OCR 422,
 *     CONVERT_FAILED 500).
 *
 * CORS:
 *   - Same trusted-origin allowlist as flatwrite-render.
 *   - X-Api-Key is intentionally absent from the preflight allow-headers
 *     list; long-lived keys are server-to-server only.
 */

const TOKEN_TTL_SECONDS = 60;

// Per-IP rate limiting for the /mcp-token endpoint. Local guard; production
// deploys should back this with KV or Durable Objects.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_TOKENS_PER_IP = 10;
const tokenRequestLog = new Map(); // ip -> array of timestamps

// Hard cap on distinct tracked IPs to bound memory under an IP-rotation
// attack. This is a stop-gap for a single-isolate in-memory Map; a
// production deploy should back this with Workers KV or a Durable Object
// (with TTL) instead.
const MAX_TRACKED_IPS = 10_000;

const TRUSTED_ORIGINS = new Set([
  'https://flatwrite.md',
]);

// Document types accepted on this API. Images and audio are excluded on
// purpose: OCR/transcription runs browser-side, and this endpoint is
// document-only — extract-core maps excluded types to 415.
const ALLOW_TYPES = ['pdf', 'word', 'powerpoint', 'excel', 'csv', 'epub'];

/**
 * Extra origins trusted for CORS, sourced from the `ALLOWED_DEV_ORIGINS`
 * env var (set via `wrangler secret put` or `[vars]` in wrangler.toml).
 * Production leaves this empty so the strict allowlist above is the
 * only thing that matters. Local dev and CI can opt in to
 * `http://127.0.0.1:8080` etc. Comma-separated.
 */
function parseDevOrigins(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isTokenRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
  let log = tokenRequestLog.get(ip);
  if (!log) {
    if (tokenRequestLog.size >= MAX_TRACKED_IPS) {
      // Maps preserve insertion order — evict the oldest tracked IP to
      // make room, rather than letting the Map grow without bound.
      const oldestKey = tokenRequestLog.keys().next().value;
      tokenRequestLog.delete(oldestKey);
    }
    log = [];
    tokenRequestLog.set(ip, log);
  }
  const cutoff = now - windowMs;
  const withinWindow = log.filter((ts) => ts > cutoff);
  if (withinWindow.length >= RATE_LIMIT_MAX_TOKENS_PER_IP) {
    return true;
  }
  withinWindow.push(now);
  tokenRequestLog.set(ip, withinWindow);
  return false;
}

function isTrustedOrigin(origin, devOrigins) {
  if (!origin) return false;
  if (TRUSTED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.flatwrite\.md$/i.test(origin)) return true;
  if (devOrigins && devOrigins.includes(origin)) return true;
  return false;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function corsFor(req, devOrigins) {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  if (!isTrustedOrigin(origin, devOrigins)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
}

function jsonResponse(status, payload, cors = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...cors, ...extraHeaders },
  });
}

function isBrowserRequest(req) {
  return Boolean(req.headers.get('Origin'));
}

async function authenticateRequest(req, env) {
  if (!env.API_KEY) {
    return { ok: false, status: 500, body: { error: 'Worker misconfigured', code: 'MISCONFIGURED' } };
  }
  // Short-lived token — accepted from any caller.
  const token = req.headers.get('X-Mcp-Token');
  if (token) {
    const v = await verifyToken(env.API_KEY, token, 'mcp');
    if (v.ok) return { ok: true, kind: 'token' };
    return {
      ok: false,
      status: 401,
      body: { error: 'Invalid or expired token', code: 'INVALID_TOKEN', detail: v.reason },
    };
  }
  // Long-lived key — server-to-server only.
  if (isBrowserRequest(req)) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'X-Api-Key cannot be used from a browser. Use X-Mcp-Token instead.',
        code: 'API_KEY_NOT_ALLOWED_FROM_BROWSER',
      },
    };
  }
  const apiKey = req.headers.get('X-Api-Key');
  if (constantTimeEqual(apiKey || '', env.API_KEY || '')) return { ok: true, kind: 'key' };
  return { ok: false, status: 401, body: { error: 'Unauthorized', code: 'UNAUTHORIZED' } };
}

function preflightHeaders(cors, requested) {
  // Note: Content-Type is needed for multipart/form-data requests from
  // the browser. X-Api-Key is intentionally absent — long-lived keys are
  // server-to-server only.
  const allowed = ['Content-Type', 'X-Mcp-Token', 'Accept'];
  let allowHeaders = allowed.join(', ');
  if (requested) {
    const requestedList = requested.split(',').map((h) => h.trim().toLowerCase());
    const filtered = requestedList
      .map((h) => allowed.find((a) => a.toLowerCase() === h))
      .filter((h) => Boolean(h));
    if (filtered.length > 0) allowHeaders = filtered.join(', ');
  }
  return {
    ...cors,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': '600',
  };
}

async function handleExtract(req, env, devOrigins) {
  const cors = corsFor(req, devOrigins);
  if (req.method.toUpperCase() !== 'POST') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' }, cors);
  }

  const auth = await authenticateRequest(req, env);
  if (!auth.ok) return jsonResponse(auth.status, auth.body, cors);

  const contentType = req.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return jsonResponse(415, {
      error: 'Content-Type must be multipart/form-data',
      code: 'UNSUPPORTED_MEDIA_TYPE',
    }, cors);
  }

  // A multipart body without a usable boundary is malformed — reject at
  // the edge before paying for body parsing.
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch || !(boundaryMatch[1] || boundaryMatch[2])) {
    return jsonResponse(400, {
      error: 'multipart/form-data boundary missing',
      code: 'BAD_REQUEST',
    }, cors);
  }

  // Reject oversized uploads at the Worker edge before buffering the body.
  // 25 MB hard cap, matches extract-core's MAX_BYTES.
  const contentLength = parseInt(req.headers.get('Content-Length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024) {
    return jsonResponse(413, {
      error: 'Payload too large (25 MB max)',
      code: 'PAYLOAD_TOO_LARGE',
    }, cors);
  }

  let formData;
  try {
    formData = await req.formData();
  } catch {
    return jsonResponse(400, {
      error: 'malformed multipart body',
      code: 'BAD_REQUEST',
    }, cors);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return jsonResponse(400, {
      error: 'multipart file field is required',
      code: 'BAD_REQUEST',
    }, cors);
  }
  // The old FastAPI service rejected an empty filename with a wrapped
  // detail error — preserve that exact wire shape here.
  if (!file.name) {
    return jsonResponse(400, {
      detail: { error: 'filename is empty', code: 'BAD_REQUEST' },
    }, cors);
  }

  const engines = await enginesReady;
  if (!engines) {
    // initEngines already logged the cause server-side. Never crash the
    // isolate; fail the conversion cleanly instead.
    return jsonResponse(500, {
      detail: { error: 'Conversion failed', code: 'CONVERT_FAILED' },
    }, cors);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await convert({
      bytes,
      filename: file.name,
      engines,
      allowTypes: ALLOW_TYPES,
    });
    return jsonResponse(200, {
      markdown: result.markdown,
      metadata: result.metadata,
    }, cors);
  } catch (error) {
    if (error instanceof ExtractError) {
      // Conversion-stage errors keep the FastAPI-style wrapped shape the
      // frontend and API clients parse.
      return jsonResponse(error.status, {
        detail: { error: error.message, code: error.code },
      }, cors);
    }
    // Unexpected engine/runtime failure: log server-side, never leak
    // internals to the caller.
    console.error('flatwrite-extract: unexpected conversion error:', error);
    return jsonResponse(500, {
      detail: { error: 'Conversion failed', code: 'CONVERT_FAILED' },
    }, cors);
  }
}

async function handleMintToken(req, env, devOrigins) {
  const cors = corsFor(req, devOrigins);
  // OPTIONS is already handled by the top-level fetch() router before it
  // ever reaches here, so only POST is a valid method at this point.
  if (req.method.toUpperCase() !== 'POST') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' }, cors);
  }
  if (!env.API_KEY) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' }, cors);
  }
  const origin = req.headers.get('Origin');
  if (!origin || !isTrustedOrigin(origin, devOrigins)) {
    return jsonResponse(403, { error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }, cors);
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (isTokenRateLimited(ip)) {
    return jsonResponse(429, { error: 'Rate limit exceeded', code: 'RATE_LIMIT' }, cors);
  }
  const { token, exp } = await mintToken(env.API_KEY, TOKEN_TTL_SECONDS, 'mcp');
  return jsonResponse(200, { token, expiresAt: exp, scope: 'mcp' }, cors);
}

// Exposed for tests only — lets test suites assert the rate-limit Map
// stays bounded without needing to issue 10,000+ real requests through
// the full Worker fetch() handler.
export const __testing = { tokenRequestLog, MAX_TRACKED_IPS, isTokenRateLimited };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const devOrigins = parseDevOrigins(env.ALLOWED_DEV_ORIGINS);

    if (method === 'OPTIONS') {
      const cors = corsFor(req, devOrigins);
      const requested = req.headers.get('Access-Control-Request-Headers');
      return new Response(null, { status: 204, headers: preflightHeaders(cors, requested) });
    }

    if (url.pathname === '/mcp-token') {
      return handleMintToken(req, env, devOrigins);
    }

    if (url.pathname === '/extract' || url.pathname === '/' || url.pathname === '') {
      return handleExtract(req, env, devOrigins);
    }

    return jsonResponse(404, { error: 'Not Found', code: 'NOT_FOUND' });
  },
};
