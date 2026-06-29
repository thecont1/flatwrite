/**
 * Worker logic tests — exercise the default export of
 * `workers/flatwrite-render/src/index.js` directly without a CF runtime.
 *
 * Strategy:
 *   - Replace the global `fetch` with a mock that emulates the upstream
 *     /api/render handler.
 *   - Capture the request the Worker sends (path, headers, body).
 *   - Assert response status, Content-Type, and JSON body shape.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

const KEY = "test-api-key";
const SECRET = "test-internal-key-do-not-use-in-prod";

// ── Helpers ──────────────────────────────────────────────────────────────

function req({ method = "POST", headers = {}, body = null } = {}) {
  return new Request("https://render.flatwrite.md/render", {
    method,
    headers,
    body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function loadWorker() {
  // The Worker source uses ESM-only `js-yaml`. Importing it from a test
  // through Bun's ESM loader works fine.
  return import("../workers/flatwrite-render/src/index.js");
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
        JSON.stringify({ head: "<style/>", body: "<main/>" }),
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("Worker auth + method", () => {
  test("rejects GET", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(req({ method: "GET" }), {
      API_KEY: KEY,
      INTERNAL_RENDER_KEY: SECRET,
    });
    expect(resp.status).toBe(405);
    const body = await resp.json();
    expect(body).toEqual({ error: "POST only", code: "METHOD_NOT_ALLOWED" });
  });

  test("rejects missing API key", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({ headers: { "Content-Type": "application/json" }, body: { markdown: "x" } }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body).toEqual({ error: "Unauthorized", code: "UNAUTHORIZED" });
  });

  test("rejects wrong API key", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": "wrong",
        },
        body: { markdown: "x" },
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("OPTIONS preflight returns 204 with restricted CORS for trusted origin", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({ method: "OPTIONS", headers: { Origin: "https://flatwrite.md" } }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(204);
    // Trusted origin: ACAO echoes the request origin, NOT "*".
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("https://flatwrite.md");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    // The X-Api-Key header is intentionally NOT advertised to browsers.
    const allow = resp.headers.get("Access-Control-Allow-Headers") || "";
    expect(allow.toLowerCase()).not.toContain("x-api-key");
    expect(allow.toLowerCase()).toContain("x-mcp-token");
  });

  test("OPTIONS preflight returns 204 for *.flatwrite.md subdomain", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({ method: "OPTIONS", headers: { Origin: "https://mcp.flatwrite.md" } }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("https://mcp.flatwrite.md");
  });

  test("OPTIONS preflight omits CORS for untrusted origin", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({ method: "OPTIONS", headers: { Origin: "https://attacker.example" } }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(204);
    // Untrusted origin: no ACAO header at all.
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("OPTIONS preflight omits CORS for malformed flatwrite.md origin", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({ method: "OPTIONS", headers: { Origin: "https://evil.flatwrite.md.attacker.example" } }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("POST rejects X-Api-Key from a browser (server-to-server only)", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": KEY,
          Origin: "https://flatwrite.md",
        },
        body: { markdown: "# hi" },
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.code).toBe("API_KEY_NOT_ALLOWED_FROM_BROWSER");
  });
});

describe("JSON path", () => {
  test("forwards JSON body to /api/render and returns {head, body}", async () => {
    upstreamResponder = () =>
      new Response(
        JSON.stringify({ head: "<style/>", body: "<main>ok</main>" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": KEY,
        },
        body: { markdown: "# hi", framework: "spectre" },
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/application\/json/);
    const json = await resp.json();
    expect(json).toEqual({ head: "<style/>", body: "<main>ok</main>" });

    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0];
    expect(call.url).toBe("https://flatwrite.md/api/render");
    expect(call.opts.method).toBe("POST");
    const parsed = JSON.parse(call.opts.body);
    expect(parsed).toEqual({ markdown: "# hi", framework: "spectre" });
    expect(call.opts.headers["X-Render-Signature"]).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(call.opts.headers["X-Render-Timestamp"])).toBeGreaterThan(0);
  });

  test("rejects JSON without markdown or markdownUrl", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": KEY,
        },
        body: { framework: "spectre" },
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe("MISSING_CONTENT");
    expect(upstreamCalls).toHaveLength(0);
  });

  test("rejects malformed JSON", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": KEY,
        },
        body: "{not-json",
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe("INVALID_JSON");
  });

  test("rejects unsupported media type", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "text/plain",
          "X-Api-Key": KEY,
        },
        body: "hello",
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(415);
    const body = await resp.json();
    expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  test("forwards upstream rate-limit headers and structured errors", async () => {
    upstreamResponder = () =>
      new Response(
        JSON.stringify({ error: "Rate limit exceeded", code: "RATE_LIMIT", retryAfter: 42 }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "Retry-After": "42",
          },
        },
      );
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": KEY,
        },
        body: { markdown: "x" },
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(429);
    expect(resp.headers.get("x-ratelimit-limit")).toBe("60");
    expect(resp.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(resp.headers.get("retry-after")).toBe("42");
    const body = await resp.json();
    expect(body.code).toBe("RATE_LIMIT");
    expect(body.retryAfter).toBe(42);
  });

  test("returns UPSTREAM_UNREACHABLE when fetch throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": KEY,
        },
        body: { markdown: "x" },
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.code).toBe("UPSTREAM_UNREACHABLE");
  });
});

describe("YAML path", () => {
  test("reads yaml, fetches markdownUrl, forwards JSON to /api/render", async () => {
    const yamlBody = "url: https://example.com/doc.md\nframework: oat\n";
    const calls = [];
    globalThis.fetch = mock(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url) === "https://example.com/doc.md") {
        return new Response("# hello", {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        });
      }
      return new Response(
        JSON.stringify({ head: "<style/>", body: "<main>hello</main>" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "text/yaml",
          "X-Api-Key": KEY,
        },
        body: yamlBody,
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ head: "<style/>", body: "<main>hello</main>" });

    const upstream = calls.find((c) => c.url === "https://flatwrite.md/api/render");
    expect(upstream).toBeTruthy();
    const parsed = JSON.parse(upstream.opts.body);
    expect(parsed.markdown).toBe("# hello");
    expect(parsed.markdownUrl).toBe("https://example.com/doc.md");
    expect(parsed.framework).toBe("oat");
  });

  test("rejects YAML without `url`", async () => {
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "text/yaml",
          "X-Api-Key": KEY,
        },
        body: "framework: oat\n",
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe("MISSING_CONTENT");
  });

  test("reports UPSTREAM_FETCH_FAILED when markdownUrl fetch fails", async () => {
    globalThis.fetch = mock(async (url) => {
      if (String(url) === "https://example.com/missing.md") {
        return new Response("not found", { status: 404 });
      }
      throw new Error("should not reach upstream");
    });
    const { default: worker } = await loadWorker();
    const resp = await worker.fetch(
      req({
        headers: {
          "Content-Type": "application/yaml",
          "X-Api-Key": KEY,
        },
        body: "url: https://example.com/missing.md\n",
      }),
      { API_KEY: KEY, INTERNAL_RENDER_KEY: SECRET },
    );
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.code).toBe("UPSTREAM_FETCH_FAILED");
  });
});
