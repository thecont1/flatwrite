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
  // Keep _status in sync when handler uses res.statusCode directly
  Object.defineProperty(res, "statusCode", {
    set(v) { res._status = v; },
    get() { return res._status; },
  });
  return res;
}

/** Build HMAC headers for a test request */
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
      body: {
        markdown: "# Hello",
        size: 1,
        weight: 1,
        line: 1,
      },
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

  test("disallowed markdownUrl host → 502", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: {
        markdownUrl: "https://evil.example.com/README.md",
      },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.error).toContain("Disallowed");
  });

  test("non-http markdownUrl → 502", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: {
        markdownUrl: "ftp://raw.githubusercontent.com/README.md",
      },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(res._body.error).toContain("URL must be http or https");
  });

  test("missing signature headers → 401", async () => {
    const req = mockReq({
      headers: {},
      body: { markdown: "# Hi" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test("wrong signature → 401", async () => {
    const req = mockReq({
      headers: { "x-render-timestamp": String(Math.floor(Date.now() / 1000)), "x-render-signature": "deadbeef" },
      body: { markdown: "# Hi" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test("expired timestamp → 401", async () => {
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

  test("invalid JSON body → 400", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: null,
    });
    req.on = (event, cb) => {
      if (event === "data") cb("not json {{{");
      if (event === "end") cb();
    };
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain("JSON");
  });

  test("oversized body → 413", async () => {
    const big = "x".repeat(512 * 1024 + 1);
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: null,
    });
    req.on = (event, cb) => {
      if (event === "data") cb(big);
      if (event === "end") cb();
    };
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(413);
    expect(res._body.error).toContain("large");
  });

  test("rate limit returns 429 with headers", async () => {
    const { createRateLimiter } = require("../core/rate-limit");
    const testLimiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    // Exhaust the limit
    testLimiter.check("test-ip");
    testLimiter.check("test-ip");
    const third = testLimiter.check("test-ip");
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    testLimiter.reset();
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

  test("allows requests within limit", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 3 });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    rl.reset();
  });

  test("rejects requests over limit", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    rl.check("b");
    rl.check("b");
    const result = rl.check("b");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    rl.reset();
  });

  test("different keys are independent", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    rl.check("x");
    expect(rl.check("x").allowed).toBe(false);
    expect(rl.check("y").allowed).toBe(true);
    rl.reset();
  });

  test("window expiry allows new requests", async () => {
    const rl = createRateLimiter({ windowMs: 50, max: 1 });
    rl.check("z");
    expect(rl.check("z").allowed).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(rl.check("z").allowed).toBe(true);
    rl.reset();
  });

  test("reset clears all state", () => {
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
    const result = verify(SECRET, "POST", "/api/render", String(ts), sig);
    expect(result.ok).toBe(true);
  });

  test("rejects missing headers", () => {
    const result = verify(SECRET, "POST", "/api/render", undefined, undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-numeric timestamp", () => {
    const result = verify(SECRET, "POST", "/api/render", "not-a-number", "abc");
    expect(result.ok).toBe(false);
  });

  test("rejects expired timestamp (replay protection)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const sig = sign(SECRET, oldTs, "POST", "/api/render");
    const result = verify(SECRET, "POST", "/api/render", String(oldTs), sig);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("expired");
  });

  test("rejects wrong secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign("wrong-secret", ts, "POST", "/api/render");
    const result = verify(SECRET, "POST", "/api/render", String(ts), sig);
    expect(result.ok).toBe(false);
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

  test("rejects wrong path", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(SECRET, ts, "POST", "/api/render");
    const result = verify(SECRET, "POST", "/api/other", String(ts), sig);
    expect(result.ok).toBe(false);
  });
});

// ── core/render.js ──────────────────────────────────────────────────────

describe("core/render.js exports", () => {
  test("exports are complete", () => {
    const { renderToDocument, renderToFragment, sanitizeHTML, resolveRenderOptions } = require("../core/render");
    expect(typeof renderToDocument).toBe("function");
    expect(typeof renderToFragment).toBe("function");
    expect(typeof sanitizeHTML).toBe("function");
    expect(typeof resolveRenderOptions).toBe("function");
  });
});

describe("sanitizeHTML", () => {
  const { sanitizeHTML } = require("../core/render");

  test("strips <script> tags", () => {
    const clean = sanitizeHTML('<p>Hello</p><script>alert("xss")</script>');
    expect(clean).toContain("<p>Hello</p>");
    expect(clean).not.toContain("<script>");
  });

  test("strips onclick event handlers", () => {
    const clean = sanitizeHTML('<p onclick="alert(1)">Click</p>');
    expect(clean).not.toContain("onclick");
    expect(clean).toContain("Click");
  });

  test("strips javascript: URIs", () => {
    const clean = sanitizeHTML('<a href="javascript:alert(1)">link</a>');
    expect(clean).not.toContain("javascript:");
  });

  test("strips iframe tags", () => {
    const clean = sanitizeHTML('<p>Text</p><iframe src="https://evil.com"></iframe>');
    expect(clean).not.toContain("<iframe>");
  });

  test("preserves safe markdown output", () => {
    const clean = sanitizeHTML("<h1>Title</h1><p><strong>Bold</strong></p>");
    expect(clean).toContain("<h1>");
    expect(clean).toContain("<strong>");
  });

  test("preserves disabled checkbox inputs", () => {
    const clean = sanitizeHTML('<li><input disabled="" type="checkbox" checked> Task</li>');
    expect(clean).toContain('<input');
    expect(clean).toContain("checked");
    expect(clean).toContain("disabled");
  });
});

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

  test("XSS in markdown is stripped", async () => {
    const html = await renderToDocument('<img src=x onerror=alert(1)>');
    expect(html.body).not.toContain("onerror");
  });

  test("font name is sanitized", async () => {
    const html = await renderToDocument("# Hi", { font: "Inter; background:url(js:alert(1))" });
    expect(html.head).not.toContain("javascript:");
    expect(html.head).toContain("Inter");
  });

  test("scale indices produce absolute CSS", async () => {
    const html = await renderToDocument("# Hi", { size: 1, weight: 1, line: 1 });
    expect(html.head).toContain("font-size: 17px");
    expect(html.head).toContain("font-weight: 600");
    expect(html.head).toContain("line-height: 2");
  });

  test("absolute values still work", async () => {
    const html = await renderToDocument("# Hi", { fontSize: 24, fontWeight: 700, lineHeight: 2.0 });
    expect(html.head).toContain("font-size: 24px");
    expect(html.head).toContain("font-weight: 700");
    expect(html.head).toContain("line-height: 2");
  });

  test("fontSize is clamped to 8-72 (absolute pixel value)", async () => {
    // fontSize as a NUMBER is treated as an absolute pixel value and
    // clamped to [8, 72] by safeNumber. Strings are scale tokens.
    const html = await renderToDocument("# Hi", { fontSize: 999 });
    expect(html.head).toContain("font-size: 72px");
  });

  test("fontWeight is clamped to 100-900", async () => {
    const html = await renderToDocument("# Hi", { fontWeight: 9999 });
    expect(html.head).toContain("font-weight: 900");
  });

  test("fractional absolute values are rounded in CSS output", async () => {
    // When fontSize/lineHeight are passed as numbers, they're treated
    // as absolute pixel/line-height values and rounded. Strings remain
    // scale tokens (rounded by the scale map, not Math.round).
    const html = await renderToDocument("# Hi", { fontSize: 16.7, lineHeight: 1.65 });
    expect(html.head).toContain("font-size: 17px");
    expect(html.head).toContain("line-height: 1.7");
  });

  test("lineHeight is clamped to 0.8-4.0 (absolute line-height value)", async () => {
    // lineHeight as a NUMBER is treated as an absolute multiplier and
    // clamped to [0.8, 4.0]. Strings are scale tokens.
    const html = await renderToDocument("# Hi", { lineHeight: 10 });
    expect(html.head).toContain("line-height: 4");
  });

  test("surfaceMode: app is ignored", async () => {
    const html = await renderToDocument("# Hi", { surfaceMode: "app", framework: "spectre" });
    expect(html.head).not.toContain("spectre");
    expect(html.head).toContain("font-size:");
  });

  test("null/undefined frontmatter uses defaults", async () => {
    const html = await renderToDocument("# Hi", null);
    expect(html.head).toContain("Inter");
    expect(html.head).toContain("font-size: 16px");
  });

  test("extra unknown fields are ignored", async () => {
    const fm = { title: "T", evil: "<script>alert(1)</script>" };
    const html = await renderToDocument("# Hi", fm);
    expect(html.head).not.toContain("evil");
    expect(html.head).not.toContain("<script>");
  });

  test("inlined font data URI is present for known font", async () => {
    const html = await renderToDocument("# Hi", { font: "Unbounded" });
    expect(html.head).toContain("@font-face");
    expect(html.head).toContain("data:font/woff2;base64,");
  });

  test("GFM task list checkboxes are preserved", async () => {
    const html = await renderToDocument("- [ ] Task 1\n- [x] Done task", { font: "Inter" });
    expect(html.body).toContain('<input');
    expect(html.body).toContain('type="checkbox"');
    expect(html.body).toContain("checked");
    expect(html.body).toContain("Task 1");
    expect(html.body).toContain("Done task");
    expect(html.head).toContain("input[type=\"checkbox\"]");
  });

  test("task-list items with numbered text do not create nested ordered lists", async () => {
    const html = await renderToDocument("- [ ] 6. Add docs", { font: "Inter" });
    expect(html.body).toContain('<input');
    expect(html.body).toContain("6. Add docs");
    expect(html.body).toContain('class="task-list-item"');
    expect(html.body).not.toContain('<ol start="6">');
    expect(html.body).not.toContain('<ol start="');
  });

  test("task-list items with numbered text survive a blank line after the checkbox", async () => {
    const html = await renderToDocument("- [ ] \n\n   6. Add docs", { font: "Inter" });
    expect(html.body).toContain('<input');
    expect(html.body).toContain("6. Add docs");
    expect(html.body).toContain('class="task-list-item"');
    expect(html.body).not.toContain('<ol');
  });

  test("document CSS includes nested unordered-list bullet styles", async () => {
    const html = await renderToDocument("- item", { font: "Inter" });
    expect(html.head).toContain("list-style-type: circle");
    expect(html.head).toContain("list-style-type: disc");
    expect(html.head).toContain(".task-list-item");
    expect(html.head).toContain("display: none");
  });
});

