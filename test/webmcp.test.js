/**
 * Tests for public/webmcp.js. We can't run Chrome in CI, so we stub
 * navigator.modelContext with a minimal in-memory implementation that
 * captures registered tools and replays handler calls. The webmcp.js
 * script must:
 *
 *   1. Register both tools (render_markdown, render_markdown_from_url)
 *   2. Have a JSON Schema that requires the right fields
 *   3. Translate friendly aliases to canonical frontmatter
 *   4. Pre-flight validate fontFamily against the bundled inventory
 *   5. Pre-flight validate the markdown URL against the allowlist
 *   6. Return the rendered { head, body } JSON on success
 *   7. Mint a short-lived token from /mcp-token and send it as
 *      X-Mcp-Token (NOT X-Api-Key) — the long-lived key must never
 *      appear in shipped JS.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WEBMCP_JS = readFileSync(
  resolve(REPO_ROOT, "public/webmcp.js"),
  "utf-8",
);

/**
 * Build a Response-like object that satisfies the Fetch API the
 * webmcp.js script actually uses: `.ok`, `.status`, `.text()`,
 * `.json()`. We return this from the fake fetch in tests.
 */
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

/**
 * Build a sandbox with a stubbed navigator.modelContext that records
 * every registered tool, then evaluate webmcp.js inside it.
 *
 * The fakeFetch here is the "minimal" version: it returns a SENTINEL
 * error on any URL. Tests that need real token/render behavior use
 * sandboxWithFetch() below.
 */
function loadWebmcp() {
  const tools = [];
  const sandbox = {
    navigator: {
      modelContext: {
        registerTool(def) {
          tools.push(def);
        },
      },
    },
    // Pre-warm fetch (runs at page load): return a valid token.
    // Subsequent tool-call fetches that don't override this will
    // hit the SENTINEL — tests that need real behavior should use
    // sandboxWithFetch() instead.
    fetch: async () =>
      fakeResponse(200, { token: "fake.token", expiresAt: Math.floor(Date.now() / 1000) + 60 }),
    URL,
    console,
    Promise,
    Object,
  };
  const fn = new Function(
    "navigator", "fetch", "URL", "console", "Promise", "Object",
    WEBMCP_JS,
  );
  fn(
    sandbox.navigator, sandbox.fetch, sandbox.URL,
    sandbox.console, sandbox.Promise, sandbox.Object,
  );
  return tools;
}

function findTool(tools, name) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error("tool " + name + " not registered");
  return t;
}

function sandboxWithFetch(fetchImpl) {
  const tools = [];
  const sandbox = {
    navigator: {
      modelContext: { registerTool: (def) => tools.push(def) },
    },
    fetch: fetchImpl,
    URL, console, Promise, Object,
  };
  const fn = new Function(
    "navigator", "fetch", "URL", "console", "Promise", "Object",
    WEBMCP_JS,
  );
  fn(
    sandbox.navigator, sandbox.fetch, sandbox.URL,
    sandbox.console, sandbox.Promise, sandbox.Object,
  );
  return tools;
}

/**
 * A fakeFetch that mints a fake token on /mcp-token and otherwise
 * captures the request to /render and returns a successful render.
 */
function fakeFetchWithTokenMint() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.endsWith("/mcp-token")) {
      return fakeResponse(200, {
        token: "fake.token",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
    }
    if (url.endsWith("/render")) {
      return fakeResponse(200, { head: "<style/>", body: "<h1>Hi</h1>" });
    }
    throw new Error("unexpected URL: " + url);
  };
  return { fakeFetch, calls };
}

