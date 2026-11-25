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

/**
 * Worker logic tests for the in-process WASM extract Worker.
 *
 * The Worker no longer proxies anywhere: conversion happens in-isolate
 * with real WASM engines (@firecrawl/anydoc-wasm + pdf-inspector-wasm),
 * initialized in workers/flatwrite-extract/src/engines.js. In Bun the
 * `.wasm` imports resolve to file paths and engines.js compiles them from
 * disk — see that file's header comment for the environment detection.
 *
 * These tests therefore exercise REAL conversions end-to-end through the
 * Worker's fetch() handler using the regression corpus. A global fetch
 * spy that throws proves no upstream/network call ever happens.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFile } from "node:fs/promises";

const KEY = "test-api-key";
const BASE = "https://extract.flatwrite.md";

function loadWorker() {
  return import("../workers/flatwrite-extract/src/index.js");
}

// ── fetch spy: conversion must be fully in-process ──────────────────────

let fetchCalls = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = mock(async (url) => {
    fetchCalls.push(String(url));
    throw new Error(`network access is forbidden in the extract worker: ${url}`);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const env = () => ({ API_KEY: KEY });

// ── request builders ────────────────────────────────────────────────────

function req({ method = "POST", headers = {}, body = null, url = `${BASE}/extract` } = {}) {
  return new Request(url, {
    method,
    headers,
    body: body == null ? undefined : body,
  });
}

/** Multipart request carrying `bytes` as the `file` field. Content-Type
 * (with boundary) is set automatically by the Request constructor. */
async function fileReq(filename, bytes, { headers = {}, url } = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], filename));
  return req({
    url,
    headers: { "X-Api-Key": KEY, ...headers },
    body: form,
  });
}

async function corpusBytes(name) {
  return readFile(`test/fixtures/extract-corpus/${name}`);
}

async function goldenBody(name) {
  return JSON.parse(await readFile(`test/fixtures/extract-golden/${name}.json`, "utf8"));
}

// ── Auth + method + worker-level validation ─────────────────────────────

