import yaml from 'js-yaml';

/**
 * Cloudflare Worker: render.flatwrite.md
 *
 * JSON-first façade in front of the canonical /api/render handler on
 * flatwrite.md. Optional YAML mode preserved for backward compatibility.
 *
 *   - POST application/json  → forwards body to /api/render, returns { head, body }
 *   - POST text/yaml         → parses YAML, fetches `url`, builds JSON, forwards
 *   - OPTIONS                → 204 with CORS headers
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  'Access-Control-Max-Age': '600',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// Headers we forward verbatim from the upstream /api/render response.
const FORWARDED_RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
];

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extraHeaders },
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
async function sign(secret, timestamp, method, path) {
  const payload = timestamp + '.' + method + '.' + path;
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

function isJsonContentType(ct) {
  if (!ct) return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

function isYamlContentType(ct) {
  if (!ct) return false;
  const base = ct.split(';')[0].trim().toLowerCase();
  return base === 'text/yaml' || base === 'application/x-yaml' || base === 'application/yaml';
}

export default {
  async fetch(req, env) {
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method !== 'POST') {
      return jsonResponse(405, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
    }

    // Public auth: X-Api-Key
    const apiKey = req.headers.get('X-Api-Key');
    if (!env.API_KEY || apiKey !== env.API_KEY) {
      return jsonResponse(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

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

    // Sign request with HMAC and delegate to /api/render
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(env.INTERNAL_RENDER_KEY, timestamp, 'POST', '/api/render');

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