// api/render.js — canonical /api/render handler
// Uses only standard Node.js http.ServerResponse methods so it works
// both in Vercel's runtime and the custom server (index.js).
'use strict';
const { renderToDocument } = require('../core/render');
const { verify } = require('../core/auth');
const { readBody } = require('../core/io');
const { createRateLimiter } = require('../core/rate-limit');

const MAX_BYTES = 512 * 1024;
const MAX_URL_BYTES = 1 * 1024 * 1024;

// 60 requests per minute per caller IP
const limiter = createRateLimiter({ windowMs: 60_000, max: 60 });

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}

const ALLOWED_MARKDOWN_HOSTS = new Set([
  'raw.githubusercontent.com',
  'raw.gitlab.com',
  'bitbucket.org',
]);

/**
 * Fetch markdown from a remote URL. Only http/https are allowed and the host
 * must be in the allowlist. Enforces a byte cap and a 10-second timeout.
 */
async function fetchMarkdownUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'Invalid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must be http or https' };
  }
  if (!ALLOWED_MARKDOWN_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: 'Disallowed markdownUrl host' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'text/markdown,text/plain,*/*' },
      redirect: 'follow',
    });
    if (!resp.ok) return { ok: false, error: `Upstream returned ${resp.status}` };

    const contentType = resp.headers.get('content-type') || '';
    if (contentType && !contentType.match(/text\/(markdown|plain)|application\/octet-stream/)) {
      // Allow unknown or binary-looking content only if the client explicitly requested it; otherwise
      // this is a safety net against rendering HTML or other non-markdown payloads.
    }

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_URL_BYTES) return { ok: false, error: 'Markdown URL payload too large' };
    return { ok: true, markdown: new TextDecoder('utf-8', { fatal: false }).decode(buffer) };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Fetch timeout' : 'Failed to fetch URL' };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handleRender(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'POST only' });
  }

  /* HMAC auth: constant-time verify + 5-min replay window */
  const secret = process.env.INTERNAL_RENDER_KEY;
  if (!secret) return json(res, 500, { error: 'Server misconfigured' });

  const ts   = req.headers['x-render-timestamp'];
  const sig  = req.headers['x-render-signature'];
  const auth = verify(secret, 'POST', '/api/render', ts, sig);
  if (!auth.ok) return json(res, 401, { error: 'Unauthorized' });

  /* Rate limit: sliding window per IP */
  const ip = getClientIp(req);
  const { allowed, remaining, resetMs } = limiter.check(ip);
  if (!allowed) {
    const retryAfter = Math.ceil(resetMs / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Limit', '60');
    res.setHeader('X-RateLimit-Remaining', '0');
    return json(res, 429, { error: 'Rate limit exceeded', retryAfter });
  }
  res.setHeader('X-RateLimit-Limit', '60');
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  /* Read body with size limit */
  let body;
  try {
    body = await readBody(req, MAX_BYTES);
  } catch (e) {
    const status = e.message === 'Payload too large' ? 413 : 400;
    const error  = e.message === 'Payload too large' ? 'Payload too large' : 'Failed to read request body';
    return json(res, status, { error });
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { markdown, markdownUrl, ...frontmatter } = parsed;

  let renderMarkdown = markdown;
  if (markdownUrl && !renderMarkdown) {
    const fetched = await fetchMarkdownUrl(markdownUrl);
    if (!fetched.ok) {
      return json(res, 502, { error: `Failed to fetch markdownUrl: ${fetched.error}` });
    }
    renderMarkdown = fetched.markdown;
  }

  if (typeof renderMarkdown !== 'string' || !renderMarkdown) {
    return json(res, 400, { error: 'Either markdown or markdownUrl is required' });
  }

  let baseUrl;
  if (markdownUrl) {
    try {
      const parsed = new URL(markdownUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        baseUrl = markdownUrl;
      }
    } catch {}
  }

  try {
    const { head, body } = await renderToDocument(renderMarkdown, frontmatter, { baseUrl });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.statusCode = 200;
    res.end(JSON.stringify({ head, body }));
  } catch (err) {
    console.error('[render]', err);
    return json(res, 500, { error: 'Render failed: ' + err.message });
  }
};
