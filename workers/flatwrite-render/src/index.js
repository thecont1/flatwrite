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

import yaml from 'js-yaml';
import {
  mintToken,
  verifyToken,
  constantTimeEqual,
  sign,
} from '../../../public/webmcp-shared.js';

/**
 * Cloudflare Worker: render.flatwrite.md
 *
 * JSON-first façade in front of the canonical /api/render handler on
 * flatwrite.md. Optional YAML mode preserved for backward compatibility.
 *
 *   - POST application/json  → forwards body to /api/render, returns { head, body }
 *   - POST text/yaml         → parses YAML, fetches `url`, builds JSON, forwards
 *   - POST /mcp-token        → mints a short-lived HMAC-signed token for
 *                               browser-side WebMCP clients. Validates Origin
 *                               against a trusted-origin allowlist and
 *                               rate-limits per IP.
 *   - OPTIONS                → 204 with CORS headers (only when Origin
 *                               is on the trusted-origin allowlist)
 *
 * Auth model:
 *   - X-Api-Key  — long-lived key, server-to-server only. Rejected if
 *                   the request carries an Origin header. Used by the
 *                   README curl examples, the MCP stdio server, the
 *                   MCP Streamable HTTP server, and the WebMCP Worker
 *                   when called via the MCP tools. Set via
 *                   `wrangler secret put API_KEY`.
 *   - X-Mcp-Token — short-lived HMAC token (60s default). Browser-safe.
 *                    Used by the WebMCP page-side script (public/webmcp.js)
 *                    which cannot safely embed the long-lived key. The
 *                    Worker validates the token and replaces it with
 *                    the upstream X-Api-Key before forwarding to
 *                    /api/render. Tokens are minted by POST /mcp-token
 *                    and scoped to "mcp".
 *
 * CORS:
 *   - Allowlisted origins get a single-value Access-Control-Allow-Origin
 *     echoing the request's Origin. This is required for the browser
 *     to read the response when the response carries credentialed
 *     custom headers (X-Mcp-Token) — `*` would block that.
 *   - Untrusted origins get NO Access-Control-Allow-Origin. The browser
 *     blocks the response from being read by JS.
 *   - The preflight allow-headers list is restricted to
 *     `Content-Type, X-Mcp-Token, Accept, Mcp-Session-Id, Last-Event-Id`.
 *     It does NOT include `X-Api-Key` — the long-lived key path is
 *     server-to-server only.
 */

const TOKEN_TTL_SECONDS = 60;

// Per-IP rate limiting for the /mcp-token endpoint. Production deploys
// should eventually back this with Cloudflare KV or Durable Objects so
// the limit is shared across Worker instances; the in-memory map below
// is a local guard that still mitigates single-instance bursts.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_TOKENS_PER_IP = 10;
const tokenRequestLog = new Map(); // ip -> array of timestamps

const TRUSTED_ORIGINS = new Set([
  'https://flatwrite.md',
]);

/**
 * Check whether a client IP has exceeded the /mcp-token rate limit.
 * Uses a simple sliding-window counter kept in memory. Returns true
 * if the request is allowed, false if it should be throttled.
 */
function isTokenRateLimited(ip) {
  if (!ip) return false; // can't rate-limit without an IP
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
  let log = tokenRequestLog.get(ip);
  if (!log) {
    log = [];
    tokenRequestLog.set(ip, log);
  }
  // Evict entries outside the sliding window.
  const cutoff = now - windowMs;
  const withinWindow = log.filter((ts) => ts > cutoff);
  if (withinWindow.length >= RATE_LIMIT_MAX_TOKENS_PER_IP) {
    return true;
  }
  withinWindow.push(now);
  tokenRequestLog.set(ip, withinWindow);
  return false;
}

/**
 * True if the request's Origin is in the trusted-origin allowlist
 * (exact match or suffix match for `*.flatwrite.md` subdomains).
 * Mirrors the MCP Worker's isTrustedOrigin() implementation.
 */
