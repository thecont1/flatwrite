// core/inline-assets.js
// Fetch remote CSS/font files and inline them as base64 data URIs.
// Results are cached for the lifetime of the process so unchanged assets
// are not re-downloaded on every render.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CACHE_BYTES = 10 * 1024 * 1024;
const cache = new Map();

let currentCacheBytes = 0;

function base64ForMime(mime) {
  if (!mime) return '';
  if (mime.includes('woff2')) return 'font/woff2';
  if (mime.includes('woff')) return 'font/woff';
  if (mime.includes('ttf')) return 'font/ttf';
  if (mime.includes('otf')) return 'font/otf';
  if (mime.includes('css')) return 'text/css';
  return mime.split(';')[0].trim();
}

function mimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';
  if (ext === '.css') return 'text/css';
  return 'application/octet-stream';
}

async function fetchRemote(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const buffer = await resp.arrayBuffer();
    return { buffer, contentType };
  } catch (err) {
    throw new Error(`Failed to inline asset ${url}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function readLocal(filePath) {
  const resolved = path.resolve(filePath);
  try {
    const buffer = fs.readFileSync(resolved);
    return { buffer, contentType: mimeFromPath(resolved) };
  } catch (err) {
    throw new Error(`Failed to read local asset ${filePath}: ${err.message}`);
  }
}

async function loadAsset(source) {
  if (cache.has(source)) {
    return cache.get(source);
  }

  const { buffer, contentType } = source.startsWith('http://') || source.startsWith('https://')
    ? await fetchRemote(source)
    : readLocal(source);

  const bytes = buffer.byteLength || buffer.length;
  if (currentCacheBytes + bytes > MAX_CACHE_BYTES) {
    // Evict oldest entries until we fit.
    const keys = Array.from(cache.keys());
    let i = 0;
    while (currentCacheBytes + bytes > MAX_CACHE_BYTES && i < keys.length) {
      const key = keys[i++];
      const entry = cache.get(key);
      if (entry) {
        currentCacheBytes -= entry.bytes;
        cache.delete(key);
      }
    }
  }

  const mime = base64ForMime(contentType);
  const b64 = Buffer.from(buffer).toString('base64');
  const dataUri = `data:${mime};base64,${b64}`;
  const entry = { dataUri, bytes, contentType };
  cache.set(source, entry);
  currentCacheBytes += bytes;
  return entry;
}

async function inlineCssUrls(css) {
  // Replace relative url(...) references inside CSS with absolute URLs or data URIs
  // when the URL is remote or points to a local asset we can resolve.
  const urlRe = /url\(\s*['"]?([^'"\)]+)['"]?\s*\)/g;
  let result = css;
  let match;
  const replacements = [];
  while ((match = urlRe.exec(css)) !== null) {
    const rawUrl = match[1];
    if (rawUrl.startsWith('data:')) continue;
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      replacements.push({ from: rawUrl, to: (await loadAsset(rawUrl)).dataUri });
    }
  }
  for (const { from, to } of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

module.exports = {
  loadAsset,
  inlineCssUrls,
};
