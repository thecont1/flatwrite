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

// api/import-url.js — canonical /api/import-url handler
//
// Thin orchestration layer in front of Cloudflare's `markdown.new` service:
// validates the target URL, forwards it to markdown.new for conversion
// (auto / ai / browser pipeline), extracts a best-effort title + metadata
// from the returned markdown, and hands back a document shape the editor
// can drop straight into `setEditorContent()`.
//
// Uses only standard Node.js http.ServerResponse methods so it works both
// in Vercel's runtime and the custom server (index.js) — mirrors api/render.js.
'use strict';
const dns = require('dns').promises;
const net = require('net');
const { readBody } = require('../core/io');
const { createRateLimiter } = require('../core/rate-limit');

const MARKDOWN_NEW_URL = 'https://markdown.new/';
const MAX_REQUEST_BYTES = 8 * 1024; // request body is just { url, method, retain_images }
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024; // 4 MB cap on returned markdown
const UPSTREAM_TIMEOUT_MS = 25_000; // ai/browser modes are slower than a plain fetch
const VALID_METHODS = new Set(['auto', 'ai', 'browser']);

// 20 requests per minute per caller IP — import is heavier than a render call.
const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Best-effort private/reserved IP check. Covers RFC1918, loopback,
 * link-local, and the common IPv6 equivalents. Not exhaustive (e.g. does
 * not special-case every documented/benchmarking range) but blocks the
 * ranges that matter for SSRF defense-in-depth.
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return true; // malformed → fail closed
    if (parts[0] === 0) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unrecognized shape → fail closed
}

/**
 * Validate the URL the user wants imported. Rejects non-http(s) protocols,
 * localhost, and private/reserved network targets (including a DNS-rebinding
 * guard that resolves hostnames before allowing them through). markdown.new
 * itself performs the actual fetch of the target page, but we still refuse
 * to forward obviously unsafe targets.
 */
async function validateImportUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'URL is required' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must be http or https' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0') {
    return { ok: false, error: 'Localhost URLs are not allowed' };
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { ok: false, error: 'Private network addresses are not allowed' };
    }
    return { ok: true, url: parsed };
  }

  // DNS-rebinding guard: resolve the hostname and reject if it points at a
  // private/reserved address, even though markdown.new does the real fetch.
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) {
      return { ok: false, error: 'URL resolves to a private network address' };
    }
  } catch {
    return { ok: false, error: 'Could not resolve host' };
  }

  return { ok: true, url: parsed };
}

/**
 * Conservative YAML-frontmatter parser. Only handles the flat
 * `key: value` shape markdown.new / typical static-site generators emit —
 * no nested structures, no multi-line scalars. Good enough to pull out
 * title/description/image without pulling in a YAML dependency.
 */
function parseFrontmatter(markdown) {
  if (typeof markdown !== 'string') return { frontmatter: null, body: markdown };
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: markdown };

  const raw = match[1];
  const body = markdown.slice(match[0].length);
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[m[1].trim().toLowerCase()] = value;
  }
  return { frontmatter, body };
}

/**
 * Best-effort title extraction, in priority order:
 *   1. frontmatter `title`
 *   2. first Markdown H1 (`# Heading`)
 *   3. source hostname
 *   4. source URL as a last resort
 */
function extractTitle(markdown, frontmatter, sourceUrl) {
  if (frontmatter && frontmatter.title) return frontmatter.title;

  const bodyForH1 = typeof markdown === 'string' ? markdown : '';
  const h1 = bodyForH1.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1 && h1[1]) return h1[1].trim();

  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

