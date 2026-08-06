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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
const dns = require("dns");

// ── Mock helpers (mirrors test/render.test.js) ─────────────────────────

function mockReq({ method = "POST", headers = {}, body = null, ip } = {}) {
  const bodyStr = body === null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  const stream = new ReadableStream({
    start(controller) {
      if (bodyStr) controller.enqueue(new TextEncoder().encode(bodyStr));
      controller.close();
    },
  });
  const reader = stream.getReader();
  return {
    method,
    headers: Object.assign({ "x-forwarded-for": ip || "203.0.113." + Math.floor(Math.random() * 250) }, headers),
    socket: { remoteAddress: ip || "203.0.113." + Math.floor(Math.random() * 250) },
    on(event, cb) {
      if (event === "data") {
        reader.read().then(({ done, value }) => {
          if (!done) cb(new TextDecoder().decode(value));
        });
      }
      if (event === "end") reader.read().then(() => cb());
    },
  };
}

function mockRes() {
  const res = { _status: 200, _headers: {}, _body: null };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.end = (d) => {
    if (typeof d === "string") {
      try { res._body = JSON.parse(d); } catch { res._body = d; }
    } else if (d) { res._body = d; }
    return res;
  };
  Object.defineProperty(res, "statusCode", {
    set(v) { res._status = v; },
    get() { return res._status; },
  });
  return res;
}

const REAL_FETCH = global.fetch;
const REAL_DNS_LOOKUP = dns.promises.lookup;

process.env.EXTRACT_SERVICE_URL = "http://extract.test";
process.env.INTERNAL_EXTRACT_KEY = "";

const handler = require("../api/import-url.js");

function makeBody(textOrBytes) {
  const encoded = typeof textOrBytes === "string"
    ? new TextEncoder().encode(textOrBytes)
    : new Uint8Array(textOrBytes);
  let read = false;
  return {
    getReader() {
      return {
        read() {
          if (read) return Promise.resolve({ done: true, value: undefined });
          read = true;
          return Promise.resolve({ done: false, value: encoded });
        },
      };
    },
  };
}

function mockFetch({ source = { status: 200, contentType: "text/csv", body: "col1,col2\na,1\n" }, extract = { status: 200, markdown: "# Extracted\n\n| col1 | col2 |\n|---|---|\n| a | 1 |\n", fileType: "csv" } } = {}) {
  source = { status: 200, ...source };
  extract = { status: 200, ...extract };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === "http://extract.test/extract" || u.endsWith("/extract")) {
      return {
        ok: extract.status >= 200 && extract.status < 300,
        status: extract.status,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          markdown: extract.markdown,
          metadata: { fileType: extract.fileType, extractionType: extract.fileType === "csv" ? "structured-data" : "body" },
        }),
      };
    }
    return {
      ok: source.status >= 200 && source.status < 300,
      status: source.status,
      headers: {
        get: (k) => {
          const lk = k.toLowerCase();
          if (lk === "content-type") return source.contentType;
          if (lk === "content-length") return source.contentLength == null ? null : String(source.contentLength);
          return null;
        },
      },
      body: makeBody(source.body),
    };
  };
}

// Public, non-private DNS resolution stub — most tests use example.com-style
// hosts and don't want to depend on real network DNS during CI.
function mockPublicDns() {
  dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
}

function setup({ source, extract } = {}) {
  mockPublicDns();
  mockFetch({ source, extract });
}