function isTrustedOrigin(origin) {
  if (!origin) return false;
  if (TRUSTED_ORIGINS.has(origin)) return true;
  // Suffix match: https://anything.flatwrite.md
  if (/^https:\/\/[a-z0-9-]+\.flatwrite\.md$/i.test(origin)) return true;
  return false;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// Headers we forward verbatim from the upstream /api/render response.
const FORWARDED_RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
];

/**
 * Compute CORS headers for a request. Returns the CORS object to merge
 * in if the request's Origin is in the trusted-origin allowlist, or
 * `{}` (no CORS headers) otherwise. The browser blocks untrusted
 * responses from being read by JS when ACAO is absent.
 */
function corsFor(req) {
  const origin = req.headers.get('Origin');
  if (!origin) return {}; // no Origin = non-browser = no CORS needed
  if (!isTrustedOrigin(origin)) return {};
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

function pickForwardedHeaders(upstream) {
  const out = {};
  for (const name of FORWARDED_RATE_LIMIT_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

function isJsonContentType(ct) {
  if (!ct) return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

function isYamlContentType(ct) {
  if (!ct) return false;
  const base = ct.split(';')[0].trim().toLowerCase();
  return base === 'text/yaml' || base === 'application/x-yaml' || base === 'application/yaml';
}

function isBrowserRequest(req) {
  return Boolean(req.headers.get('Origin'));
}

/**
 * Authenticate a request. Two paths:
 *   - X-Mcp-Token — short-lived HMAC, accepted from any caller
 *     (browser or server). The Worker validates the signature
 *     against env.API_KEY.
 *   - X-Api-Key — long-lived key, accepted only from non-browser
 *     callers (no Origin header). Browser callers must use
 *     X-Mcp-Token.
 */
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
  // Browser-safe allow-headers. Note: X-Api-Key is intentionally
  // absent — long-lived keys are server-to-server only.
  const allowed = ['Content-Type', 'X-Mcp-Token', 'Accept', 'Mcp-Session-Id', 'Last-Event-Id'];
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
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

async function handleRender(req, env) {
  const method = req.method.toUpperCase();
  if (method !== 'POST') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
  }

  const cors = corsFor(req);
  const auth = await authenticateRequest(req, env);
  if (!auth.ok) return jsonResponse(auth.status, auth.body, cors);

  if (!env.INTERNAL_RENDER_KEY) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' }, cors);
  }

  const contentType = req.headers.get('Content-Type') || '';

  // Build the JSON body we will forward to /api/render
  let forwardBody;
  try {
    if (isJsonContentType(contentType)) {
      let parsed;
      try {
        parsed = await req.json();
      } catch (e) {
        return jsonResponse(400, {
          error: 'Invalid JSON',
          code: 'INVALID_JSON',
          detail: e.message,
        }, cors);
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed.markdown == null && parsed.markdownUrl == null)
      ) {
        return jsonResponse(400, {
          error: 'Either markdown or markdownUrl is required',
          code: 'MISSING_CONTENT',
        }, cors);
      }

      forwardBody = parsed;
    } else if (isYamlContentType(contentType)) {
      let doc;
      try {
        doc = yaml.load(await req.text());
      } catch (e) {
        return jsonResponse(400, {
          error: 'Invalid YAML',
          code: 'INVALID_YAML',
          detail: e.message,
        }, cors);
      }

      if (!doc || typeof doc !== 'object') {
        return jsonResponse(400, {
          error: 'YAML must be an object with a `url` field',
          code: 'INVALID_YAML',
        }, cors);
      }

      const { url: markdownUrl, ...designParams } = doc;
      if (!markdownUrl || typeof markdownUrl !== 'string') {
        return jsonResponse(400, {
          error: 'YAML must include a `url` field',
          code: 'MISSING_CONTENT',
        }, cors);
      }

      // Fetch markdown ourselves so the YAML path remains useful on its own
      let markdown;
      try {
        const mdResp = await fetch(markdownUrl);
        if (!mdResp.ok) throw new Error(`HTTP ${mdResp.status}`);
        markdown = await mdResp.text();
      } catch (e) {
        return jsonResponse(502, {
          error: 'Failed to fetch markdown source',
          code: 'UPSTREAM_FETCH_FAILED',
          detail: e.message,
        }, cors);
      }

      forwardBody = { markdown, markdownUrl, ...designParams };
    } else {
      return jsonResponse(415, {
        error: 'Content-Type must be application/json or text/yaml',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      }, cors);
    }
  } catch (e) {
    return jsonResponse(400, {
      error: 'Failed to read request body',
      code: 'BAD_REQUEST',
      detail: e.message,
    }, cors);
  }

  // Sign request with HMAC and delegate to /api/render. The Worker is
  // the single auth gate — we always sign with the internal HMAC key,
  // and the upstream never sees the caller's X-Api-Key or X-Mcp-Token.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sign(env.INTERNAL_RENDER_KEY, timestamp + '.POST./api/render');

  let upstream;
  try {
    upstream = await fetch('https://flatwrite.md/api/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Render-Timestamp': String(timestamp),
        'X-Render-Signature': signature,
      },
      body: JSON.stringify(forwardBody),
    });
  } catch (e) {
    return jsonResponse(502, {
      error: 'Failed to reach upstream render service',
      code: 'UPSTREAM_UNREACHABLE',
      detail: e.message,
    }, cors);
  }

  const forwardedHeaders = pickForwardedHeaders(upstream);

  // Try to parse upstream as JSON (success body or structured error)
  let parsed;
  const rawText = await upstream.text();
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return jsonResponse(
      upstream.status || 500,
      {
        error: 'Render failed',
        code: 'RENDER_FAILED',
        detail: rawText.slice(0, 500),
      },
      cors,
      forwardedHeaders,
    );
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed && !('code' in parsed)) {
    parsed.code = inferCodeFromStatus(upstream.status);
  }

  return jsonResponse(upstream.status, parsed, cors, forwardedHeaders);
}

