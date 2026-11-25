#!/usr/bin/env node
/**
 * measure-extract-cpu.mjs — measure the WASM extract Worker's behavior on
 * the staging environment by POSTing every corpus file repeatedly and
 * recording status + wall latency.
 *
 * This script is one half of the Phase-3 measurement gate. It measures
 * client-observable wall latency and HTTP status; the CPU time per request
 * is captured in parallel with:
 *
 *   wrangler tail --env staging --format json
 *
 * (run from workers/flatwrite-extract) — look at `cpuTime`, `wallTime` and
 * `outcome` per invocation, and count 1102/"exceededCpu" outcomes.
 *
 * Usage:
 *   node scripts/measure-extract-cpu.mjs --url https://flatwrite-extract-staging.<subdomain>.workers.dev
 *
 * Options:
 *   --url <base>       Base URL of the staging worker. Falls back to the
 *                      EXTRACT_STAGING_URL env var. Required.
 *   --api-key <key>    API key for X-Api-Key auth. Falls back to the
 *                      EXTRACT_API_KEY env var. Required. Server-to-server
 *                      auth is used (no Origin header) because /mcp-token
 *                      only mints for trusted flatwrite.md origins.
 *   --runs <n>         Repetitions per file (default 5).
 *   --out <file>       Results JSON path (default: extract-cpu-results-<timestamp>.json
 *                      in the repo root).
 *
 * Output: the full results JSON goes to stdout AND the --out file:
 *   { url, startedAt, runsPerFile, files: { "<name>": [
 *       { run, status, latencyMs, bytes, markdownBytes?, errorCode? } ] },
 *     summary: { "<name>": { count, okCount, p50Ms, p95Ms, minMs, maxMs,
 *                            statuses } } }
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(ROOT, 'test', 'fixtures', 'extract-corpus');
const TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const args = { runs: 5, url: process.env.EXTRACT_STAGING_URL || '', apiKey: process.env.EXTRACT_API_KEY || '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length);
    else if (arg === '--api-key') args.apiKey = argv[++i];
    else if (arg.startsWith('--api-key=')) args.apiKey = arg.slice('--api-key='.length);
    else if (arg === '--token') args.apiKey = argv[++i]; // accepted alias — value is used as X-Api-Key
    else if (arg === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (arg.startsWith('--runs=')) args.runs = parseInt(arg.slice('--runs='.length), 10);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/measure-extract-cpu.mjs --url <base> [--api-key <key>] [--runs 5] [--out file]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

async function postFile(baseUrl, apiKey, filename, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/extract`, {
      method: 'POST',
      headers: {
        // No Origin header: X-Api-Key is server-to-server only by design.
        'X-Api-Key': apiKey,
      },
      body: form,
      signal: controller.signal,
    });
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
    const result = {
      status: response.status,
      latencyMs,
    };
    if (body && typeof body === 'object') {
      if (typeof body.markdown === 'string') result.markdownBytes = body.markdown.length;
      const errObj = body.detail && typeof body.detail === 'object' ? body.detail : body;
      if (typeof errObj.code === 'string') result.errorCode = errObj.code;
    }
    return result;
  } catch (error) {
    return {
      status: 0,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      errorCode: 'CLIENT_ERROR',
      clientError: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('error: --url <base> is required (or set EXTRACT_STAGING_URL)');
    process.exit(2);
  }
  if (!args.apiKey) {
    console.error('error: --api-key <key> is required (or set EXTRACT_API_KEY)');
    process.exit(2);
  }
  const baseUrl = args.url.replace(/\/+$/, '');
  if (!Number.isFinite(args.runs) || args.runs < 1) {
    console.error('error: --runs must be a positive integer');
    process.exit(2);
  }

  const files = (await readdir(CORPUS_DIR)).filter((name) => !name.startsWith('.')).sort();
  if (files.length === 0) {
    console.error(`error: no corpus files in ${CORPUS_DIR}`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const results = {};
  const summary = {};

  for (const filename of files) {
    const bytes = new Uint8Array(await readFile(path.join(CORPUS_DIR, filename)));
    const runs = [];
    for (let run = 1; run <= args.runs; run += 1) {
      const outcome = await postFile(baseUrl, args.apiKey, filename, bytes);
      runs.push({ run, bytes: bytes.byteLength, ...outcome });
      process.stderr.write(
        `${filename} run ${run}/${args.runs}: HTTP ${outcome.status} in ${outcome.latencyMs}ms` +
        `${outcome.errorCode ? ` (${outcome.errorCode})` : ''}\n`,
      );
    }
    results[filename] = runs;
    const latencies = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
    const statuses = {};
    for (const r of runs) statuses[String(r.status)] = (statuses[String(r.status)] || 0) + 1;
    summary[filename] = {
      count: runs.length,
      okCount: runs.filter((r) => r.status === 200).length,
      minMs: latencies[0],
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: latencies[latencies.length - 1],
      statuses,
    };
  }

  const report = {
    url: baseUrl,
    startedAt,
    runsPerFile: args.runs,
    note: 'Wall latency measured client-side. Capture cpuTime/wallTime/outcome with `wrangler tail --env staging --format json` in parallel.',
    files: results,
    summary,
  };

  const json = JSON.stringify(report, null, 2);
  const outPath = args.out || path.join(ROOT, `extract-cpu-results-${startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(outPath, json);
  process.stderr.write(`results written to ${outPath}\n`);
  console.log(json);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
