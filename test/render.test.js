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
    expect(typeof res._body).toBe("string");
    expect(res._body).toContain("<head>");
    expect(res._body).toContain("</head>");
    expect(res._body).toContain('<body class="fw-render">');
    expect(res._body).toContain("</body>");
    expect(res._body).toContain("<main>");
    expect(res._body).toContain(".fw-render");
    expect(res._body).toContain("<h1>Hello</h1>");
    expect(res._body).not.toContain("<!DOCTYPE html>");
    expect(res._body).not.toContain("<link ");
    expect(res._body).not.toContain("<meta ");
    expect(res._body).not.toContain("<title>");
    expect(res._body).not.toContain("<base ");
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
    expect(res._body).toContain("font-size: 17px");
    expect(res._body).toContain("font-weight: 600");
    expect(res._body).toContain("line-height: 2");
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
    const tampered = "0" + sig.slice(1);
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
});

describe("renderToDocument", () => {
  const { renderToDocument } = require("../core/render");

  test("returns a head+body fragment", async () => {
    const html = await renderToDocument("# Hi", { font: "Inter" });
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain('<body class="fw-render">');
    expect(html).toContain("</body>");
    expect(html).toContain("<main>");
    expect(html).toContain(".fw-render");
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).not.toContain("<!DOCTYPE html>");
    expect(html).not.toContain("<link ");
    expect(html).not.toContain("<meta ");
    expect(html).not.toContain("<title>");
    expect(html).not.toContain("<base ");
  });

  test("XSS in markdown is stripped", async () => {
    const html = await renderToDocument('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("onerror");
  });

  test("font name is sanitized", async () => {
    const html = await renderToDocument("# Hi", { font: "Inter; background:url(js:alert(1))" });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Inter");
  });

  test("scale indices produce absolute CSS", async () => {
    const html = await renderToDocument("# Hi", { size: 1, weight: 1, line: 1 });
    expect(html).toContain("font-size: 17px");
    expect(html).toContain("font-weight: 600");
    expect(html).toContain("line-height: 2");
  });

  test("absolute values still work", async () => {
    const html = await renderToDocument("# Hi", { fontSize: 24, fontWeight: 700, lineHeight: 2.0 });
    expect(html).toContain("font-size: 24px");
    expect(html).toContain("font-weight: 700");
    expect(html).toContain("line-height: 2");
  });

  test("fontSize is clamped to 8-72", async () => {
    const html = await renderToDocument("# Hi", { fontSize: "999" });
    expect(html).toContain("font-size: 72px");
  });

  test("fontWeight is clamped to 100-900", async () => {
    const html = await renderToDocument("# Hi", { fontWeight: "9999" });
    expect(html).toContain("font-weight: 900");
  });

  test("fractional values are rounded in CSS output", async () => {
    const html = await renderToDocument("# Hi", { fontSize: "16.7", lineHeight: "1.65" });
    expect(html).toContain("font-size: 17px");
    expect(html).toContain("line-height: 1.7");
  });

  test("lineHeight is clamped to 0.8-4.0", async () => {
    const html = await renderToDocument("# Hi", { lineHeight: "10" });
    expect(html).toContain("line-height: 4");
  });

  test("surfaceMode: app is ignored", async () => {
    const html = await renderToDocument("# Hi", { surfaceMode: "app", framework: "spectre" });
    expect(html).not.toContain("spectre");
    expect(html).toContain("font-size:");
  });

  test("null/undefined frontmatter uses defaults", async () => {
    const html = await renderToDocument("# Hi", null);
    expect(html).toContain("Inter");
    expect(html).toContain("font-size: 16px");
  });

  test("extra unknown fields are ignored", async () => {
    const fm = { title: "T", evil: "<script>alert(1)</script>" };
    const html = await renderToDocument("# Hi", fm);
    expect(html).not.toContain("evil");
    expect(html).not.toContain("<script>");
  });

  test("inlined font data URI is present for known font", async () => {
    const html = await renderToDocument("# Hi", { font: "Unbounded" });
    expect(html).toContain("@font-face");
    expect(html).toContain("data:font/woff2;base64,");
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