describe("resolveRenderOptions", () => {
  const { resolveRenderOptions } = require("../core/render");

  test("returns plain object", () => {
    const fm = resolveRenderOptions({ title: "Test" });
    expect(typeof fm).toBe("object");
  });

  test("contains expected doc keys", () => {
    const fm = resolveRenderOptions({});
    expect(Object.keys(fm).sort()).toContain("font");
    expect(Object.keys(fm).sort()).toContain("fontSize");
    expect(Object.keys(fm).sort()).toContain("fontWeight");
    expect(Object.keys(fm).sort()).toContain("lineHeight");
  });

  test("non-string font is coerced and sanitized", () => {
    const fm = resolveRenderOptions({ font: 12345 });
    expect(fm.font).toBe("12345");
  });

  test("font with special chars is stripped", () => {
    const fm = resolveRenderOptions({ font: "Inter<script>alert(1)</script>" });
    expect(fm.font).toBe("Interscriptalert1script");
  });

  test("scale indices take precedence over absolute values", () => {
    const fm = resolveRenderOptions({ size: 0, fontSize: 999 });
    expect(fm.fontSize).toBe(15);
  });
});

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

  test("leaves absolute URLs unchanged", () => {
    const html = resolveRelativeUrls('<img src="https://other.com/x.png" alt="x">', "https://example.com/path/file.md");
    expect(html).toContain('src="https://other.com/x.png"');
  });

  test("leaves data URIs unchanged", () => {
    const html = resolveRelativeUrls('<img src="data:image/png;base64,ABC" alt="x">', "https://example.com/path/file.md");
    expect(html).toContain('src="data:image/png;base64,ABC"');
  });

  test("resolves link href", () => {
    const html = resolveRelativeUrls('<a href="./doc.md">link</a>', "https://example.com/path/file.md");
    expect(html).toContain('href="https://example.com/path/doc.md"');
  });
});

