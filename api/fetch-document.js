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
// The require is DEFERRED to first use rather than module evaluation:
// require(esm) needs Node >= 20.19 / 22.12 (declared in package.json
// engines), and loading it lazily means server.js/index.js can always load
// this handler and serve their other routes even on a runtime where the
// ESM require itself would fail. Wrangler/esbuild still statically resolves
// the require for the workerd bundle. Keeping the import (rather than
// copying the table) preserves one source of truth for allowed extensions.
let extractCoreCache = null;
function loadExtractCore() {
  if (!extractCoreCache) {
    extractCoreCache = require('../public/extract-core.js');
  }
  return extractCoreCache;
}

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

// Only trust X-Forwarded-For when the deployment is genuinely behind a
// proxy: explicit TRUST_PROXY configuration, or the Vercel platform itself
// (which always edge-proxies — there remoteAddress is never the real
// client, so failing closed would collapse every caller into one bucket).
// A direct connection lets clients spoof XFF freely, so it stays off
// everywhere else.
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'
  || process.env.VERCEL === '1';

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
function isPrivateIpV4Parts(parts) {
  if (parts.some((p) => !Number.isFinite(p))) return true; // malformed → fail closed
  if (parts[0] === 0) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true; // 192.0.0.0/24 protocol assignments
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true; // 192.0.2.0/24 documentation
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true; // 198.18.0.0/15 benchmarking
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true; // documentation
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true; // documentation
  if (parts[0] >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Expand an IPv6 address into its eight 16-bit groups as numbers.
 * Handles :: compression and an embedded dotted-decimal IPv4 tail
 * (e.g. ::ffff:127.0.0.1). Returns null when the shape is invalid.
 */
function ipv6Groups(ip) {
  let input = ip.toLowerCase();
  let tailGroups = [];
  const dotIndex = input.indexOf('.');
  if (dotIndex !== -1) {
    // Embedded IPv4 tail counts as two groups.
    const lastColon = input.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = input.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
    tailGroups = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    input = input.slice(0, lastColon + 1).replace(/:$/, '');
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [];
  for (const part of left.concat(right)) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  if (halves.length === 2) {
    // "::" fills however many zero groups are missing.
    const missing = 8 - tailGroups.length - groups.length;
    if (missing < 0) return null;
    return left.map((p) => parseInt(p, 16))
      .concat(new Array(missing).fill(0))
      .concat(right.map((p) => parseInt(p, 16)))
      .concat(tailGroups);
  }
  if (groups.length + tailGroups.length !== 8) return null;
  return groups.concat(tailGroups);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    return isPrivateIpV4Parts(ip.split('.').map(Number));
  }
  if (net.isIPv6(ip)) {
    const groups = ipv6Groups(ip);
    if (!groups) return true; // malformed → fail closed
    const allZero = groups.every((g) => g === 0);
    if (allZero) return true; // :: unspecified
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
    // Link-local fe80::/10 — covers fe80 through febf numerically.
    if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true;
    // Unique local fc00::/7.
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    // Deprecated site-local fec0::/10 and multicast ff00::/8 — never
    // legitimate document-fetch targets.
    if (groups[0] >= 0xfec0 && groups[0] <= 0xfeff) return true;
    if ((groups[0] & 0xff00) === 0xff00) return true;
    // IPv4-mapped ::ffff:a.b.c.d — regardless of whether the source
    // spelled the tail dotted or as hex groups, apply the IPv4 rules
    // to the final 32 bits.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return isPrivateIpV4Parts([
        groups[6] >> 8, groups[6] & 0xff,
        groups[7] >> 8, groups[7] & 0xff,
      ]);
    }
    // IPv4-compatible ::a.b.c.d (::/96): network stacks route these to the
    // embedded IPv4 address — [::7f00:1] is loopback. Unspecified (::) and
    // loopback (::1) are already rejected above; everything else in this
    // space gets the IPv4 treatment.
    if (groups.slice(0, 6).every((g) => g === 0)) {
      return isPrivateIpV4Parts([
        groups[6] >> 8, groups[6] & 0xff,
        groups[7] >> 8, groups[7] & 0xff,
      ]);
    }
    // NAT64 64:ff9b::/96 embeds the IPv4 destination in the final 32 bits.
    if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
        groups.slice(2, 6).every((g) => g === 0)) {
      return isPrivateIpV4Parts([
        groups[6] >> 8, groups[6] & 0xff,
        groups[7] >> 8, groups[7] & 0xff,
      ]);
    }
    // 6to4 2002::/16 embeds the IPv4 destination in groups 1–2.
    if (groups[0] === 0x2002) {
      return isPrivateIpV4Parts([
        groups[1] >> 8, groups[1] & 0xff,
        groups[2] >> 8, groups[2] & 0xff,
      ]);
    }
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
  // address (IPv4 or IPv6) is private/reserved. The resolved set is returned
  // so the pre-fetch recheck can compare against it.
  let addresses;
  try {
    addresses = await resolveHostAddresses(hostname);
  } catch {
    return { ok: false, error: 'Could not resolve host' };
  }
  if (!addresses.length) {
    return { ok: false, error: 'Could not resolve host' };
  }
  for (const entry of addresses) {
    if (isPrivateIp(entry.address)) {
      return { ok: false, error: 'URL resolves to a private network address' };
    }
  }

  return { ok: true, url: parsed, addresses: addresses.map((entry) => entry.address) };
}

