/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it or modify
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
    socket: { remoteAddress: "203.0.113.1" },
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

const handler = require("../api/import-url.js");

const REAL_FETCH = global.fetch;
const REAL_DNS_LOOKUP = dns.promises.lookup;

function mockUpstream({ ok = true, status = 200, text = "# Hello\n\nWorld", headers = {} } = {}) {
  global.fetch = async () => ({
    ok,
    status,
    headers: {
      get(key) {
        const found = Object.keys(headers).find((k) => k.toLowerCase() === key.toLowerCase());
        return found ? headers[found] : null;
      },
    },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });
}

// Public, non-private DNS resolution stub — most tests use example.com-style
// hosts and don't want to depend on real network DNS during CI.
function mockPublicDns() {
  dns.promises.lookup = async () => ({ address: "93.184.216.34", family: 4 });
}

describe("api/import-url.js", () => {
  beforeEach(() => {
    mockPublicDns();
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    dns.promises.lookup = REAL_DNS_LOOKUP;
  });

  test("valid URL + successful markdown.new response → 200 with mapped document", async () => {
    mockUpstream({
      text: "# Hello World\n\nSome article body.",
      headers: { "content-type": "text/markdown; charset=utf-8", "x-markdown-tokens": "42", "vary": "Accept" },
    });
    const req = mockReq({ body: { url: "https://example.com/article", method: "auto", retain_images: true } });
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(res._body.document.content).toContain("Hello World");
    expect(res._body.document.sourceUrl).toBe("https://example.com/article");
    expect(res._body.document.title).toBe("Hello World");
    expect(res._body.document.importMeta).toMatchObject({
      importer: "markdown.new",
      tokenCount: 42,
      method: "auto",
      retainImages: true,
      contentType: "text/markdown; charset=utf-8",
    });
    expect(typeof res._body.document.importMeta.fetchedAt).toBe("string");
  });

  test("method and retain_images are passed through to the markdown.new request", async () => {
    let capturedBody = null;
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/markdown" : null) },
        arrayBuffer: async () => new TextEncoder().encode("# Doc").buffer,
      };
    };
    const req = mockReq({ body: { url: "https://example.com/x", method: "browser", retain_images: false } });
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(capturedBody).toEqual({ url: "https://example.com/x", method: "browser", retain_images: false });
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["Accept"]).toContain("text/markdown");
  });

  test("invalid method falls back to 'auto'", async () => {
    let capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode("# Doc").buffer,
      };
    };
    const req = mockReq({ body: { url: "https://example.com/x", method: "not-a-real-method" } });
    const res = mockRes();
    await handler(req, res);
    expect(capturedBody.method).toBe("auto");
  });

  test("frontmatter title takes priority over H1", async () => {
    mockUpstream({ text: "---\ntitle: Frontmatter Title\ndescription: A nice article\n---\n\n# Different H1\n\nBody" });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._body.document.title).toBe("Frontmatter Title");
    expect(res._body.document.importMeta.description).toBe("A nice article");
  });

  test("falls back to first H1 when no frontmatter title", async () => {
    mockUpstream({ text: "Some preamble text.\n\n# The Real Title\n\nBody text." });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._body.document.title).toBe("The Real Title");
  });

  test("unwraps markdown.new's real JSON envelope ({success, title, content, tokens})", async () => {
    // markdown.new's actual production response is a JSON object, not a
    // bare text/markdown body, regardless of the Accept header sent.
    mockUpstream({
      text: JSON.stringify({
        success: true,
        url: "https://example.com/article",
        title: "Envelope Title",
        content: "# Different H1\n\nBody from envelope.",
        tokens: 99,
        method: "Cloudflare Workers AI",
      }),
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.document.content).toBe("# Different H1\n\nBody from envelope.");
    expect(res._body.document.title).toBe("Envelope Title");
    expect(res._body.document.importMeta.tokenCount).toBe(99);
  });

  test("JSON envelope with success:false → 502", async () => {
    mockUpstream({
      text: JSON.stringify({ success: false, error: "Could not fetch page" }),
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
  });

  test("falls back to hostname when no frontmatter and no H1", async () => {
    mockUpstream({ text: "Just plain body text with no heading." });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._body.document.title).toBe("example.com");
  });

  test("invalid URL → 400", async () => {
    const req = mockReq({ body: { url: "not a url" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.ok).toBe(false);
  });

  test("non-http(s) protocol → 400", async () => {
    const req = mockReq({ body: { url: "ftp://example.com/file" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/http or https/);
  });

  test("localhost URL → 400", async () => {
    const req = mockReq({ body: { url: "http://localhost:3000/secret" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/[Ll]ocalhost/);
  });

  test("private IPv4 literal (127.0.0.1) → 400", async () => {
    const req = mockReq({ body: { url: "http://127.0.0.1/admin" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/[Pp]rivate/);
  });

  test("private IPv4 literal (10.x / 192.168.x) → 400", async () => {
    for (const url of ["http://10.0.0.5/internal", "http://192.168.1.1/router"]) {
      const req = mockReq({ body: { url } });
      const res = mockRes();
      await handler(req, res);
      expect(res._status).toBe(400);
    }
  });

  test("hostname that resolves (DNS rebinding) to a private IP → 400", async () => {
    dns.promises.lookup = async () => ({ address: "10.1.2.3", family: 4 });
    const req = mockReq({ body: { url: "https://rebind.example.com/page" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/private network/);
  });

  test("upstream non-200 response → 502 without leaking raw upstream body", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode("<html>secret internal error page</html>").buffer,
    });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.ok).toBe(false);
    expect(JSON.stringify(res._body)).not.toContain("secret internal error page");
  });

  test("upstream network failure (fetch throws) → 504", async () => {
    global.fetch = async () => { throw new Error("network down"); };
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(504);
    expect(res._body.ok).toBe(false);
  });

  test("empty markdown response → 502", async () => {
    mockUpstream({ text: "   \n  " });
    const req = mockReq({ body: { url: "https://example.com/article" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(502);
  });

  test("GET method → 405", async () => {
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  test("invalid JSON body → 400", async () => {
    const req = mockReq({ body: "{not json" });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  test("missing url → 400", async () => {
    const req = mockReq({ body: { method: "auto" } });
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });
});
