import { describe, test, expect, mock } from "bun:test";

// Mock req/res helpers
function mockReq({ method = "POST", headers = {}, body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : "";
  let _resolve;
  const stream = new ReadableStream({
    start(controller) {
      if (bodyStr) {
        controller.enqueue(new TextEncoder().encode(bodyStr));
      }
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
      if (event === "end") {
        reader.read().then(() => cb());
      }
      if (event === "error") {
        // no-op for tests
      }
    },
  };
}

function mockRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    status(code) {
      res._status = code;
      return res;
    },
    setHeader(key, value) {
      res._headers[key] = value;
    },
    json(data) {
      res._body = data;
      return res;
    },
    send(data) {
      res._body = data;
      return res;
    },
  };
  return res;
}

// Load the handler
const handler = require("../api/render.js");

describe("api/render.js", () => {
  test("valid payload returns 200 with <!DOCTYPE html>", async () => {
    const req = mockReq({
      headers: { "x-internal-key": "test-key" },
      body: { markdown: "# Hello\n\nWorld", title: "Test", framework: "spectre" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = "test-key";
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(typeof res._body).toBe("string");
    expect(res._body).toContain("<!DOCTYPE html>");
    expect(res._body).toContain("<h1>Hello</h1>");
    expect(res._headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  test("missing markdown returns 400", async () => {
    const req = mockReq({
      headers: { "x-internal-key": "test-key" },
      body: { title: "No content" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = "test-key";
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain("markdown");
  });

  test("missing X-Internal-Key returns 401", async () => {
    const req = mockReq({
      headers: {},
      body: { markdown: "# Hi" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = "test-key";
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe("Unauthorized");
  });

  test("wrong X-Internal-Key returns 401", async () => {
    const req = mockReq({
      headers: { "x-internal-key": "wrong-key" },
      body: { markdown: "# Hi" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = "test-key";
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test("GET method returns 405", async () => {
    const req = mockReq({
      method: "GET",
      headers: { "x-internal-key": "test-key" },
    });
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = "test-key";
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  test("invalid JSON body returns 400", async () => {
    const req = mockReq({
      headers: { "x-internal-key": "test-key" },
      body: null,
    });
    // Override to send invalid JSON
    req.on = (event, cb) => {
      if (event === "data") cb("not json {{{");
      if (event === "end") cb();
    };
    const res = mockRes();
    process.env.INTERNAL_RENDER_KEY = "test-key";
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain("JSON");
  });

  test("core/render.js exports are complete", () => {
    const { renderToDocument, renderToFragment, FRAMEWORK_CSS } = require("../core/render");
    expect(typeof renderToDocument).toBe("function");
    expect(typeof renderToFragment).toBe("function");
    expect(typeof FRAMEWORK_CSS).toBe("object");
    expect(FRAMEWORK_CSS.spectre).toContain("spectre");
  });
});