/**
 * Resolve a hostname with the best mechanism the runtime offers:
 *   1. dns.lookup(hostname, { all: true }) — Node.js (Vercel, index.js,
 *      the dev server). Follows the OS resolver, IPv4+IPv6 in one call.
 *   2. dns.promises.resolve4/resolve6 — Cloudflare Workers, where
 *      node:dns.lookup is not implemented (throws "Not implemented") but
 *      resolve4/resolve6 work and each query counts as a subrequest.
 */
async function resolveHostAddresses(hostname) {
  try {
    return await dnsPromises.lookup(hostname, { all: true });
  } catch (lookupErr) {
    if (typeof lookupErr === 'object' && lookupErr !== null &&
        (lookupErr.code === 'ERR_NOT_IMPLEMENTED' /* Node semver */ ||
         /not implemented/i.test(String(lookupErr.message || lookupErr)))) {
      const [v4, v6] = await Promise.all([
        dnsPromises.resolve4(hostname).catch(() => []),
        dnsPromises.resolve6(hostname).catch(() => []),
      ]);
      return [
        ...v4.map((address) => ({ address, family: 4 })),
        ...v6.map((address) => ({ address, family: 6 })),
      ];
    }
    throw lookupErr;
  }
}

/**
 * Cheap DNS-TOCTOU mitigation. Validation resolves the hostname; fetch()
 * resolves it again independently, so a TTL-0 alternating-DNS attacker can
 * in principle land the connection on a private address after a public
 * verdict. Re-resolving immediately before connect and requiring (a) no
 * private results and (b) overlap with the validated set shrinks the window
 * to subresolver cache behavior without rejecting legitimate CDN rotation,
 * which normally keeps some records stable across seconds. It does not
 * close the window — see TECH-SPEC §5 — and literal-IP URLs skip it because
 * there is nothing to rebind.
 */
async function recheckDnsStability(parsedUrl, validatedAddresses) {
  if (!Array.isArray(validatedAddresses) || validatedAddresses.length === 0) return;
  const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(hostname)) return;
  let fresh;
  try {
    fresh = await resolveHostAddresses(hostname);
  } catch {
    throw httpError(502, 'Could not resolve host');
  }
  const freshAddresses = fresh.map((entry) => entry.address);
  for (const address of freshAddresses) {
    if (isPrivateIp(address)) {
      throw httpError(400, 'URL resolves to a private network address');
    }
  }
  if (!freshAddresses.some((address) => validatedAddresses.includes(address))) {
    throw httpError(502, 'DNS answers changed during validation; refusing to fetch');
  }
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
  const { EXTENSIONS } = loadExtractCore();
  const rawSegment = parsedUrl.pathname.split('/').pop() || '';
  // Decode ONCE before any dot/extension inspection: percent-encoding can
  // hide the dot itself (e.g. report%2Epdf), so checking the raw segment
  // misclassifies encoded filenames as extensionless.
  let decoded = rawSegment;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    // Keep the undecoded form.
  }
  const hasDot = decoded.includes('.');
  if (decoded && hasDot) {
    // Prefer the path filename only when its extension is one the browser
    // converter can actually handle. An unsupported or misleading extension
    // (e.g. /download.exe serving a PDF) falls through to the Content-Type
    // mapping first, exactly like a path with no extension at all.
    const pathExt = filenameExtension(decoded);
    if (pathExt && Object.prototype.hasOwnProperty.call(EXTENSIONS, pathExt)) {
      return decoded;
    }
  }
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXTENSION[mime];
  if (ext) {
    return 'document' + ext;
  }
  // Neither the path nor the Content-Type yields a supported type. If the
  // path at least named a file, return it anyway so the allowlist check
  // below produces the informative 415 unsupported-extension response —
  // same outcome whether or not the request was redirected.
  if (decoded && hasDot) {
    return decoded;
  }
  return null;
}

