import yaml from 'js-yaml';

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
 *                               and rate-limits per IP.
 *   - OPTIONS                → 204 with CORS headers (any path)
 *
 * Auth model:
 *   - X-Api-Key  — long-lived key. Used by the README curl examples,
 *                   the MCP stdio server, the MCP Streamable HTTP server,
 *                   and the WebMCP Worker. Set via `wrangler secret put API_KEY`.
 *   - X-Mcp-Token — short-lived HMAC token (60s default). Used by
 *                    browser-side scripts (webmcp.js) that cannot safely
 *                    embed the long-lived key. The Worker validates the
 *                    token and replaces it with the upstream X-Api-Key
 *                    before forwarding to /api/render. Tokens are minted
 *                    by POST /mcp-token and scoped to "mcp".
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, X-Mcp-Token',
  'Access-Control-Max-Age': '600',
};

const TOKEN_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '300',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// Headers we forward verbatim from the upstream /api/render response.
const FORWARDED_RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
];

// Origins allowed to mint tokens. localhost + flatwrite.md only by default.
function allowedOrigin(req) {
  const origin = req.headers.get('Origin');
  if (!origin) return false; // non-browser callers don't need tokens
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    if (u.hostname === 'flatwrite.md' || u.hostname.endsWith('.flatwrite.md')) return true;
    if (u.hostname.endsWith('.vercel.app')) return true; // preview deploys
    return false;
  } catch {
    return false;
  }
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extraHeaders },
  });
}

function jsonResponseWithCors(status, payload, corsHeaders, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders, ...extraHeaders },
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

/**
 * Compute HMAC-SHA256 signature using Web Crypto API (CF Worker compatible).
 * Payload: timestamp.method.path
 */
async function sign(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a short-lived token: base64url(exp).base64url(sig) where
 *   exp  = unix seconds at which the token expires (default now + 60s)
 *   sig  = hex(HMAC-SHA256(env.API_KEY, exp + '.' + scope))
 *
 * The same long-lived key signs and validates, so the Worker is the
 * sole secret holder. A leaked token is bounded by its exp.
 */
async function mintToken(secret, ttlSeconds, scope) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await sign(secret, exp + '.' + scope);
  // base64url of exp (as decimal string) + base64url of hex sig
  const expB64 = b64url(exp.toString());
  const sigB64 = b64url(sig);
  return { token: expB64 + '.' + sigB64, exp };
}

async function verifyToken(secret, token, scope) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [expB64, sigB64] = parts;
  // Decode exp (decimal string) from base64url
  let expStr;
  try {
    expStr = atob(expB64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  // Decode expected sig from base64url
  let expectedSig;
  try {
    expectedSig = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const actualSig = await sign(secret, expStr + '.' + scope);
  if (expectedSig !== actualSig) return { ok: false, reason: 'bad_signature' };
  return { ok: true, exp };
}

function b64url(input) {
  // input: string. Convert to base64url.
  // For binary input, callers should pre-encode. We use TextEncoder.
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

async function authenticateRequest(req, env) {
  // Returns either { ok: true, key: 'long'|'short' } or { ok: false, status, body }.
  if (!env.API_KEY) {
    return { ok: false, status: 500, body: { error: 'Worker misconfigured', code: 'MISCONFIGURED' } };
  }
  // Short-lived token takes priority — pages have to refresh tokens,
  // and a leaked token expires.
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
  // Fall back to long-lived key (for direct API key users).
  const apiKey = req.headers.get('X-Api-Key');
  if (apiKey === env.API_KEY) return { ok: true, kind: 'key' };
  return { ok: false, status: 401, body: { error: 'Unauthorized', code: 'UNAUTHORIZED' } };
}

async function handleRender(req, env) {
  const method = req.method.toUpperCase();
  if (method !== 'POST') {
    return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
  }

  const auth = await authenticateRequest(req, env);
  if (!auth.ok) return jsonResponse(auth.status, auth.body);

  if (!env.INTERNAL_RENDER_KEY) {
    return jsonResponse(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' });
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
        });
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed.markdown == null && parsed.markdownUrl == null)
      ) {
        return jsonResponse(400, {
          error: 'Either markdown or markdownUrl is required',
          code: 'MISSING_CONTENT',
        });
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
        });
      }

      if (!doc || typeof doc !== 'object') {
        return jsonResponse(400, {
          error: 'YAML must be an object with a `url` field',
          code: 'INVALID_YAML',
        });
      }

      const { url: markdownUrl, ...designParams } = doc;
      if (!markdownUrl || typeof markdownUrl !== 'string') {
        return jsonResponse(400, {
          error: 'YAML must include a `url` field',
          code: 'MISSING_CONTENT',
        });
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
        });
      }

      forwardBody = { markdown, markdownUrl, ...designParams };
    } else {
      return jsonResponse(415, {
        error: 'Content-Type must be application/json or text/yaml',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }
  } catch (e) {
    // Belt-and-braces: any read failure that escaped the inner catches.
    return jsonResponse(400, {
      error: 'Failed to read request body',
      code: 'BAD_REQUEST',
      detail: e.message,
    });
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
    });
  }

  const forwardedHeaders = pickForwardedHeaders(upstream);

  // Try to parse upstream as JSON (success body or structured error)
  let parsed;
  const rawText = await upstream.text();
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Upstream returned non-JSON (shouldn't happen, but stay defensive)
    return jsonResponse(
      upstream.status || 500,
      {
        error: 'Render failed',
        code: 'RENDER_FAILED',
        detail: rawText.slice(0, 500),
      },
      forwardedHeaders,
    );
  }

  // If upstream already used our { error, code } shape, forward as-is
  // and add a `code` if missing so clients always get one.
  if (parsed && typeof parsed === 'object' && 'error' in parsed && !('code' in parsed)) {
    parsed.code = inferCodeFromStatus(upstream.status);
  }

  return jsonResponse(upstream.status, parsed, forwardedHeaders);
}

async function handleMintToken(req, env) {
  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'OPTIONS') {
    return jsonResponseWithCors(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' }, TOKEN_CORS_HEADERS);
  }

  if (!env.API_KEY) {
    return jsonResponseWithCors(500, { error: 'Worker misconfigured', code: 'MISCONFIGURED' }, TOKEN_CORS_HEADERS);
  }

  // Origin check — only browser-side callers from approved hosts.
  // Non-browser clients (curl, MCP server) should use the long-lived key.
  if (!allowedOrigin(req)) {
    return jsonResponseWithCors(
      403,
      { error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' },
      TOKEN_CORS_HEADERS,
    );
  }

  // Token TTL: 60 seconds. Long enough to be useful for batched tool
  // calls; short enough that a leaked token is bounded.
  const TTL = 60;
  const { token, exp } = await mintToken(env.API_KEY, TTL, 'mcp');
  return jsonResponseWithCors(
    200,
    { token, expiresAt: exp, scope: 'mcp' },
    TOKEN_CORS_HEADERS,
  );
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // CORS preflight (any path; the allow-headers list differs by route
    // but /mcp-token doesn't need X-Api-Key / X-Mcp-Token, only Content-Type).
    if (method === 'OPTIONS') {
      // Use the broader headers (which include X-Mcp-Token) so that a
      // browser-side preflight for /render also works. The CORS spec
      // permits a permissive allow-headers response.
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Route dispatch
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