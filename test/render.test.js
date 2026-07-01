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

import { describe, test, expect } from "bun:test";
const crypto = require("crypto");
const { sign } = require("../core/auth");

// ── Mock helpers ────────────────────────────────────────────────────────

function mockReq({ method = "POST", headers = {}, body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const stream = new ReadableStream({
    start(controller) {
      if (bodyStr) controller.enqueue(new TextEncoder().encode(bodyStr));
      controller.close();
    },
  });
  const reader = stream.getReader();
  return {
    method,
    headers,
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
  res.status = (c) => { res._status = c; return res; };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.json = (d) => { res._body = d; return res; };
  res.send = (d) => { res._body = d; return res; };
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

function hmacHeaders(secret, method, path) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(secret, ts, method, path);
  return { "x-render-timestamp": String(ts), "x-render-signature": sig };
}

const SECRET = "test-secret-key-12345";
const handler = require("../api/render.js");

// ── api/render.js ───────────────────────────────────────────────────────

describe("api/render.js", () => {
  test("valid HMAC → 200 with head+body fragment", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: {
        markdown: "# Hello\n\nWorld",
        title: "Test",
        font: "Inter",
        size: 0,
        weight: 0,
        line: 0,
      },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body).toHaveProperty("head");
    expect(res._body).toHaveProperty("body");
    expect(res._body.head).toContain("<head>");
    expect(res._body.head).toContain("</head>");
    expect(res._body.body).toContain('<body class="fw-render"');
    expect(res._body.body).toContain("</body>");
    expect(res._body.body).toContain("<main>");
    expect(res._body.head).toContain(".fw-render");
    expect(res._body.body).toContain("<h1>Hello</h1>");
    expect(res._body.head).not.toContain("<link ");
    expect(res._body.head).not.toContain("<meta ");
    expect(res._body.head).not.toContain("<title>");
    expect(res._body.head).not.toContain("<base ");
  });

  test("scale indices are converted to absolute values", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: { markdown: "# Hello", size: 1, weight: 1, line: 1 },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.head).toContain("font-size: 17px");
    expect(res._body.head).toContain("font-weight: 600");
    expect(res._body.head).toContain("line-height: 2");
  });

  test("missing markdown → 400", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: { title: "No content" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain("markdown");
  });

  test("markdownUrl validation: disallowed host → 502, non-http scheme → 502", async () => {
    for (const url of [
      "https://evil.example.com/README.md",         // disallowed host
      "ftp://raw.githubusercontent.com/README.md",   // non-http scheme
    ]) {
      const req = mockReq({
        headers: hmacHeaders(SECRET, "POST", "/api/render"),
        body: { markdownUrl: url },
      });
      const res = mockRes();
      process.env.INTERNAL_RENDER_KEY = SECRET;
      await handler(req, res);
      expect(res._status).toBe(502);
      expect(res._body.error).toMatch(/Disallowed|http or https/);
    }
  });

  test("missing signature headers → 401", async () => {
    const req = mockReq({ headers: {}, body: { markdown: "# Hi" } });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test("wrong signature → 401", async () => {
    const req = mockReq({
      headers: {
        "x-render-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-render-signature": "deadbeef",
      },
      body: { markdown: "# Hi" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test("expired timestamp → 401 (replay protection)", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const sig = sign(SECRET, oldTs, "POST", "/api/render");
    const req = mockReq({
      headers: { "x-render-timestamp": String(oldTs), "x-render-signature": sig },
      body: { markdown: "# Hi" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test("GET method → 405", async () => {
    const req = mockReq({
      method: "GET",
      headers: hmacHeaders(SECRET, "GET", "/api/render"),
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  test("markdownUrl is used as baseUrl to resolve relative image URLs", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: {
        markdown: "![ngl](./assets/app-screenshot.png)\n\n<img src=\"assets/generations/x.jpg\" width=\"400\">",
        markdownUrl: "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md",
      },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.body).toContain("https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/app-screenshot.png");
    expect(res._body.body).toContain("https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/generations/x.jpg");
  });
});

// ── core/rate-limit.js ──────────────────────────────────────────────────

describe("core/rate-limit.js", () => {
  const { createRateLimiter } = require("../core/rate-limit");

  test("enforces window:max ratio per key", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    const third = rl.check("a");
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    rl.reset();
  });

  test("different keys are independent", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    rl.check("x");
    expect(rl.check("x").allowed).toBe(false);
    expect(rl.check("y").allowed).toBe(true);
    rl.reset();
  });

  test("reset clears all state (test isolation)", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    rl.check("w");
    rl.reset();
    expect(rl.check("w").allowed).toBe(true);
  });
});

// ── core/auth.js ────────────────────────────────────────────────────────

describe("core/auth.js", () => {
  const { verify } = require("../core/auth");

  test("sign + verify round-trips", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(SECRET, ts, "POST", "/api/render");
    expect(verify(SECRET, "POST", "/api/render", String(ts), sig).ok).toBe(true);
  });

  test("rejects malformed/invalid input: missing headers, non-numeric ts, wrong secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign("wrong-secret", ts, "POST", "/api/render");
    const cases = [
      { args: [SECRET, "POST", "/api/render", undefined, undefined], expect: false },
      { args: [SECRET, "POST", "/api/render", "not-a-number", "abc"], expect: false },
      { args: [SECRET, "POST", "/api/render", String(ts), sig], expect: false },
    ];
    for (const c of cases) {
      const r = verify(...c.args);
      expect(r.ok).toBe(c.expect);
    }
  });

  test("rejects expired timestamp (replay protection)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const sig = sign(SECRET, oldTs, "POST", "/api/render");
    const result = verify(SECRET, "POST", "/api/render", String(oldTs), sig);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("expired");
  });

  test("rejects tampered signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(SECRET, ts, "POST", "/api/render");
    const last = sig.slice(-1);
    const tamperedLast = last === "0" ? "1" : "0";
    const tampered = sig.slice(0, -1) + tamperedLast;
    const result = verify(SECRET, "POST", "/api/render", String(ts), tampered);
    expect(result.ok).toBe(false);
  });

  test("rejects wrong path (path is part of the signed payload)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(SECRET, ts, "POST", "/api/render");
    const result = verify(SECRET, "POST", "/api/other", String(ts), sig);
    expect(result.ok).toBe(false);
  });
});

// ── sanitizeHTML ────────────────────────────────────────────────────────

describe("sanitizeHTML", () => {
  const { sanitizeHTML } = require("../core/render");

  test("strips known XSS vectors: <script>, on* handlers, javascript:, <iframe>", () => {
    const cases = [
      { in: '<p>Hello</p><script>alert("xss")</script>',         out: ["<p>Hello</p>"],  not: ["<script>"] },
      { in: '<p onclick="alert(1)">Click</p>',                   out: ["Click"],         not: ["onclick"] },
      { in: '<a href="javascript:alert(1)">link</a>',            out: [],                not: ["javascript:"] },
      { in: '<p>Text</p><iframe src="https://evil.com"></iframe>', out: ["Text"],         not: ["<iframe>"] },
    ];
    for (const c of cases) {
      const clean = sanitizeHTML(c.in);
      for (const w of c.out) expect(clean).toContain(w);
      for (const w of c.not) expect(clean).not.toContain(w);
    }
  });

  test("preserves safe markdown output", () => {
    const clean = sanitizeHTML("<h1>Title</h1><p><strong>Bold</strong></p>");
    expect(clean).toContain("<h1>");
    expect(clean).toContain("<strong>");
  });

  test("preserves disabled checkbox inputs (GFM task list)", () => {
    const clean = sanitizeHTML('<li><input disabled="" type="checkbox" checked> Task</li>');
    expect(clean).toContain('<input');
    expect(clean).toContain("checked");
    expect(clean).toContain("disabled");
  });
});

// ── renderToDocument ────────────────────────────────────────────────────

describe("renderToDocument", () => {
  const { renderToDocument } = require("../core/render");

  test("returns a head+body object", async () => {
    const html = await renderToDocument("# Hi", { font: "Inter" });
    expect(html).toHaveProperty("head");
    expect(html).toHaveProperty("body");
    expect(html.head).toContain("<head>");
    expect(html.head).toContain("</head>");
    expect(html.body).toContain('<body class="fw-render"');
    expect(html.body).toContain("</body>");
    expect(html.body).toContain("<main>");
    expect(html.head).toContain(".fw-render");
    expect(html.body).toContain("<h1>Hi</h1>");
    expect(html.head).not.toContain("<link ");
    expect(html.head).not.toContain("<meta ");
    expect(html.head).not.toContain("<title>");
    expect(html.head).not.toContain("<base ");
  });

  test("strips XSS in markdown and sanitizes font name (security)", async () => {
    const fromMd = await renderToDocument('<img src=x onerror=alert(1)>');
    expect(fromMd.body).not.toContain("onerror");
    const fromFont = await renderToDocument("# Hi", { font: "Inter; background:url(js:alert(1))" });
    expect(fromFont.head).not.toContain("javascript:");
    expect(fromFont.head).toContain("Inter");
  });

  test("scale tokens and absolute values both produce correct CSS", async () => {
    const scale = await renderToDocument("# Hi", { size: 1, weight: 1, line: 1 });
    expect(scale.head).toContain("font-size: 17px");
    expect(scale.head).toContain("font-weight: 600");
    expect(scale.head).toContain("line-height: 2");
    const abs = await renderToDocument("# Hi", { fontSize: 24, fontWeight: 700, lineHeight: 2.0 });
    expect(abs.head).toContain("font-size: 24px");
    expect(abs.head).toContain("font-weight: 700");
    expect(abs.head).toContain("line-height: 2");
  });

  test("clamps numeric values to documented ranges (fontSize 8-72, fontWeight 100-900, lineHeight 0.8-4.0)", async () => {
    const cases = [
      { opts: { fontSize: 999 },    want: "font-size: 72px" },
      { opts: { fontWeight: 9999 }, want: "font-weight: 900" },
      { opts: { lineHeight: 10 },   want: "line-height: 4" },
    ];
    for (const c of cases) {
      const html = await renderToDocument("# Hi", c.opts);
      expect(html.head).toContain(c.want);
    }
  });

  test("inlined font data URI is present for known font", async () => {
    const html = await renderToDocument("# Hi", { font: "Unbounded" });
    expect(html.head).toContain("@font-face");
    expect(html.head).toContain("data:font/woff2;base64,");
  });

  test("GFM task list checkboxes are preserved (regression)", async () => {
    const html = await renderToDocument("- [ ] Task 1\n- [x] Done task", { font: "Inter" });
    expect(html.body).toContain('<input');
    expect(html.body).toContain('type="checkbox"');
    expect(html.body).toContain("checked");
    expect(html.body).toContain("Task 1");
    expect(html.body).toContain("Done task");
    expect(html.head).toContain("input[type=\"checkbox\"]");
  });

  test("task-list items with numbered text do not create nested ordered lists (regression)", async () => {
    const cases = [
      "- [ ] 6. Add docs",
      "- [ ] \n\n   6. Add docs",
    ];
    for (const md of cases) {
      const html = await renderToDocument(md, { font: "Inter" });
      expect(html.body).toContain('<input');
      expect(html.body).toContain("6. Add docs");
      expect(html.body).toContain('class="task-list-item"');
      expect(html.body).not.toMatch(/<ol\s+start=/);
    }
  });
});

// ── resolveRenderOptions ────────────────────────────────────────────────

describe("resolveRenderOptions", () => {
  const { resolveRenderOptions } = require("../core/render");

  test("returns plain object with expected doc keys", () => {
    const fm = resolveRenderOptions({ title: "Test" });
    expect(typeof fm).toBe("object");
    const coerced = resolveRenderOptions({ font: 12345 });
    expect(coerced.font).toBe("12345");
  });

  test("strips special characters from font name (security)", () => {
    const fm = resolveRenderOptions({ font: "Inter<script>alert(1)</script>" });
    expect(fm.font).toBe("Interscriptalert1script");
  });

  test("scale indices take precedence over absolute values", () => {
    const fm = resolveRenderOptions({ size: 0, fontSize: 999 });
    expect(fm.fontSize).toBe(15);
  });
});

// ── resolveRelativeUrls ─────────────────────────────────────────────────

describe("resolveRelativeUrls", () => {
  const { resolveRelativeUrls } = require("../core/render");

  test("resolves relative image src against baseUrl", () => {
    const html = resolveRelativeUrls('<img src="./assets/x.png" alt="x">', "https://example.com/path/file.md");
    expect(html).toContain('src="https://example.com/path/assets/x.png"');
  });

  test("resolves parent-relative image src", () => {
    const html = resolveRelativeUrls('<img src="../assets/x.png" alt="x">', "https://example.com/path/file.md");
    expect(html).toContain('src="https://example.com/assets/x.png"');
  });

  test("leaves absolute URLs, data URIs, and link hrefs unchanged/resolved correctly", () => {
    const a = resolveRelativeUrls('<img src="https://other.com/x.png" alt="x">', "https://example.com/path/file.md");
    expect(a).toContain('src="https://other.com/x.png"');
    const d = resolveRelativeUrls('<img src="data:image/png;base64,ABC" alt="x">', "https://example.com/path/file.md");
    expect(d).toContain('src="data:image/png;base64,ABC"');
    const l = resolveRelativeUrls('<a href="./doc.md">link</a>', "https://example.com/path/file.md");
    expect(l).toContain('href="https://example.com/path/doc.md"');
  });
});

// ── renderToFragment (with baseUrl) ──────────────────────────────────────

describe("renderToFragment", () => {
  const { renderToFragment } = require("../core/render");

  test("resolves both markdown and HTML image src against baseUrl", () => {
    const base = "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md";
    const fromMd = renderToFragment("![ngl](./assets/app-screenshot.png)", { baseUrl: base });
    expect(fromMd).toContain('src="https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/app-screenshot.png"');
    const fromHtml = renderToFragment('<img src="assets/generations/x.jpg" width="400">', { baseUrl: base });
    expect(fromHtml).toContain('src="https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/generations/x.jpg"');
  });
});

// ── renderToDocument with baseUrl ───────────────────────────────────────

describe("renderToDocument with baseUrl", () => {
  const { renderToDocument } = require("../core/render");

  test("resolves relative image URLs (markdown + HTML) against baseUrl", async () => {
    const html = await renderToDocument(
      '![ngl](./assets/app-screenshot.png)\n\n<img src="assets/generations/x.jpg" width="400">',
      {},
      { baseUrl: "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md" }
    );
    expect(html.body).toContain("https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/app-screenshot.png");
    expect(html.body).toContain("https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/generations/x.jpg");
  });

  test("theme: data-theme attribute is HTML-escaped (defense in depth)", async () => {
    const html = await renderToDocument("# title", { theme: 'dark" onload="alert(1)' });
    expect(html.body).not.toContain('data-theme="dark" onload=');
    expect(html.body).not.toContain("<script>");
    expect(html.body).toMatch(/data-theme="[^"]*"/);
  });
});
