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
 * Worker logic tests for the extract proxy. Mirrors worker.test.js's
 * strategy: mock the global `fetch` to emulate the Fly.io upstream, then
 * exercise the Worker's default export directly.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

const KEY = "test-api-key";
const SECRET = "test-internal-extract-key-do-not-use-in-prod";
const UPSTREAM = "https://flatwrite-extract.fly.dev";

function req({ method = "POST", headers = {}, body = null, url = "https://extract.flatwrite.md/extract" } = {}) {
  return new Request(url, {
    method,
    headers,
    body: body == null ? undefined : typeof body === "string" ? body : body,
  });
}

function loadWorker() {
  return import("../workers/flatwrite-extract/src/index.js");
}

let upstreamCalls = [];
let upstreamResponder = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  upstreamCalls = [];
  globalThis.fetch = mock(async (url, opts) => {
    upstreamCalls.push({ url: String(url), opts });
    if (!upstreamResponder) {
      return new Response(
        JSON.stringify({ markdown: "# hi", metadata: { fileType: "csv", extractionType: "structured-data", filename: "data.csv", sizeBytes: 5 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return upstreamResponder(url, opts);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  upstreamResponder = null;
});

const env = () => ({ API_KEY: KEY, INTERNAL_EXTRACT_KEY: SECRET, UPSTREAM_URL: UPSTREAM });

// ── Auth + method ───────────────────────────────────────────────────────

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
      { INTERNAL_EXTRACT_KEY: SECRET, UPSTREAM_URL: UPSTREAM }, // no API_KEY
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

  test("rejects content-type that isn't multipart", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ headers: { "X-Api-Key": KEY, "Content-Type": "application/json" }, body: "{}" }),
      env(),
    );
    expect(r.status).toBe(415);
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
});

// ── Happy path: forwarding ───────────────────────────────────────────────

describe("extract Worker — forwarding", () => {
  test("forwards multipart body to upstream with HMAC headers", async () => {
    const { default: worker } = await loadWorker();
    const body = "--abc\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.csv\"\r\n\r\ncol1,col2\r\n--abc--\r\n";
    const r = await worker.fetch(
      req({
        headers: {
          "X-Api-Key": KEY,
          "Content-Type": "multipart/form-data; boundary=abc",
        },
        body,
      }),
      env(),
    );
    expect(r.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0];
    expect(call.url).toBe(`${UPSTREAM}/extract`);
    expect(call.opts.method).toBe("POST");
    expect(call.opts.headers["X-Extract-Timestamp"]).toMatch(/^\d{10,}$/);
    expect(call.opts.headers["X-Extract-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // The original Content-Type should be preserved (with boundary).
    expect(call.opts.headers["Content-Type"]).toBe("multipart/form-data; boundary=abc");
  });

  test("re-signs the request with INTERNAL_EXTRACT_KEY (not the caller's key)", async () => {
    const { default: worker } = await loadWorker();
    await worker.fetch(
      req({
        headers: {
          "X-Api-Key": KEY,
          "Content-Type": "multipart/form-data; boundary=abc",
        },
        body: "x",
      }),
      env(),
    );
    const sig = upstreamCalls[0].opts.headers["X-Extract-Signature"];
    // The signature is deterministic given (timestamp + payload). We can't
    // recompute it without sharing the timestamp, but we can assert that
    // it is NOT the caller's X-Api-Key.
    expect(sig).not.toBe(KEY);
    expect(sig).not.toContain(KEY);
  });

  test("forwards upstream JSON response verbatim, preserving status", async () => {
    upstreamResponder = () =>
      new Response(
        JSON.stringify({
          markdown: "# raw",
          metadata: { fileType: "csv", extractionType: "structured-data", filename: "a.csv", sizeBytes: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        headers: { "X-Api-Key": KEY, "Content-Type": "multipart/form-data; boundary=abc" },
        body: "x",
      }),
      env(),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.markdown).toBe("# raw");
  });

  test("passes through upstream 4xx/5xx without rewriting", async () => {
    upstreamResponder = () =>
      new Response(
        JSON.stringify({ error: "Conversion failed", code: "CONVERSION_FAILED" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        headers: { "X-Api-Key": KEY, "Content-Type": "multipart/form-data; boundary=abc" },
        body: "x",
      }),
      env(),
    );
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.code).toBe("CONVERSION_FAILED");
  });

  test("returns 502 when upstream is unreachable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({
        headers: { "X-Api-Key": KEY, "Content-Type": "multipart/form-data; boundary=abc" },
        body: "x",
      }),
      env(),
    );
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.code).toBe("UPSTREAM_UNREACHABLE");
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
});

// ── /mcp-token minting ──────────────────────────────────────────────────

describe("extract Worker — /mcp-token", () => {
  test("rejects mint from non-browser (no Origin)", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(req({ url: "https://extract.flatwrite.md/mcp-token" }), env());
    expect(r.status).toBe(403);
  });

  test("rejects mint from untrusted origin", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ url: "https://extract.flatwrite.md/mcp-token", headers: { "Origin": "https://evil.example" } }),
      env(),
    );
    expect(r.status).toBe(403);
  });

  test("mints a token from trusted origin", async () => {
    const { default: worker } = await loadWorker();
    const r = await worker.fetch(
      req({ url: "https://extract.flatwrite.md/mcp-token", headers: { "Origin": "https://flatwrite.md" } }),
      env(),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(typeof j.token).toBe("string");
    expect(j.token.split(".")).toHaveLength(2);
    expect(j.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