const HTML_PAGE_ERROR = 'This URL points to an HTML page. Only document files (PDF, DOCX, PPTX, XLSX, etc.) can be imported locally with AnyDoc.';

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

// Release the upstream connection without consuming the body. Matters for
// every path where we reject before reading: non-success responses, declared
// oversized content, and redirect hops we refuse to follow.
function cancelUpstreamBody(upstream) {
  if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
    try {
      const cancelled = upstream.body.cancel();
      if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
    } catch {
      // Best-effort only.
    }
  }
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
async function fetchDocumentBytes(validatedInitial, signal) {
  let currentUrl = validatedInitial.url;
  let currentAddresses = validatedInitial.addresses;
  let redirectHops = 0;

  for (;;) {
    await recheckDnsStability(currentUrl, currentAddresses);
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
        cancelUpstreamBody(upstream);
        throw httpError(502, 'Source URL returned a redirect without a Location header');
      }
      if (redirectHops >= MAX_REDIRECT_HOPS) {
        cancelUpstreamBody(upstream);
        throw httpError(502, 'Source URL returned too many redirects');
      }
      redirectHops += 1;

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        cancelUpstreamBody(upstream);
        throw httpError(502, 'Source URL returned an invalid redirect');
      }
      const validated = await validateImportUrl(nextUrl);
      if (!validated.ok) {
        cancelUpstreamBody(upstream);
        throw httpError(400, validated.error);
      }
      currentUrl = validated.url;
      currentAddresses = validated.addresses;

      // Redirect responses normally have no meaningful body, but cancelling is
      // important for unusual upstreams and keeps the socket reusable in Node.
      cancelUpstreamBody(upstream);
      continue;
    }

    if (!upstream.ok) {
      cancelUpstreamBody(upstream);
      throw httpError(
        upstream.status === 404 ? 404 : 502,
        `Source URL returned ${upstream.status}`,
      );
    }

    const contentLength = parseInt(responseHeader(upstream, 'content-length') || '', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
      cancelUpstreamBody(upstream);
      throw httpError(413, 'Document is too large (25 MB max)');
    }

    // HTML is never a document — reject before reading the body so an
    // attacker-controlled or endless HTML page cannot consume the byte cap
    // (or the timeout) on a response we were always going to refuse.
    // Responses with missing/unknown Content-Type still get the bounded
    // read: they may be perfectly good documents.
    if (htmlContentType(responseHeader(upstream, 'content-type'))) {
      cancelUpstreamBody(upstream);
      throw httpError(415, HTML_PAGE_ERROR);
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
    fetched = await fetchDocumentBytes(validated, controller.signal);
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    const status = err.status || (timedOut ? 504 : 502);
    let error;
    if (timedOut) {
      error = 'Import timed out. The document may be too large or the server too slow.';
    } else if (err.status) {
      // Deliberate httpError messages are authored here and safe to relay.
      error = err.message || 'Could not fetch the URL.';
    } else {
      // Unexpected transport/runtime failures can embed internal detail
      // (resolver chains, socket errors, upstream implementation quirks).
      // Log the real cause server-side; the client gets a stable message.
      console.error('[fetch-document] upstream fetch failure:', err);
      error = 'Could not fetch the URL.';
    }
    return json(res, status, { ok: false, error });
  } finally {
    clearTimeout(timeout);
  }

  const { buffer, contentType, finalUrl, finalParsedUrl } = fetched;
  if (!buffer || buffer.length === 0) {
    return json(res, 502, { ok: false, error: 'The URL returned an empty document.' });
  }


  const filename = guessFilename(finalParsedUrl, contentType);
  if (!filename) {
    return json(res, 400, {
      ok: false,
      error: 'Could not determine a document filename or supported MIME type from the URL.',
    });
  }

  const { EXTENSIONS } = loadExtractCore();
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
