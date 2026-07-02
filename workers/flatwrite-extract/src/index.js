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
  sign,
} from '../../../public/webmcp-shared.js';

/**
 * Cloudflare Worker: extract.flatwrite.md
 *
 * Multipart upload proxy in front of the Fly.io-hosted MarkItDown service.
 * Mirrors the auth, CORS, and HMAC-signing pattern of flatwrite-render.
 *
 *   - POST /extract         → forwards the multipart body to the upstream
 *                             Fly.io service at POST /extract, after
 *                             re-signing with INTERNAL_EXTRACT_KEY.
 *   - POST /mcp-token       → mints a short-lived HMAC-signed token for
 *                             browser-side WebMCP clients (mirrors render).
 *   - OPTIONS               → 204 with CORS headers (only for trusted
 *                             origins).
 *
 * Auth model:
 *   - X-Api-Key    — long-lived key, server-to-server only. Rejected if
 *                    the request carries an Origin header.
 *   - X-Mcp-Token  — short-lived HMAC token (60s default). Browser-safe.
 *                    The Worker validates the signature against
 *                    env.API_KEY, then strips the caller's credential and
 *                    re-signs with env.INTERNAL_EXTRACT_KEY for the
 *                    upstream call. The upstream never sees the caller's
 *                    X-Api-Key or X-Mcp-Token.
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

const TRUSTED_ORIGINS = new Set([
  'https://flatwrite.md',
]);

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
  const method = req.method.toUpperCase();
  if (method !== 'POST') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
  }

  const cors = corsFor(req, devOrigins);
  const auth = await authenticateRequest(req, env);
  if (!auth.ok) return jsonResponse(auth.status, auth.body, cors);

  if (!env.INTERNAL_EXTRACT_KEY) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' }, cors);
  }
  if (!env.UPSTREAM_URL) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' }, cors);
  }

  // The browser sends multipart/form-data. We forward the body verbatim
  // (no parsing on the Worker side) and re-sign with INTERNAL_EXTRACT_KEY
  // so the upstream Fly service can verify the request came from the Worker.
  // Cloudflare's `fetch()` will stream the body to the upstream without
  // buffering the full file in memory.
  const contentType = req.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return jsonResponse(415, {
      error: 'Content-Type must be multipart/form-data',
      code: 'UNSUPPORTED_MEDIA_TYPE',
    }, cors);
  }

  // Reject oversized uploads at the Worker edge to avoid paying the
  // upstream egress for a request the Fly service will reject anyway.
  // 25 MB hard cap, matches the Fly service.
  const contentLength = parseInt(req.headers.get('Content-Length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024) {
    return jsonResponse(413, {
      error: 'Payload too large (25 MB max)',
      code: 'PAYLOAD_TOO_LARGE',
    }, cors);
  }

  // Sign the request with the internal key. The payload format is
  // `<timestamp>.<method>.<path>` — keeps it easy to verify on the
  // upstream side without an extra dependency.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sign(env.INTERNAL_EXTRACT_KEY, `${timestamp}.POST./extract`);

  let upstream;
  try {
    upstream = await fetch(`${env.UPSTREAM_URL}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Extract-Timestamp': String(timestamp),
        'X-Extract-Signature': signature,
      },
      body: req.body,
    });
  } catch (e) {
    return jsonResponse(502, {
      error: 'Failed to reach upstream extract service',
      code: 'UPSTREAM_UNREACHABLE',
      detail: e.message,
    }, cors);
  }

  // Forward the upstream JSON response verbatim, preserving its status.
  // FastAPI always returns JSON from /extract, so we can pass the body
  // through as text and set the right content-type.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors,
    },
  });
}

async function handleMintToken(req, env, devOrigins) {
  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'OPTIONS') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
  }
  if (!env.API_KEY) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' });
  }
  const cors = corsFor(req, devOrigins);
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