describe("webmcp.js — tool registration", () => {
  test("registers both render_markdown and render_markdown_from_url", () => {
    const tools = loadWebmcp();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "render_markdown",
      "render_markdown_from_url",
    ]);
  });

  test("render_markdown input schema requires markdown", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    expect(t.inputSchema.required).toContain("markdown");
    expect(t.inputSchema.properties.markdown.type).toBe("string");
    expect(t.inputSchema.properties.fontFamily.type).toBe("string");
    expect(t.inputSchema.properties.pageSize.type).toBe("string");
  });

  test("render_markdown_from_url input schema requires url", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown_from_url");
    expect(t.inputSchema.required).toContain("url");
  });

  test("tools are marked read-only", () => {
    const tools = loadWebmcp();
    for (const t of tools) {
      expect(t.annotations && t.annotations.readOnlyHint).toBe(true);
    }
  });

  test("does nothing when navigator.modelContext is absent", () => {
    const sandbox = {};
    const fn = new Function(
      "navigator", "URL", "console", "Promise", "Object",
      WEBMCP_JS,
    );
    fn(sandbox, URL, console, Promise, Object);
    expect(sandbox.tools).toBeUndefined();
  });

  test("does not embed a 64-char hex API key in the source", () => {
    // The shipped JS must not contain a 64-char hex blob — that's
    // the shape of the long-lived API key. This is a belt-and-braces
    // check; the auth test below is the stronger guarantee.
    const hex = WEBMCP_JS.match(/[0-9a-f]{60,}/g) || [];
    for (const blob of hex) {
      expect(blob).not.toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("inputSchema uses only valid JSON Schema types", () => {
    // WebMCP / JSON Schema don't have a top-level "enum" type. The
    // "enum" keyword is a sibling of "type", not a value for it.
    // Walking the schema we register, the only values that may appear
    // after "type:" are: "string", "number", "boolean", "object",
    // "array", "integer", "null". Anything else (especially "enum")
    // is invalid and may cause strict clients to reject the tool.
    const tools = loadWebmcp();
    const validTypes = new Set([
      "string", "number", "boolean", "object", "array", "integer", "null",
    ]);
    function walkSchema(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walkSchema(item);
        return;
      }
      if (typeof node.type === "string" && !validTypes.has(node.type)) {
        throw new Error("invalid JSON Schema type: " + node.type + " (expected one of " + Array.from(validTypes).join(", ") + ")");
      }
      // The "enum" keyword is valid as a sibling of "type" but only
      // on string/number/integer types. We use it only on the
      // orientation field, so the value list must be strings.
      if (Array.isArray(node.enum)) {
        for (const v of node.enum) {
          if (typeof v !== "string" && typeof v !== "number") {
            throw new Error("enum values must be strings or numbers");
          }
        }
      }
      for (const key of Object.keys(node)) walkSchema(node[key]);
    }
    for (const t of tools) walkSchema(t.inputSchema);
  });

  test("orientation enum is declared as type:string + enum (not type:enum)", () => {
    // Regression: an earlier version had `type: "enum"`, which is
    // not valid JSON Schema. Strict clients may reject the tool
    // registration. The orientation field must use
    // `type: "string"` with an `enum: [...]` sibling.
    const tools = loadWebmcp();
    for (const t of tools) {
      const orient = t.inputSchema.properties.orientation;
      expect(orient).toBeDefined();
      expect(orient.type).toBe("string");
      expect(orient.enum).toEqual(["portrait", "landscape"]);
    }
  });
});