describe("extract Worker — auth + method", () => {
  test("rejects GET", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(req({ method: "GET" }), env());
    expect(r.status).toBe(405);
  });

  test("rejects missing API key config (500)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ headers: { "X-Api-Key": KEY, "Content-Type": "multipart/form-data; boundary=abc" }, body: "ignored" }),
      {}, // no API_KEY
    );
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.code).toBe("MISCONFIGURED");
  });

  test("rejects bad API key (401)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ headers: { "X-Api-Key": "wrong", "Content-Type": "multipart/form-data; boundary=abc" }, body: "ignored" }),
      env(),
    );
    expect(r.status).toBe(401);
  });

  test("rejects X-Api-Key from a browser (401)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        headers: {
          "X-Api-Key": KEY,
          "Content-Type": "multipart/form-data; boundary=abc",
          "Origin": "https://flatwrite.md",
        },
        body: "ignored",
      }),
      env(),
    );
    expect(r.status).toBe(401);
    const j = await r.json();
    expect(j.code).toBe("API_KEY_NOT_ALLOWED_FROM_BROWSER");
  });

  test("rejects content-type that isn't multipart (415 UNSUPPORTED_MEDIA_TYPE)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ headers: { "X-Api-Key": KEY, "Content-Type": "application/json" }, body: "{}" }),
      env(),
    );
    expect(r.status).toBe(415);
    const j = await r.json();
    expect(j.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  test("rejects multipart/form-data with a missing boundary (400)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ headers: { "X-Api-Key": KEY, "Content-Type": "multipart/form-data" }, body: "ignored" }),
      env(),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("BAD_REQUEST");
  });

  test("rejects oversized upload at the edge (413)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        headers: {
          "X-Api-Key": KEY,
          "Content-Type": "multipart/form-data; boundary=abc",
          "Content-Length": String(26 * 1024 * 1024), // > 25 MB
        },
        body: "ignored",
      }),
      env(),
    );
    expect(r.status).toBe(413);
    const j = await r.json();
    expect(j.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("rejects multipart body without a file field (400, flat shape)", async () => {
    const { default: worker } = await loadWorker();
    const form = new FormData();
    form.append("notfile", "hello");
    const r = await worker.fetch(
      req({ headers: { "X-Api-Key": KEY }, body: form }),
      env(),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("BAD_REQUEST");
    // Worker-level validation errors are flat, not detail-wrapped.
    expect(j.detail).toBeUndefined();
  });

  test("rejects a file field with an empty filename (400, FastAPI detail shape)", async () => {
    const { default: worker } = await loadWorker();
    // Hand-built multipart: undici normalizes empty filenames away when
    // using FormData, so craft the body manually with filename="".
    const boundary = "testboundary";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename=""\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n` +
      `abc\r\n` +
      `--${boundary}--\r\n`;
    const r = await worker.fetch(
      req({
        headers: {
          "X-Api-Key": KEY,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }),
      env(),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.detail).toEqual({ error: "filename is empty", code: "BAD_REQUEST" });
  });
});

// ── In-process conversions through the real WASM engines ────────────────

describe("extract Worker — in-process conversion", () => {
  test("never calls global fetch during /extract", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("sample.pptx", await corpusBytes("sample.pptx")), env());
    expect(r.status).toBe(200);
    expect(fetchCalls).toHaveLength(0);
  });

  test("sample.pptx → 200 with golden-exact markdown and metadata", async () => {
    const { default: worker } = await loadWorker();
    const golden = await goldenBody("sample.pptx");
    expect(golden.status).toBe(200);
    const r = await worker.fetch(await fileReq("sample.pptx", await corpusBytes("sample.pptx")), env());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.markdown).toContain("## Welcome");
    expect(j.metadata.fileType).toBe("powerpoint");
    expect(j.metadata.extractionType).toBe("powerpoint-notes");
    expect(j.metadata).toEqual(golden.body.metadata);
    expect(j.markdown).toBe(golden.body.markdown);
    expect(fetchCalls).toHaveLength(0);
  });

  test("pdf-text.pdf → 200 with non-empty markdown", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("pdf-text.pdf", await corpusBytes("pdf-text.pdf")), env());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(typeof j.markdown).toBe("string");
    expect(j.markdown.length).toBeGreaterThan(0);
    expect(j.metadata.fileType).toBe("pdf");
    expect(j.metadata.extractionType).toBe("pdf-body");
  });

  test("encrypted.odt → 422 detail ENCRYPTED", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("encrypted.odt", await corpusBytes("encrypted.odt")), env());
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.detail.code).toBe("ENCRYPTED");
    expect(typeof j.detail.error).toBe("string");
  });

  test("pdf-scanned.pdf → 422 detail NEEDS_OCR", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("pdf-scanned.pdf", await corpusBytes("pdf-scanned.pdf")), env());
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.detail.code).toBe("NEEDS_OCR");
  });

  test("image-text.png → 415 (images are not accepted on this API)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("image-text.png", await corpusBytes("image-text.png")), env());
    expect(r.status).toBe(415);
    const j = await r.json();
    expect(j.detail.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  test("audio.wav → 415 (audio is not accepted on this API)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("audio.wav", await corpusBytes("audio.wav")), env());
    expect(r.status).toBe(415);
    const j = await r.json();
    expect(j.detail.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  test("unknown extension .xyz → 415", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("notes.xyz", new Uint8Array([1, 2, 3])), env());
    expect(r.status).toBe(415);
    const j = await r.json();
    expect(j.detail.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  test("empty file → 400 detail EMPTY_FILE", async () => {
    const { default: worker } = await loadWorker();
    const bytes = await corpusBytes("empty.docx");
    expect(bytes.byteLength).toBe(0);
    const r = await worker.fetch(await fileReq("empty.docx", bytes), env());
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.detail).toEqual({ error: "file is empty", code: "EMPTY_FILE" });
  });

  test("corrupt.docx → 500 detail CONVERT_FAILED", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(await fileReq("corrupt.docx", await corpusBytes("corrupt.docx")), env());
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.detail).toEqual({ error: "Conversion failed", code: "CONVERT_FAILED" });
  });

  test("browser path: X-Mcp-Token converts end-to-end", async () => {
    const { default: worker } = await loadWorker();
    const mint = await worker.fetch(
      req({ url: `${BASE}/mcp-token`, headers: { "Origin": "https://flatwrite.md" } }),
      env(),
    );
    expect(mint.status).toBe(200);
    const { token } = await mint.json();
    const form = new FormData();
    form.append("file", new File([await corpusBytes("sample.pptx")], "sample.pptx"));
    const r = await worker.fetch(
      req({
        headers: { "X-Mcp-Token": token, "Origin": "https://flatwrite.md" },
        body: form,
      }),
      env(),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.markdown).toContain("## Welcome");
    // Trusted browser origin gets CORS headers on the response.
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://flatwrite.md");
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── CORS ─────────────────────────────────────────────────────────────────

describe("extract Worker — CORS", () => {
  test("trusted browser preflight gets CORS headers", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        method: "OPTIONS",
        headers: {
          "Origin": "https://flatwrite.md",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type, X-Mcp-Token",
        },
      }),
      env(),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://flatwrite.md");
    expect(r.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    const allowHeaders = r.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders).toContain("Content-Type");
    expect(allowHeaders).toContain("X-Mcp-Token");
    // X-Api-Key is intentionally NOT in the allow list.
    expect(allowHeaders).not.toContain("X-Api-Key");
  });

  test("untrusted browser preflight gets no CORS headers", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        method: "OPTIONS",
        headers: {
          "Origin": "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
      env(),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("ALLOWED_DEV_ORIGINS unblocks localhost for local dev", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        method: "OPTIONS",
        headers: {
          "Origin": "http://127.0.0.1:8080",
          "Access-Control-Request-Method": "POST",
        },
      }),
      { ...env(), ALLOWED_DEV_ORIGINS: "http://127.0.0.1:8080,http://localhost:3000" },
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8080");
  });

  test("ALLOWED_DEV_ORIGINS does NOT relax the production allowlist", async () => {
    const { default: worker } = await loadWorker();
    // The dev-origin list contains 127.0.0.1, but the request origin is
    // something else entirely — it must be rejected.
    const r = await worker.fetch(
      req({
        method: "OPTIONS",
        headers: {
          "Origin": "https://attacker.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
      { ...env(), ALLOWED_DEV_ORIGINS: "http://127.0.0.1:8080" },
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("ALLOWED_DEV_ORIGINS enables mcp-token mint from localhost", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        url: `${BASE}/mcp-token`,
        headers: {
          "Origin": "http://127.0.0.1:8080",
          "CF-Connecting-IP": "127.0.0.1",
        },
      }),
      { ...env(), ALLOWED_DEV_ORIGINS: "http://127.0.0.1:8080" },
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(typeof j.token).toBe("string");
  });
});

// ── /mcp-token minting ──────────────────────────────────────────────────

describe("extract Worker — /mcp-token", () => {
  test("rejects mint from non-browser (no Origin)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(req({ url: `${BASE}/mcp-token` }), env());
    expect(r.status).toBe(403);
  });

  test("rejects mint from untrusted origin", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ url: `${BASE}/mcp-token`, headers: { "Origin": "https://evil.example" } }),
      env(),
    );
    expect(r.status).toBe(403);
  });

  test("mints a token from trusted origin", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ url: `${BASE}/mcp-token`, headers: { "Origin": "https://flatwrite.md" } }),
      env(),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(typeof j.token).toBe("string");
    expect(j.token.split(".")).toHaveLength(2);
    expect(j.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// ── Rate-limit Map bound ─────────────────────────────────────────────────

describe("extract Worker — token rate-limit Map bound", () => {
  test("stays bounded at MAX_TRACKED_IPS under an IP-rotation attack", async () => {
    const { __testing } = await loadWorker();
    const { tokenRequestLog, MAX_TRACKED_IPS, isTokenRateLimited } = __testing;
    tokenRequestLog.clear();

    const extra = 50;
    for (let i = 0; i < MAX_TRACKED_IPS + extra; i++) {
      isTokenRateLimited(`10.0.${Math.floor(i / 256)}.${i % 256}`);
    }

    expect(tokenRequestLog.size).toBeLessThanOrEqual(MAX_TRACKED_IPS);
    tokenRequestLog.clear();
  });

  test("still rate-limits a single IP after other IPs are evicted", async () => {
    const { __testing } = await loadWorker();
    const { tokenRequestLog, isTokenRateLimited } = __testing;
    tokenRequestLog.clear();

    const targetIp = "203.0.113.42";
    for (let i = 0; i < 10; i++) {
      expect(isTokenRateLimited(targetIp)).toBe(false);
    }
    // The 11th request within the window must be rejected.
    expect(isTokenRateLimited(targetIp)).toBe(true);
    tokenRequestLog.clear();
  });
});