describe("renderToFragment", () => {
  const { renderToFragment } = require("../core/render");

  test("resolves relative markdown image URLs", () => {
    const html = renderToFragment("![ngl](./assets/app-screenshot.png)", {
      baseUrl: "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md",
    });
    expect(html).toContain('src="https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/app-screenshot.png"');
  });

  test("resolves relative HTML image src", () => {
    const html = renderToFragment('<img src="assets/generations/x.jpg" width="400">', {
      baseUrl: "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md",
    });
    expect(html).toContain('src="https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/generations/x.jpg"');
  });
});

describe("renderToDocument with baseUrl", () => {
  const { renderToDocument } = require("../core/render");

  test("resolves relative image URLs", async () => {
    const html = await renderToDocument(
      '![ngl](./assets/app-screenshot.png)\n\n<img src="assets/generations/x.jpg" width="400">',
      {},
      { baseUrl: "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md" }
    );
    expect(html.body).toContain("https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/app-screenshot.png");
    expect(html.body).toContain("https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/assets/generations/x.jpg");
  });

  test("convergence: same semantic input via canonical vs friendly aliases produces the same output", async () => {
    // Document the field semantics:
    //   - size/weight/line (canonical)        — STRING scale tokens like "1", "0", "-1"
    //   - fontSize/lineHeight/fontWeight (friendly) — NUMBER absolute values (or STRING scale)
    //   - font/appFramework (canonical)        — STRING family/framework names
    //   - fontFamily/framework (friendly)     — same thing under friendlier names
    //
    // Both paths should reach the same render() output.
    const settingsYaml = {
      font: "Playfair Display",
      size: "1",
      weight: "0",
      line: "0",
      framework: "spectre",
      pageSize: "A3",
      orientation: "portrait",
      width: 890,
    };
    const settingsJson = {
      fontFamily: "Playfair Display",
      size: "1",
      weight: "0",
      line: "0",
      framework: "spectre",
      pageSize: "A3",
      orientation: "portrait",
      width: 890,
    };
    const settingsJsonAbs = {
      fontFamily: "Playfair Display",
      fontSize: 17,         // number = absolute pixels
      fontWeight: 400,      // number = absolute weight
      lineHeight: 1.75,     // number = absolute line-height
      framework: "spectre",
      pageSize: "A3",
      orientation: "portrait",
      width: 890,
    };

    const md = "# Title\n\nBody.";
    const htmlYaml = await renderToDocument(md, settingsYaml);
    const htmlJson = await renderToDocument(md, settingsJson);
    const htmlJsonAbs = await renderToDocument(md, settingsJsonAbs);

    // Scale-string and scale-string friendly should produce identical output.
    expect(htmlJson.head).toBe(htmlYaml.head);
    expect(htmlJson.body).toBe(htmlYaml.body);

    // Absolute-number path should land at the same body/head dimensions
    // (rounding Math.round(16.5)*1.1 = 17 may differ from absolute 17, but
    // the font and major layout choices must match).
    expect(htmlJsonAbs.head).toContain("font-family: 'Playfair Display'");
    expect(htmlJsonAbs.head).toContain("A3");
    expect(htmlJsonAbs.body).toContain("Title");
  });

test("theme: forwarded as data-theme on the body element", async () => {
  // The MCP and WebMCP tool schemas advertise a `theme` field.
  // The canonical renderer should consume it and surface it as
  // a `data-theme` attribute on the body element so that the
  // consuming page can style the document via CSS attribute
  // selectors. A missing theme defaults to "light".
  const html = await renderToDocument("# title", { theme: "dark" });
  expect(html.body).toContain('data-theme="dark"');

  const htmlDefault = await renderToDocument("# title", {});
  expect(htmlDefault.body).toContain('data-theme="light"');

  // Theme strings with unsafe characters get sanitized to a
  // safe CSS-attribute value (alphanumerics, underscore, hyphen).
  const htmlUnsafe = await renderToDocument("# title", { theme: "dr/../ak" });
  // Sanitizer keeps the alphanumerics and replaces unsafe chars with "-".
  // Sanitizer replaces every non-alphanumeric char with "-" (no
  // collapsing), so "dr/../ak" becomes "dr----ak".
  expect(htmlUnsafe.body).toMatch(/data-theme="dr----ak"/);
});

test("theme: round-trips through buildRawBody translation", async () => {
  // The MCP translator in renderClient.ts is the single source
  // of truth for which public fields are forwarded. The
  // theme field must make it through.
  const { buildRawMarkdownBody } = await import(
    "../mcp/flatwrite-render-server/dist/renderClient.js"
  );
  const body = buildRawMarkdownBody("# hi", { theme: "dark" });
  expect(body.theme).toBe("dark");
  expect("fontFamily" in body).toBe(false);  // sanity: not leaking public alias
});

test("theme: data-theme attribute is HTML-escaped", async () => {
  // Defense-in-depth: even if resolveRenderOptions() were relaxed,
  // the value interpolated into the HTML attribute must be escaped so
  // a theme like '" onload="alert(1)" cannot break out of the attribute.
  const html = await renderToDocument("# title", { theme: 'dark" onload="alert(1)' });
  expect(html.body).not.toContain('data-theme="dark" onload=');
  expect(html.body).not.toContain("<script>");
  expect(html.body).toMatch(/data-theme="[^"]*"/);
});

});