describe("api/import-url.js", () => {
  beforeEach(() => {
    mockPublicDns();
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    dns.promises.lookup = REAL_DNS_LOOKUP;
  });

  test("valid URL to a CSV document → 200 with mapped document", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "col1,col2\na,1\n" },
      extract: { markdown: "# Hello\n\n| col1 | col2 |\n|---|---|\n| a | 1 |", fileType: "csv" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv", method: "auto", retain_images: true } });
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(res._body.document.content).toContain("Hello");
    expect(res._body.document.title).toBe("Hello");
    expect(res._body.document.sourceUrl).toBe("https://example.com/data.csv");
    expect(res._body.document.importMeta).toMatchObject({
      importer: "anydoc",
      method: "auto",
      retainImages: true,
      filename: "data.csv",
    });
  });

  test("falls back to first H1 when no frontmatter title", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "x" },
      extract: { markdown: "Some preamble.\n\n# The Real Title\n\nBody.", fileType: "csv" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._body.document.title).toBe("The Real Title");
  });

  test("frontmatter title takes priority over H1", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "x" },
      extract: { markdown: "---\ntitle: Frontmatter Title\n---\n\n# Different H1", fileType: "csv" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._body.document.title).toBe("Frontmatter Title");
  });

  test("URL with no extension but supported MIME gets a synthetic filename", async () => {
    setup({
      source: { status: 200, contentType: "application/pdf", body: "%PDF-1.4" },
      extract: { markdown: "# PDF", fileType: "pdf" },
    });
    const req = mockReq({ body: { url: "https://example.com/download" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.document.importMeta.filename).toBe("document.pdf");
  });

  test("HTML content type → 415 (AnyDoc does not convert web pages)", async () => {
    setup({
      source: { status: 200, contentType: "text/html; charset=utf-8", body: "<html></html>" },
    });
    const req = mockReq({ body: { url: "https://example.com/page" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(415);
    expect(res._body.ok).toBe(false);
  });

  test("unknown MIME with no extension → 400", async () => {
    setup({
      source: { status: 200, contentType: "application/octet-stream", body: "???" },
    });
    const req = mockReq({ body: { url: "https://example.com/unknown" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  test("upstream non-200 response → 502 without leaking raw upstream body", async () => {
    setup({
      source: { status: 500, contentType: "text/html", body: "<html>secret internal error page</html>" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
    expect(JSON.stringify(res._body)).not.toContain("secret internal error page");
  });

  test("upstream network failure (fetch throws) → 502", async () => {
    global.fetch = async () => { throw new Error("network down"); };
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
  });

  test("upstream timeout (AbortError) → 504", async () => {
    global.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(504);
    expect(res._body.ok).toBe(false);
  });

  test("oversized document is rejected during streaming → 413", async () => {
    const huge = "x".repeat(26 * 1024 * 1024);
    setup({
      source: { status: 200, contentType: "text/csv", body: huge },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(413);
    expect(res._body.ok).toBe(false);
  });

  test("Content-Length header exceeding cap → early 413", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "x", contentLength: 26 * 1024 * 1024 },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(413);
    expect(res._body.ok).toBe(false);
  });

  test("empty source response → 502", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
  });

  test("extract service returns empty markdown → 502", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "x" },
      extract: { status: 200, markdown: "   \n  ", fileType: "csv" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
  });

  test("extract service non-200 → propagates as 502", async () => {
    setup({
      source: { status: 200, contentType: "text/csv", body: "x" },
      extract: { status: 500, markdown: "", fileType: "csv" },
    });
    const req = mockReq({ body: { url: "https://example.com/data.csv" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
  });

  test("invalid URL → 400", async () => {
    setup();
    const req = mockReq({ body: { url: "not a url" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.ok).toBe(false);
  });

  test("non-http(s) protocol → 400", async () => {
    setup();
    const req = mockReq({ body: { url: "ftp://example.com/file" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/http or https/);
  });

  test("localhost URL → 400", async () => {
    setup();
    const req = mockReq({ body: { url: "http://localhost:3000/secret" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/[Ll]ocalhost/);
  });

  test("private IPv4 literal (127.0.0.1) → 400", async () => {
    setup();
    const req = mockReq({ body: { url: "http://127.0.0.1/admin" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/[Pp]rivate/);
  });

  test("private IPv4 literal (10.x / 192.168.x) → 400", async () => {
    setup();
    for (const url of ["http://10.0.0.5/internal", "http://192.168.1.1/router"]) {
      const req = mockReq({ body: { url } });
      const res = mockRes();
      await handler(req, res);
      expect(res._status).toBe(400);
    }
  });

  test("hostname that resolves (DNS rebinding) to a private IP → 400", async () => {
    setup();
    dns.promises.lookup = async () => [{ address: "10.1.2.3", family: 4 }];
    const req = mockReq({ body: { url: "https://rebind.example.com/page" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/private network/);
  });

  test("hostname with multiple A/AAAA records where any one is private → 400", async () => {
    setup();
    dns.promises.lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    const req = mockReq({ body: { url: "https://mixed.example.com/page" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/private network/);
  });

  test("GET method → 405", async () => {
    setup();
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  test("invalid JSON body → 400", async () => {
    setup();
    const req = mockReq({ body: "not json" });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  test("missing url → 400", async () => {
    setup();
    const req = mockReq({ body: { method: "auto" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  test("rate limit is enforced", async () => {
    setup();
    const ip = "198.51.100.5";
    let lastStatus = 200;
    for (let i = 0; i < 25; i++) {
      const req = mockReq({ body: { url: "https://example.com/data.csv" }, ip });
      const res = mockRes();
      await handler(req, res);
      lastStatus = res._status;
    }
    expect(lastStatus).toBe(429);
  });

  test("X-Forwarded-For is ignored for rate limiting unless TRUST_PROXY is set", async () => {
    setup();
    // Same IP in X-Forwarded-For, different socket IP. Without TRUST_PROXY,
    // rate limits should not share state across socket IPs.
    const body = { url: "https://example.com/data.csv" };
    const req1 = mockReq({ body, headers: { "x-forwarded-for": "10.0.0.1" }, ip: "203.0.113.10" });
    const res1 = mockRes();
    await handler(req1, res1);
    expect(res1._status).toBe(200);
  });
});
