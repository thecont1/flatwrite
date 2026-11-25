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

// api/fetch-document.js — canonical /api/fetch-document handler
//
// Fetches a public document URL and returns the raw bytes to the browser.
// Conversion intentionally does not happen here: the browser runs the shared
// extract-core/WASM pipeline after downloading this response. The only network
// call made by this handler is the fetch of the user-supplied URL itself.
//
// Uses only standard Node.js http.ServerResponse methods so it works both
// in Vercel's runtime and the custom server (index.js) — mirrors api/render.js.
'use strict';
const dns = require('dns');
const dnsPromises = dns.promises;
const net = require('net');
const { readBody } = require('../core/io');
const { createRateLimiter } = require('../core/rate-limit');
// extract-core.js is an ES module while this canonical handler is CommonJS.
// `require()` of a synchronous ESM module is supported by current Node.js and
// Bun, and Wrangler/esbuild inlines the same static require graph for workerd.
// Keeping this import (rather than copying the table) preserves one source of
// truth for the allowed extensions.
const { EXTENSIONS } = require('../public/extract-core.js');

const MAX_REQUEST_BYTES = 8 * 1024; // request body is just { url }
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // same cap as browser conversion
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
 * Validate the URL the user wants fetched. Rejects non-http(s) protocols,
 * localhost, and private/reserved network targets (including a DNS-rebinding
 * guard that resolves hostnames before allowing them through). Every redirect
 * hop goes through this same validation before it is fetched.
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

  // WHATWG URL keeps IPv6 literals bracketed; net.isIP expects the bare form.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
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
  //
  // Two resolution paths, in order:
  //   1. dns.lookup(hostname, { all: true }) — Node.js (Vercel, index.js,
  //      the dev server). Follows the OS resolver, IPv4+IPv6 in one call.
  //   2. dns.promises.resolve4/resolve6 — Cloudflare Workers, where
  //      node:dns.lookup is not implemented (throws "Not implemented") but
  //      resolve4/resolve6 work and each query counts as a subrequest.
  // Both are awaited so the guard keeps working on every runtime the
  // canonical handler runs on; total cost is one lookup either way.
  try {
    let addresses;
    try {
      addresses = await dnsPromises.lookup(hostname, { all: true });
    } catch (lookupErr) {
      if (typeof lookupErr === 'object' && lookupErr !== null &&
          (lookupErr.code === 'ERR_NOT_IMPLEMENTED' /* Node semver */ ||
           /not implemented/i.test(String(lookupErr.message || lookupErr)))) {
        const [v4, v6] = await Promise.all([
          dnsPromises.resolve4(hostname).catch(() => []),
          dnsPromises.resolve6(hostname).catch(() => []),
        ]);
        addresses = [
          ...v4.map((address) => ({ address, family: 4 })),
          ...v6.map((address) => ({ address, family: 6 })),
        ];
      } else {
        throw lookupErr;
      }
    }
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

// Map common MIME types to a browser-conversion-friendly filename extension.
// If we can't pick one, the URL path should carry the extension; otherwise we reject.
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
    try {
      return decodeURIComponent(fromPath);
    } catch {
      return fromPath;
    }
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

function responseHeader(response, name) {
  if (!response || !response.headers) return null;
  if (typeof response.headers.get === 'function') return response.headers.get(name);
  const lower = name.toLowerCase();
  for (const key of Object.keys(response.headers)) {
    if (key.toLowerCase() === lower) return response.headers[key];
  }
  return null;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBodyWithCap(upstream) {
  if (!upstream.body || typeof upstream.body.getReader !== 'function') {
    throw httpError(502, 'Upstream response body could not be read.');
  }

  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
      } catch {
        // Cancellation is best-effort; the 413 is the meaningful result.
      }
      throw httpError(413, 'Document is too large (25 MB max)');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a document with manual redirect handling. Unlike the old import-url
 * implementation (which relied on fetch's automatic redirect following), every
 * redirect target is resolved against the current URL and passed through the
 * complete SSRF validator before the next request. This closes the
 * public-URL → redirect → private-address bypass.
 */
async function fetchDocumentBytes(validatedInitialUrl, signal) {
  let currentUrl = validatedInitialUrl;
  let redirectHops = 0;

  for (;;) {
    const upstream = await fetch(currentUrl.toString(), {
      signal,
      redirect: 'manual',
      headers: {
        'Accept': 'application/pdf, application/msword, application/vnd.openxmlformats-officedocument.*, application/vnd.oasis.opendocument.*, text/csv, application/rtf, application/epub+zip, */*;q=0.1',
        'User-Agent': 'FlatWrite/1.0 (document importer)',
      },
    });

    if (REDIRECT_STATUSES.has(upstream.status)) {
      const location = responseHeader(upstream, 'location');
      if (!location) {
        throw httpError(502, 'Source URL returned a redirect without a Location header');
      }
      if (redirectHops >= MAX_REDIRECT_HOPS) {
        throw httpError(502, 'Source URL returned too many redirects');
      }
      redirectHops += 1;

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw httpError(502, 'Source URL returned an invalid redirect');
      }
      const validated = await validateImportUrl(nextUrl);
      if (!validated.ok) {
        throw httpError(400, validated.error);
      }
      currentUrl = validated.url;

      // Redirect responses normally have no meaningful body, but cancelling is
      // important for unusual upstreams and keeps the socket reusable in Node.
      if (upstream.body && typeof upstream.body.cancel === 'function') {
        try {
          const cancelled = upstream.body.cancel();
          if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
        } catch {
          // Best-effort only.
        }
      }
      continue;
    }

    if (!upstream.ok) {
      throw httpError(
        upstream.status === 404 ? 404 : 502,
        `Source URL returned ${upstream.status}`,
      );
    }

    const contentLength = parseInt(responseHeader(upstream, 'content-length') || '', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
      throw httpError(413, 'Document is too large (25 MB max)');
    }

    const buffer = await readBodyWithCap(upstream);
    return {
      buffer,
      contentType: responseHeader(upstream, 'content-type') || '',
      finalUrl: currentUrl.toString(),
      finalParsedUrl: currentUrl,
    };
  }
}

function filenameExtension(filename) {
  const base = String(filename || '').split('/').pop().split('\\').pop();
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return base.slice(dot).toLowerCase();
}

module.exports = async function handleFetchDocument(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'POST only' });
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

  const validated = await validateImportUrl(parsed && parsed.url);
  if (!validated.ok) {
    return json(res, 400, { ok: false, error: validated.error });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let fetched;
  try {
    fetched = await fetchDocumentBytes(validated.url, controller.signal);
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    const status = err.status || (timedOut ? 504 : 502);
    const error = timedOut
      ? 'Import timed out. The document may be too large or the server too slow.'
      : (err.message || 'Could not fetch the URL.');
    return json(res, status, { ok: false, error });
  } finally {
    clearTimeout(timeout);
  }

  const { buffer, contentType, finalUrl, finalParsedUrl } = fetched;
  if (!buffer || buffer.length === 0) {
    return json(res, 502, { ok: false, error: 'The URL returned an empty document.' });
  }

  if (htmlContentType(contentType)) {
    return json(res, 415, {
      ok: false,
      error: 'This URL points to an HTML page. Only document files (PDF, DOCX, PPTX, XLSX, etc.) can be imported locally with AnyDoc.',
    });
  }

  const filename = guessFilename(finalParsedUrl, contentType);
  if (!filename) {
    return json(res, 400, {
      ok: false,
      error: 'Could not determine a document filename or supported MIME type from the URL.',
    });
  }

  const ext = filenameExtension(filename);
  if (!ext || !Object.prototype.hasOwnProperty.call(EXTENSIONS, ext)) {
    return json(res, 415, {
      ok: false,
      error: `unsupported extension '${ext || ''}'`,
    });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Flatwrite-Filename', encodeURIComponent(filename));
  res.setHeader('X-Flatwrite-Source-Url', finalUrl);
  res.setHeader('X-Flatwrite-Source-Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
};