async function handleMintToken(req, env) {
  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'OPTIONS') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
  }

  if (!env.API_KEY) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' });
  }

  // Origin check — only browser-side callers from approved hosts.
  // Non-browser clients (curl, MCP server) should use the long-lived key.
  const cors = corsFor(req);
  const origin = req.headers.get('Origin');
  if (!origin || !isTrustedOrigin(origin)) {
    return jsonResponse(
      403,
      { error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' },
      cors,
    );
  }

  // Rate-limit token minting per IP to prevent exhaustion attacks.
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (isTokenRateLimited(ip)) {
    return jsonResponse(
      429,
      { error: 'Rate limit exceeded', code: 'RATE_LIMIT' },
      cors,
    );
  }

  const { token, exp } = await mintToken(env.API_KEY, TOKEN_TTL_SECONDS, 'mcp');
  return jsonResponse(200, { token, expiresAt: exp, scope: 'mcp' }, cors);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // CORS preflight — only emit headers for trusted origins, and
    // never advertise X-Api-Key to browsers.
    if (method === 'OPTIONS') {
      const cors = corsFor(req);
      const requested = req.headers.get('Access-Control-Request-Headers');
      return new Response(null, { status: 204, headers: preflightHeaders(cors, requested) });
    }

    if (url.pathname === '/mcp-token') {
      return handleMintToken(req, env);
    }

    if (url.pathname === '/render' || url.pathname === '/' || url.pathname === '') {
      return handleRender(req, env);
    }

    return jsonResponse(404, { error: 'Not Found', code: 'NOT_FOUND' });
  },
};

function inferCodeFromStatus(status) {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 405) return 'METHOD_NOT_ALLOWED';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 502) return 'UPSTREAM_FETCH_FAILED';
  return 'RENDER_FAILED';
}
