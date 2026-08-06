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
// Fetches a public document URL, then converts the downloaded bytes to
// Markdown locally using the FlatWrite extract service (AnyDoc). Nothing
// is sent to a third-party conversion service; the only network call is
// the fetch of the user-supplied URL itself.
//
// Uses only standard Node.js http.ServerResponse methods so it works both
// in Vercel's runtime and the custom server (index.js) — mirrors api/render.js.
'use strict';
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { readBody } = require('../core/io');
const { createRateLimiter } = require('../core/rate-limit');

const EXTRACT_SERVICE_URL = process.env.EXTRACT_SERVICE_URL || 'http://127.0.0.1:8000';
const INTERNAL_EXTRACT_KEY = process.env.INTERNAL_EXTRACT_KEY || '';
const MAX_REQUEST_BYTES = 8 * 1024; // request body is just { url, method, retain_images }
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // same cap as the extract service
const UPSTREAM_TIMEOUT_MS = 60_000;
const VALID_METHODS = new Set(['auto', 'ai', 'browser']);

// 20 requests per minute per caller IP — import is heavier than a render call.
const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Only trust X-Forwarded-For when explicitly configured — Vercel and most
// PaaS proxies set it, but a direct connection lets clients spoof it freely.
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function getClientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
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
 * guard that resolves hostnames before allowing them through). The fetch is
 * done by this handler; we refuse to download obviously unsafe targets.
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

  // DNS-rebinding guard: resolve the hostname and reject if *any* resolved
  // address (IPv4 or IPv6) is private/reserved.
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length) {
      return { ok: false, error: 'Could not resolve host' };
    }
    for (const entry of addresses) {
      if (isPrivateIp(entry.address)) {
        return { ok: false, error: 'URL resolves to a private network address' };
      }
    }
  } catch {
    return { ok: false, error: 'Could not resolve host' };
  }

  return { ok: true, url: parsed };
}

/**
 * Conservative YAML-frontmatter parser. Only handles the flat
 * `key: value` shape typical static-site generators emit — no nested
 * structures, no multi-line scalars. Good enough to pull out
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

// Map common MIME types to an AnyDoc-friendly filename extension. If we can't
// pick one, the URL path should carry the extension; otherwise we reject.
const MIME_TO_EXTENSION = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': '.ppsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'text/csv': '.csv',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf',
  'application/epub+zip': '.epub',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
};

function guessFilename(parsedUrl, contentType) {
  const fromPath = parsedUrl.pathname.split('/').pop() || '';
  if (fromPath && fromPath.includes('.')) {
    return decodeURIComponent(fromPath);
  }
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXTENSION[mime];
  if (ext) {
    return 'document' + ext;
  }
  return null;
}

function htmlContentType(contentType) {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  return mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'application/html';
}

async function fetchDocumentBytes(url, signal) {
  const upstream = await fetch(url, {
    signal,
    headers: {
      'Accept': 'application/pdf, application/msword, application/vnd.openxmlformats-officedocument.*, application/vnd.oasis.opendocument.*, text/csv, application/rtf, application/epub+zip, */*;q=0.1',
      'User-Agent': 'FlatWrite/1.0 (document importer)',
    },
  });

  if (!upstream.ok) {
    const err = new Error(`Source URL returned ${upstream.status}`);
    err.status = upstream.status === 404 ? 404 : 502;
    throw err;
  }

  const contentLength = parseInt(upstream.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
    const err = new Error('Document is too large (25 MB max)');
    err.status = 413;
    throw err;
  }

  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      throw Object.assign(new Error('Document is too large (25 MB max)'), { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }

  const buffer = Buffer.concat(chunks);
  return {
    buffer,
    contentType: upstream.headers.get('content-type') || '',
  };
}

function signExtractRequest(secret, timestamp) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.POST./extract`)
    .digest('hex');
}

async function callExtractService(buffer, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);

  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {};
  if (INTERNAL_EXTRACT_KEY) {
    headers['X-Extract-Timestamp'] = String(timestamp);
    headers['X-Extract-Signature'] = signExtractRequest(INTERNAL_EXTRACT_KEY, timestamp);
  }

  const res = await fetch(`${EXTRACT_SERVICE_URL}/extract`, {
    method: 'POST',
    headers,
    body: fd,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const code = data && data.detail && data.detail.code;
    const msg = (data && data.detail && data.detail.error) || (data && data.error) || `Extract service returned ${res.status}`;
    const err = new Error(msg);
    err.status = code === 'UNSUPPORTED_FILE_TYPE' ? 415 : (res.status >= 500 && res.status < 600 ? 502 : res.status);
    throw err;
  }

  if (!data || typeof data.markdown !== 'string') {
    throw Object.assign(new Error('Extract service returned malformed response'), { status: 502 });
  }

  return data;
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

  let buffer;
  let contentType;
  try {
    ({ buffer, contentType } = await fetchDocumentBytes(sourceUrl, controller.signal));
  } catch (err) {
    clearTimeout(timeout);
    const timedOut = err && err.name === 'AbortError';
    const status = err.status || (timedOut ? 504 : 502);
    const error = timedOut
      ? 'Import timed out. The document may be too large or the server too slow.'
      : (err.message || 'Could not fetch the URL.');
    return json(res, status, { ok: false, error });
  }
  clearTimeout(timeout);

  if (!buffer || buffer.length === 0) {
    return json(res, 502, { ok: false, error: 'The URL returned an empty document.' });
  }

  if (htmlContentType(contentType)) {
    return json(res, 415, {
      ok: false,
      error: 'This URL points to an HTML page. Only document files (PDF, DOCX, PPTX, XLSX, etc.) can be imported locally with AnyDoc.',
    });
  }

  const filename = guessFilename(validated.url, contentType);
  if (!filename) {
    return json(res, 400, {
      ok: false,
      error: 'Could not determine a document filename or supported MIME type from the URL.',
    });
  }

  let extracted;
  try {
    extracted = await callExtractService(buffer, filename);
  } catch (err) {
    return json(res, err.status || 502, { ok: false, error: err.message || 'Local conversion failed.' });
  }

  const markdown = extracted.markdown;
  if (!markdown || !markdown.trim()) {
    return json(res, 502, { ok: false, error: 'The document was empty after conversion.' });
  }

  const { frontmatter, body: mdBody } = parseFrontmatter(markdown);
  const title = extractTitle(mdBody, frontmatter, sourceUrl);

  return json(res, 200, {
    ok: true,
    document: {
      content: markdown,
      title,
      sourceUrl,
      importMeta: {
        importer: 'anydoc',
        tokenCount: null,
        method,
        retainImages,
        contentType,
        fetchedAt: new Date().toISOString(),
        filename,
      },
    },
  });
};
