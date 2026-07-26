/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md under the GNU AGPL v3.0.
 *
 * Cloudflare Worker: assist.flatwrite.md
 *
 * Morph-powered document assist:
 *   POST /assist       — JSON assist pipeline
 *   POST /mcp-token    — short-lived browser token (scope: assist)
 *   GET  /health       — liveness
 *
 * Auth mirrors workers/flatwrite-render:
 *   X-Mcp-Token  — short-lived HMAC (browser-safe)
 *   X-Api-Key    — long-lived key, rejected when Origin is present
 */

import {
  mintToken,
  verifyToken,
  constantTimeEqual,
} from '../../../public/webmcp-shared.js';
import { parseAssistRequest } from './schema.js';
import { createMorphClient } from './morph.js';
import { runAssistPipeline } from './pipeline.js';

const TOKEN_TTL_SECONDS = 60;
const TOKEN_SCOPE = 'assist';
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_PER_IP = 10;
const tokenRequestLog = new Map();
const assistRequestLog = new Map();

const TRUSTED_ORIGINS = new Set([
  'https://flatwrite.md',
  'https://www.flatwrite.md',
]);

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function isTrustedOrigin(origin) {
  if (!origin) return false;
  if (TRUSTED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.flatwrite\.md$/i.test(origin)) return true;
  // Local dev convenience
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  return false;
}

function corsFor(req) {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  if (!isTrustedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
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

const MAX_RATE_LIMIT_KEYS = 10000;

function isRateLimited(map, ip, max) {
  if (!ip) return false;
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
  let log = map.get(ip) || [];
  const cutoff = now - windowMs;
  log = log.filter((ts) => ts > cutoff);
  if (log.length >= max) {
    map.set(ip, log);
    return true;
  }
  log.push(now);
  map.set(ip, log);
  /* Evict oldest keys when the Map exceeds a hard cap. Cloudflare
     Worker isolates can live for hours, so per-IP entries from
     scanners/bots can accumulate indefinitely. We delete the
     oldest-inserted keys (Map preserves insertion order) to bound
     memory usage. */
  if (map.size > MAX_RATE_LIMIT_KEYS) {
    const keysToDelete = map.size - MAX_RATE_LIMIT_KEYS;
    let deleted = 0;
    for (const key of map.keys()) {
      if (deleted >= keysToDelete) break;
      map.delete(key);
      deleted++;
    }
  }
  return false;
}

async function authenticateRequest(req, env) {
  if (!env.API_KEY) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: { code: 'MISCONFIGURED', message: 'Worker misconfigured', retryable: false } },
    };
  }
  const token = req.headers.get('X-Mcp-Token');
  if (token) {
    const v = await verifyToken(env.API_KEY, token, TOKEN_SCOPE);
    if (v.ok) return { ok: true, kind: 'token' };
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
          retryable: false,
          detail: v.reason,
        },
      },
    };
  }
  if (isBrowserRequest(req)) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: {
          code: 'API_KEY_NOT_ALLOWED_FROM_BROWSER',
          message: 'X-Api-Key cannot be used from a browser. Use X-Mcp-Token instead.',
          retryable: false,
        },
      },
    };
  }
  const apiKey = req.headers.get('X-Api-Key');
  if (constantTimeEqual(apiKey || '', env.API_KEY || '')) return { ok: true, kind: 'key' };
  return {
    ok: false,
    status: 401,
    body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized', retryable: false } },
  };
}

function preflightHeaders(cors, requested) {
  const allowed = ['Content-Type', 'X-Mcp-Token', 'Accept'];
  let allowHeaders = allowed.join(', ');
  if (requested) {
    const requestedList = requested.split(',').map((h) => h.trim().toLowerCase());
    const filtered = requestedList
      .map((h) => allowed.find((a) => a.toLowerCase() === h))
      .filter(Boolean);
    if (filtered.length > 0) allowHeaders = filtered.join(', ');
  }
  return {
    ...cors,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': '600',
  };
}

async function handleMintToken(req, env) {
  if (!env.API_KEY) {
    return jsonResponse(500, {
      ok: false,
      error: { code: 'MISCONFIGURED', message: 'Worker misconfigured', retryable: false },
    });
  }
  const cors = corsFor(req);
  const origin = req.headers.get('Origin');
  if (!origin || !isTrustedOrigin(origin)) {
    return jsonResponse(
      403,
      { ok: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed', retryable: false } },
      cors,
    );
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(tokenRequestLog, ip, RATE_LIMIT_MAX_PER_IP)) {
    return jsonResponse(
      429,
      { ok: false, error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded', retryable: true } },
      cors,
    );
  }
  const { token, exp } = await mintToken(env.API_KEY, TOKEN_TTL_SECONDS, TOKEN_SCOPE);
  return jsonResponse(200, { token, expiresAt: exp, scope: TOKEN_SCOPE }, cors);
}

async function handleAssist(req, env) {
  const cors = corsFor(req);
  const auth = await authenticateRequest(req, env);
  if (!auth.ok) return jsonResponse(auth.status, auth.body, cors);

  if (!env.MORPH_API_KEY) {
    return jsonResponse(
      500,
      {
        ok: false,
        error: {
          code: 'MISCONFIGURED',
          message: 'MORPH_API_KEY is not configured',
          retryable: false,
        },
      },
      cors,
    );
  }

  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
  if (isRateLimited(assistRequestLog, ip, RATE_LIMIT_MAX_PER_IP)) {
    return jsonResponse(
      429,
      {
        ok: false,
        error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded', retryable: true },
      },
      cors,
      { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
    );
  }

  let raw;
  try {
    raw = await req.json();
  } catch (e) {
    return jsonResponse(
      400,
      {
        ok: false,
        error: { code: 'INVALID_JSON', message: 'Invalid JSON body', retryable: false, detail: e.message },
      },
      cors,
    );
  }

  const parsed = parseAssistRequest(raw);
  if (!parsed.ok) return jsonResponse(parsed.status, parsed.body, cors);

  let morph;
  try {
    morph = createMorphClient(env);
  } catch (e) {
    return jsonResponse(
      500,
      {
        ok: false,
        error: { code: 'MISCONFIGURED', message: e.message, retryable: false },
      },
      cors,
    );
  }

  try {
    const result = await runAssistPipeline(parsed.value, morph);
    return jsonResponse(result.status, result.body, cors);
  } catch (e) {
    return jsonResponse(
      502,
      {
        ok: false,
        error: {
          code: 'ASSIST_FAILED',
          message: e.message || 'Assist pipeline failed',
          retryable: true,
        },
      },
      cors,
    );
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      const cors = corsFor(req);
      const requested = req.headers.get('Access-Control-Request-Headers');
      return new Response(null, { status: 204, headers: preflightHeaders(cors, requested) });
    }

    if (url.pathname === '/health' && method === 'GET') {
      return jsonResponse(200, {
        ok: true,
        service: 'flatwrite-assist',
        morphConfigured: Boolean(env.MORPH_API_KEY),
      });
    }

    if (url.pathname === '/mcp-token' && method === 'POST') {
      return handleMintToken(req, env);
    }

    if ((url.pathname === '/assist' || url.pathname === '/' || url.pathname === '') && method === 'POST') {
      return handleAssist(req, env);
    }

    if (method !== 'POST' && (url.pathname === '/assist' || url.pathname === '/')) {
      return jsonResponse(405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only', retryable: false },
      });
    }

    return jsonResponse(404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not Found', retryable: false },
    });
  },
};

// Test helpers (not used in production path)
export {
  authenticateRequest,
  isTrustedOrigin,
  isRateLimited,
  TOKEN_SCOPE,
};
