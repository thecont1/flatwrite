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
  test("valid HMAC → 200 with <!DOCTYPE html>", async () => {
    const req = mockReq({
      headers: hmacHeaders(SECRET, "POST", "/api/render"),
      body: { markdown: "# Hello\n\nWorld", title: "Test", framework: "spectre" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = SECRET;
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(typeof res._body).toBe("string");
    expect(res._body).toContain("<!DOCTYPE html>");
    expect(res._body).toContain("<h1>Hello</h1>");
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

// ── core/render.js sanitization ─────────────────────────────────────────

describe("core/render.js exports", () => {
  test("exports are complete", () => {
    const { renderToDocument, renderToFragment, sanitizeHTML, FRAMEWORK_CSS } = require("../core/render");
    expect(typeof renderToDocument).toBe("function");
    expect(typeof renderToFragment).toBe("function");
    expect(typeof sanitizeHTML).toBe("function");
    expect(typeof FRAMEWORK_CSS).toBe("object");
    expect(FRAMEWORK_CSS.spectre).toContain("spectre");
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

describe("renderToDocument sanitization", () => {
  const { renderToDocument } = require("../core/render");

  test("XSS in markdown is stripped", () => {
    const html = renderToDocument('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("onerror");
  });

  test("XSS in title is escaped", () => {
    const html = renderToDocument("# Hi", { title: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("font name is sanitized", () => {
    const html = renderToDocument("# Hi", { font: "Inter; background:url(js:alert(1))" });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Inter");
  });

  test("fontSize is clamped to 8-72", () => {
    const html = renderToDocument("# Hi", { fontSize: "999" });
    expect(html).toContain("font-size: 72px");
  });

  test("fontWeight is clamped to 100-900", () => {
    const html = renderToDocument("# Hi", { fontWeight: "9999" });
    expect(html).toContain("font-weight: 900");
  });
});
