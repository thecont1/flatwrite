#!/usr/bin/env node
/**
 * Capture the production extract service's responses for the regression corpus.
 *
 * This script is intentionally self-contained (no dependencies): it mints a
 * short-lived browser token (reused while valid, because /mcp-token is rate
 * limited to 10/minute), posts each file as multipart form-data, and writes
 * the verbatim response body plus status to test/fixtures/extract-golden.
 * It is a migration fixture generator, not part of the app runtime.
 */
import { access, readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(ROOT, 'test', 'fixtures', 'extract-corpus');
const GOLDEN_DIR = path.join(ROOT, 'test', 'fixtures', 'extract-golden');
const BASE = 'https://extract.flatwrite.md';
const ORIGIN = 'https://flatwrite.md';
const TIMEOUT_MS = 30_000;
const RETRIES_AFTER_FIRST = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries(label, url, options) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES_AFTER_FIRST; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES_AFTER_FIRST) {
        const waitMs = 1000 * (attempt + 1);
        console.warn(`${label}: attempt ${attempt + 1} failed (${error.message}); retrying in ${waitMs}ms`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
}

let cachedToken = null;

async function mintToken() {
  // The endpoint allows 10 token mints per IP per minute. Capture runs can
  // cross that boundary when retried, so treat 429 as a paced retry rather
  // than a fatal capture error.
  for (let rateLimitRetries = 0; rateLimitRetries < 4; rateLimitRetries += 1) {
    const response = await fetchWithRetries('mcp-token', `${BASE}/mcp-token`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const text = await response.text();
    if (response.status === 429) {
      console.warn('mcp-token rate limited; waiting 62s for the sliding window');
      await sleep(62_000);
      continue;
    }
    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    if (!response.ok || !body || typeof body.token !== 'string') {
      throw new Error(`mcp-token failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return body;
  }
  throw new Error('mcp-token failed: still rate limited after retries');
}

async function getToken() {
  const nowPlusSkew = Math.floor(Date.now() / 1000) + 10;
  if (cachedToken && cachedToken.expiresAt > nowPlusSkew) return cachedToken.token;
  cachedToken = await mintToken();
  return cachedToken.token;
}

async function extractFile(filename, bytes) {
  const token = await getToken();
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const response = await fetchWithRetries(filename, `${BASE}/extract`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'X-Mcp-Token': token,
    },
    body: form,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { file: filename, status: response.status, body };
}

async function main() {
  await mkdir(GOLDEN_DIR, { recursive: true });
  const files = (await readdir(CORPUS_DIR))
    .filter((name) => !name.startsWith('.'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No corpus files found in ${CORPUS_DIR}`);
  }

  const force = process.argv.includes('--force');
  const results = [];
  for (const filename of files) {
    // Use the complete corpus filename in the golden name. Plain stems are
    // not unique (pres.ppsx and pres.pptm), while this form always is.
    const outPath = path.join(GOLDEN_DIR, `${filename}.json`);
    if (!force) {
      try {
        await access(outPath);
        console.log(`${filename}: existing golden, skipped`);
        results.push({ file: filename, status: 'SKIPPED', markdownLength: '-' });
        continue;
      } catch { /* no existing golden */ }
    }
    const bytes = await readFile(path.join(CORPUS_DIR, filename));
    process.stdout.write(`${filename}: `);
    try {
      const result = await extractFile(filename, bytes);
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
      const markdownLength = result.body && typeof result.body.markdown === 'string'
        ? result.body.markdown.length
        : '-';
      console.log(`HTTP ${result.status}, markdown ${markdownLength}`);
      results.push({ file: filename, status: result.status, markdownLength });
    } catch (error) {
      console.log(`capture failed: ${error.message}`);
      results.push({ file: filename, status: 'FETCH_FAILED', markdownLength: '-', error: error.message });
    }
  }

  console.log('\nSummary:');
  for (const row of results) {
    console.log(`${row.file}\t${row.status}\t${row.markdownLength}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