describe("webmcp.js — render_markdown handler", () => {
  test("rejects empty/missing markdown with INVALID_INPUT", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(t.handler({})).rejects.toThrow(/INVALID_INPUT/);
    await expect(t.handler({ markdown: "" })).rejects.toThrow(/INVALID_INPUT/);
  });

  test("rejects unknown fontFamily with INVALID_FONT_FAMILY", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(
      t.handler({ markdown: "# Hi", fontFamily: "Comic Sans" }),
    ).rejects.toThrow(/INVALID_FONT_FAMILY/);
  });

  test("accepts every bundled font family (gets past validation, hits fetch)", async () => {
    const bundled = [
      "Inter", "JetBrains Mono", "Lato", "Lora",
      "Merriweather", "Playfair Display", "Comfortaa", "Unbounded",
    ];
    const tools = sandboxWithFetch(async () => {
      throw new Error("SENTINEL");
    });
    const t = findTool(tools, "render_markdown");
    for (const f of bundled) {
      await expect(
        t.handler({ markdown: "# Hi", fontFamily: f }),
      ).rejects.toThrow("SENTINEL");
    }
  });

  test("mints a token from /mcp-token and uses X-Mcp-Token (not X-Api-Key)", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    const result = await t.handler({
      markdown: "# Hi",
      fontFamily: "Comfortaa",
      framework: "spectre",
      pageSize: "A3",
      fontSize: 18,
      lineHeight: 1.6,
    });
    // First call: token mint.
    expect(calls[0].url).toContain("/mcp-token");
    expect(calls[0].init.method).toBe("POST");
    // Second call: render with the minted token.
    expect(calls[1].url).toBe("https://render.flatwrite.md/render");
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.headers["Content-Type"]).toBe("application/json");
    expect(calls[1].init.headers["X-Mcp-Token"]).toBe("fake.token");
    // CRITICAL: the long-lived key header must NOT be sent.
    expect(calls[1].init.headers["X-Api-Key"]).toBeUndefined();
    // Friendly aliases translated to canonical names
    expect(calls[1].body.font).toBe("Comfortaa");
    expect(calls[1].body.appFramework).toBe("spectre");
    expect(calls[1].body.fontSize).toBe(18);
    expect(calls[1].body.lineHeight).toBe(1.6);
    expect(calls[1].body.pageSize).toBe("A3");
    expect(calls[1].body.markdown).toBe("# Hi");
    // Public alias `fontFamily` should NOT leak onto the wire
    expect("fontFamily" in calls[1].body).toBe(false);
    // Result returns the head/body pair
    expect(result.head).toBe("<style/>");
    expect(result.body).toBe("<h1>Hi</h1>");
  });

  test("translates string scale tokens to canonical size/weight/line fields", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    await t.handler({
      markdown: "# Hi",
      fontFamily: "Playfair Display",
      fontSize: "-1",
      fontWeight: "-3",
      lineHeight: "0",
    });
    const renderCall = calls.find((c) => c.url.endsWith("/render"));
    expect(renderCall.body.font).toBe("Playfair Display");
    expect(renderCall.body.size).toBe("-1");
    expect(renderCall.body.weight).toBe("-3");
    expect(renderCall.body.line).toBe("0");
    expect(renderCall.body.fontSize).toBeUndefined();
    expect(renderCall.body.fontWeight).toBeUndefined();
    expect(renderCall.body.lineHeight).toBeUndefined();
  });

  test("forwards theme to the canonical frontmatter", async () => {
    // The theme field is advertised in the inputSchema and must be
    // forwarded to the canonical renderer. The previous version of
    // toCanonicalStyle() did NOT include theme in its passthrough
    // list, so callers who set theme: "dark" believed it was applied
    // when it was silently dropped. This test pins the fix.
    let captured = null;
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    await t.handler({
      markdown: "# Theme test",
      theme: "dark",
    });
    const renderCall = calls.find((c) => c.url.endsWith("/render"));
    expect(renderCall.body.theme).toBe("dark");
  });
});

describe("webmcp.js — render_markdown_from_url handler", () => {
  test("rejects URL on a disallowed host with DISALLOWED_HOST", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown_from_url");
    await expect(
      t.handler({ url: "https://github.com/foo/bar/blob/main/README.md" }),
    ).rejects.toThrow(/DISALLOWED_HOST/);
  });

  test("rejects ftp:// URL with UNSUPPORTED_SCHEME", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown_from_url");
    await expect(
      t.handler({ url: "ftp://example.com/file.md" }),
    ).rejects.toThrow(/UNSUPPORTED_SCHEME/);
  });

  test("rejects malformed URL with INVALID_URL", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown_from_url");
    await expect(
      t.handler({ url: "not a url at all" }),
    ).rejects.toThrow(/INVALID_URL/);
  });

  test("accepts an allowlisted URL, mints a token, and forwards markdownUrl", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown_from_url");
    const result = await t.handler({
      url: "https://raw.githubusercontent.com/foo/bar/main/README.md",
      fontFamily: "Comfortaa",
    });
    const renderCall = calls.find((c) => c.url.endsWith("/render"));
    expect(renderCall.body.markdownUrl).toBe(
      "https://raw.githubusercontent.com/foo/bar/main/README.md",
    );
    expect(renderCall.body.font).toBe("Comfortaa");
    expect(renderCall.init.headers["X-Mcp-Token"]).toBe("fake.token");
    expect(renderCall.init.headers["X-Api-Key"]).toBeUndefined();
    expect(result.body).toBe("<h1>Hi</h1>");
  });
});