function parseTokenCount(headerValue) {
  if (!headerValue) return null;
  const n = parseInt(headerValue, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = async function handleImportUrl(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'POST only' });
  }

  const ip = getClientIp(req);
  const { allowed, remaining, resetMs } = limiter.check(ip);
  if (!allowed) {
    const retryAfter = Math.ceil(resetMs / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Limit', '20');
    res.setHeader('X-RateLimit-Remaining', '0');
    return json(res, 429, { ok: false, error: 'Rate limit exceeded', retryAfter });
  }
  res.setHeader('X-RateLimit-Limit', '20');
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  let body;
  try {
    body = await readBody(req, MAX_REQUEST_BYTES);
  } catch (e) {
    const status = e.message === 'Payload too large' ? 413 : 400;
    const error = e.message === 'Payload too large' ? 'Payload too large' : 'Failed to read request body';
    return json(res, status, { ok: false, error });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid JSON' });
  }

  const rawUrl = parsed && parsed.url;
  const method = VALID_METHODS.has(parsed && parsed.method) ? parsed.method : 'auto';
  const retainImages = typeof (parsed && parsed.retain_images) === 'boolean' ? parsed.retain_images : true;

  const validated = await validateImportUrl(rawUrl);
  if (!validated.ok) {
    return json(res, 400, { ok: false, error: validated.error });
  }
  const sourceUrl = validated.url.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(MARKDOWN_NEW_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/markdown, text/plain;q=0.9, */*;q=0.1',
      },
      body: JSON.stringify({ url: sourceUrl, method, retain_images: retainImages }),
    });
  } catch (err) {
    clearTimeout(timeout);
    const timedOut = err && err.name === 'AbortError';
    return json(res, 504, {
      ok: false,
      error: timedOut ? 'Import timed out. Try again, or retry with browser mode for JS-heavy sites.' : 'Could not reach the import service.',
    });
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    // Never forward the raw upstream body to the client — just the status.
    const status = upstream.status === 429 ? 429 : 502;
    return json(res, status, {
      ok: false,
      error: status === 429
        ? 'Import service is rate-limited right now. Please try again shortly.'
        : `Import failed (upstream returned ${upstream.status}).`,
    });
  }

  let rawText;
  try {
    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_MARKDOWN_BYTES) {
      return json(res, 502, { ok: false, error: 'Imported content was too large.' });
    }
    rawText = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } catch {
    return json(res, 502, { ok: false, error: 'Failed to read imported content.' });
  }

  if (!rawText || !rawText.trim()) {
    return json(res, 502, { ok: false, error: 'The import service returned no content.' });
  }

  const contentType = upstream.headers.get('content-type') || '';

  // markdown.new's real-world response is a JSON envelope
  // ({ success, url, title, content, tokens, ... }), not a bare
  // text/markdown body, regardless of what Accept header we send. Detect
  // that shape and unwrap it; otherwise treat the body as markdown
  // directly (covers a future/alternate deployment that really does
  // stream text/markdown).
  let markdown = rawText;
  let upstreamTitle = null;
  let upstreamTokens = null;
  if (contentType.includes('application/json') || /^\s*\{/.test(rawText)) {
    try {
      const envelope = JSON.parse(rawText);
      if (envelope && envelope.success === false) {
        return json(res, 502, { ok: false, error: 'The import service could not convert this page.' });
      }
      if (envelope && typeof envelope.content === 'string') {
        markdown = envelope.content;
        if (typeof envelope.title === 'string' && envelope.title.trim()) upstreamTitle = envelope.title.trim();
        if (Number.isFinite(envelope.tokens)) upstreamTokens = envelope.tokens;
      }
    } catch {
      // Not actually JSON despite the content-type/leading-brace hint —
      // fall through and use rawText as markdown.
    }
  }

  if (!markdown || !markdown.trim()) {
    return json(res, 502, { ok: false, error: 'The import service returned no usable content.' });
  }

  const tokenCount = parseTokenCount(upstream.headers.get('x-markdown-tokens')) ?? upstreamTokens;

  const { frontmatter, body: bodyWithoutFrontmatter } = parseFrontmatter(markdown);
  const title = upstreamTitle || extractTitle(bodyWithoutFrontmatter, frontmatter, sourceUrl);

  const importMeta = {
    importer: 'markdown.new',
    tokenCount,
    method,
    retainImages,
    contentType,
    fetchedAt: new Date().toISOString(),
  };
  if (frontmatter && frontmatter.description) importMeta.description = frontmatter.description;
  if (frontmatter && frontmatter.image) importMeta.image = frontmatter.image;

  return json(res, 200, {
    ok: true,
    document: {
      content: markdown,
      sourceUrl,
      title,
      importMeta,
    },
  });
};
