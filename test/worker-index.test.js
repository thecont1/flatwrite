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
 * Worker entry tests — exercise worker/index.js (the Cloudflare Worker that
 * replaces the Vercel deployment) directly, without a CF runtime.
 *
 * Strategy (mirrors test/worker.test.js for the render façade Worker):
 *   - Call the default export's fetch() with real Request objects.
 *   - Mock global fetch for Dustebin (share) and the extract service.
 *   - Provide a fake ASSETS binding backed by the real public/ files via
 *     Bun's file API so font embedding runs the true code path.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const SECRET = "test-worker-secret-1234567890";

// ── Fake ASSETS binding ─────────────────────────────────────────────────

function makeAssetsBinding() {
  return {
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const filePath = path.join(PUBLIC_DIR, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(await file.arrayBuffer(), {
          status: 200,
          headers: {
            "Content-Type":
              pathname.endsWith(".woff2")
                ? "font/woff2"
                : pathname.endsWith(".js")
                  ? "application/javascript"
                  : pathname.endsWith(".html")
                    ? "text/html"
                    : "application/octet-stream",
          },
        });
      }
      // SPA fallback like the real assets layer (not_found_handling-style)
      const index = Bun.file(path.join(PUBLIC_DIR, "index.html"));
      if (await index.exists()) {
        return new Response(await index.arrayBuffer(), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function wreq(method, path, { body, headers = {} } = {}) {
  return new Request("https://flatwrite.md" + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function loadWorker() {
  return import("../worker/index.js");
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.INTERNAL_RENDER_KEY = SECRET;
  process.env.DUSTEBIN_BASE_URL = "https://dustebin.test";
  process.env.EXTRACT_SERVICE_URL = "http://extract.test";
  process.env.INTERNAL_EXTRACT_KEY = "";
  process.env.TRUST_PROXY = "0";

  // Default fetch mock: Dustebin + everything else 404s; extract service
  // reachable for import-url tests.
  globalThis.fetch = mock(async (url, opts) => {
    const u = String(url);
    if (u === "https://dustebin.test/api/pastes") {
      return new Response(JSON.stringify({ id: "abc123.md" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.startsWith("https://dustebin.test/api/pastes/")) {
      return new Response("# shared doc\n\nhello", { status: 200 });
    }
    if (u.endsWith("/extract")) {
      return new Response(
        JSON.stringify({ markdown: "# Extracted\n", metadata: { fileType: "csv" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // import-url source fetch (example.com CSV)
    if (u.startsWith("http://example.com") || u.startsWith("https://example.com")) {
      return new Response("col1,col2\na,1\n", {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      });
    }
    return new Response("nope", { status: 404 });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── HMAC signing (same scheme as the render Worker / api/render tests) ──

const { sign } = require("../core/auth.js");

function hmacHeaders() {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "x-render-timestamp": String(ts),
    "x-render-signature": sign(SECRET, ts, "POST", "/api/render"),
    "content-type": "application/json",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("worker/index.js — static assets", () => {
  test("non-API path falls through to the ASSETS binding", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/index.html"), { ASSETS: makeAssetsBinding() }, {});
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    const text = await resp.text();
    expect(text).toContain("<!DOCTYPE html>");
  });

  test("unknown root path gets the SPA fallback from the assets layer", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/some/deep/route"), { ASSETS: makeAssetsBinding() }, {});
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
  });
});

describe("worker/index.js — /api/share", () => {
  test("POST creates a paste and returns { key }", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      wreq("POST", "/api/share", { body: "# hello world" }),
      { ASSETS: makeAssetsBinding() },
      {},
    );
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toEqual({ key: "abc123.md" });
  });

  test("empty body → 400", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("POST", "/api/share", { body: "" }), {}, {});
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe("Empty content");
  });

  test("oversized body (>512 KB) → 413", async () => {
    const { default: worker } = await loadWorker();
    const big = "x".repeat(600 * 1024);
    const resp = await worker.fetch(wreq("POST", "/api/share", { body: big }), {}, {});
    expect(resp.status).toBe(413);
    expect((await resp.json()).error).toBe("Payload too large");
  });

  test("GET → 405", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/api/share"), {}, {});
    expect(resp.status).toBe(405);
  });

  test("missing DUSTEBIN_BASE_URL → 500 configuration error", async () => {
    delete process.env.DUSTEBIN_BASE_URL;
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("POST", "/api/share", { body: "hi" }), {}, {});
    expect(resp.status).toBe(500);
    expect((await resp.json()).error).toBe("Server configuration error");
  });
});

describe("worker/index.js — /api/s", () => {
  test("GET with key returns { content }", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/api/s?key=abc123.md"), {}, {});
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.content).toBe("# shared doc\n\nhello");
  });

  test("missing key → 400", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/api/s"), {}, {});
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe("missing_key");
  });

  test("upstream 404 → not_found", async () => {
    const { default: worker } = await loadWorker();
    globalThis.fetch = async () => new Response("gone", { status: 404 });
    const resp = await worker.fetch(wreq("GET", "/api/s?key=missing"), {}, {});
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe("not_found");
  });
});

describe("worker/index.js — /api/render (canonical handler via shim)", () => {
  test("valid HMAC → 200 with { head, body }, fonts embedded via ASSETS bridge", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      wreq("POST", "/api/render", {
        body: { markdown: "# Hello\n\nWorld", font: "Inter" },
        headers: hmacHeaders(),
      }),
      { ASSETS: makeAssetsBinding() },
      {},
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/json");
    const data = await resp.json();
    expect(data.head).toContain("<head>");
    expect(data.body).toContain("<h1>Hello</h1>");
    // Font embedded as data URI through the ASSETS bridge (not node:fs)
    expect(data.head).toContain("data:font/woff2;base64,");
  });

  test("no HMAC headers → 401 Unauthorized", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      wreq("POST", "/api/render", { body: { markdown: "# x" } }),
      { ASSETS: makeAssetsBinding() },
      {},
    );
    expect(resp.status).toBe(401);
    expect((await resp.json()).error).toBe("Unauthorized");
  });

  test("GET → 405 POST only", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/api/render"), {}, {});
    expect(resp.status).toBe(405);
    expect((await resp.json()).error).toBe("POST only");
  });

  test("math mode: KaTeX assets injected when math=true, absent when false", async () => {
    const { default: worker } = await loadWorker();
    const base = { markdown: "# Math\n\n$E=mc^2$" };

    const respOn = await worker.fetch(
      wreq("POST", "/api/render", {
        body: { ...base, math: true },
        headers: hmacHeaders(),
      }),
      { ASSETS: makeAssetsBinding() },
      {},
    );
    expect(respOn.status).toBe(200);
    const on = await respOn.json();
    expect(on.head).toContain("katex.min.css");
    expect(on.head).toContain("katex.min.js");
    expect(on.body).toContain("fw-math-inline");

    const respOff = await worker.fetch(
      wreq("POST", "/api/render", { body: base, headers: hmacHeaders() }),
      { ASSETS: makeAssetsBinding() },
      {},
    );
    expect(respOff.status).toBe(200);
    const off = await respOff.json();
    expect(off.head).not.toContain("katex");
  });
});

describe("worker/index.js — /api/import-url (canonical handler via shim)", () => {
  test("valid URL → 200 with converted document", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      wreq("POST", "/api/import-url", {
        body: { url: "https://example.com/doc.csv", method: "auto", retain_images: true },
        headers: { "content-type": "application/json" },
      }),
      { ASSETS: makeAssetsBinding() },
      {},
    );
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.document.content).toContain("# Extracted");
    expect(data.document.title).toBe("Extracted");
    expect(data.document.importMeta.importer).toBe("anydoc");
  });

  test("missing url → 400", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      wreq("POST", "/api/import-url", { body: {}, headers: { "content-type": "application/json" } }),
      {},
      {},
    );
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe("URL is required");
  });

  test("localhost URL → 400 (SSRF guard survives the port)", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      wreq("POST", "/api/import-url", {
        body: { url: "http://localhost:8000/x.pdf" },
        headers: { "content-type": "application/json" },
      }),
      {},
      {},
    );
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe("Localhost URLs are not allowed");
  });

  test("GET → 405", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/api/import-url"), {}, {});
    expect(resp.status).toBe(405);
  });
});

describe("worker/index.js — unknown API paths", () => {
  test("/api/unknown → 404 JSON", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(wreq("GET", "/api/unknown"), {}, {});
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe("not_found");
  });
});
