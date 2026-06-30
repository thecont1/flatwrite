/**
 * Tests for public/webmcp.js. We can't run Chrome in CI, so we stub
 * document.modelContext with a minimal in-memory implementation that
 * captures registered tools and replays execute calls. The webmcp.js
 * script must:
 *
 *   1. Register render_markdown and list_render_options tools
 *   2. Have a JSON Schema that requires markdown or markdownUrl
 *   3. Translate friendly aliases to canonical frontmatter
 *   4. Pre-flight validate fontFamily against the bundled inventory
 *   5. Pre-flight validate the markdown URL against the allowlist
 *   6. Return the rendered { head, body } JSON on success
 *   7. Mint a short-lived token from /mcp-token and send it as
 *      X-Mcp-Token (NOT X-Api-Key) — the long-lived key must never
 *      appear in shipped JS.
 *   8. Call the executor as `t.execute(args)` — Chrome's WebMCP API
 *      uses the `execute` property on a registered tool. The previous
 *      version of webmcp.js used `handler`, which threw inside
 *      registerTool() and prevented BOTH tools from registering.
 *   9. Register via `document.modelContext` (Chrome 150+ spec shape)
 *      OR `navigator.modelContext` (Chrome 149 DevTrial legacy shape) —
 *      whichever is present, in that preference order. Chrome 149
 *      (the DevTrial release that was live at the time of writing)
 *      exposed WebMCP only on `navigator`, while Chrome 150+ moved
 *      it to `document`. A single-namespace probe was a silent no-op
 *      on whichever build we hadn't probed. Reference:
 *      nekuda.ai/scripts/webmcp.js probes both in the same order.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WEBMCP_JS = readFileSync(
  resolve(REPO_ROOT, "public/webmcp.js"),
  "utf-8",
);
const WEBMCP_SHARED_JS = readFileSync(
  resolve(REPO_ROOT, "public/webmcp-shared.js"),
  "utf-8",
);

/**
 * Build a single evaluable script from the ES-module webmcp.js and its
 * shared dependency. The shared module is stripped of `export` so it
 * works as a script, and webmcp.js's import line is removed.
 */
function bundleWebmcpForEval() {
  const shared = WEBMCP_SHARED_JS
    .replace(/export const /g, "const ")
    .replace(/export async function /g, "async function ")
    .replace(/export function /g, "function ");
  const webmcp = WEBMCP_JS.replace(
    /import\s+\{[^}]+\}\s+from\s+['"]\.\/webmcp-shared\.js(?:\?[^'"]*)?['"]\s*;?\n/,
    "",
  );
  return shared + "\n" + webmcp;
}

const EVALUABLE_WEBMCP_JS = bundleWebmcpForEval();

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
 * Build a sandbox with a stubbed document.modelContext that records
 * every registered tool, then evaluate webmcp.js inside it.
 *
 * The fakeFetch here is the "minimal" version: it returns a SENTINEL
 * error on any URL. Tests that need real token/render behavior use
 * sandboxWithFetch() below.
 *
 * Tests that exercise the tool function call it as `t.execute(args)`
 * — mirroring the WebMCP spec property name Chrome 146+ expects.
 *
 * NOTE: we also leave `navigator.modelContext` UNDEFINED in the
 * sandbox. The regression test "uses document.modelContext, not
 * navigator.modelContext" depends on that — if webmcp.js ever flips
 * back to the wrong namespace, the guard fires and the script silently
 * bails, registering zero tools. We detect that.
 */
function loadWebmcp() {
  // Default: Chrome 150+ (document.modelContext). Tests that need to
  // simulate Chrome 149 use loadWebmcpChrome149() below.
  return loadWebmcpWithSandbox({});
}

/**
 * Chrome 149 DevTrial release exposed WebMCP under navigator.modelContext
 * (the now-deprecated shape). The current spec moves it to
 * document.modelContext. webmcp.js must probe both. This loader
 * exercises the Chrome 149 code path.
 */
function loadWebmcpChrome149() {
  return loadWebmcpWithSandbox({ chrome149: true });
}

/**
 * Shared loader. Returns the array of registered tools. Builds a
 * minimal sandbox, evaluates webmcp.js inside it via `new Function`,
 * and returns the array the script populated.
 *
 * The stubs (Chrome 150+ vs Chrome 149) are installed AFTER the
 * shared `tools` array is created, so the stub closures capture the
 * right reference. This was previously a closure bug — DO NOT move
 * the stubs back inline into the extra object.
 */
function loadWebmcpWithSandbox(opts) {
  const tools = [];
  opts = opts || {};
  const sandbox = {
    document: opts.chrome149 ? undefined : {
      modelContext: {
        registerTool(def) { tools.push(def); },
      },
    },
    navigator: opts.chrome149 ? {
      modelContext: {
        registerTool(def) { tools.push(def); },
      },
    } : undefined,
    fetch: async () =>
      fakeResponse(200, { token: "fake.token", expiresAt: Math.floor(Date.now() / 1000) + 60 }),
    URL, console, Promise, Object,
  };
  const fn = new Function(
    "document", "navigator", "fetch", "URL", "console", "Promise", "Object",
    EVALUABLE_WEBMCP_JS,
  );
  fn(
    sandbox.document, sandbox.navigator, sandbox.fetch, sandbox.URL,
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
    document: {
      modelContext: { registerTool: (def) => tools.push(def) },
    },
    fetch: fetchImpl,
    URL, console, Promise, Object,
  };
  const fn = new Function(
    "document", "navigator", "fetch", "URL", "console", "Promise", "Object",
    EVALUABLE_WEBMCP_JS,
  );
  fn(
    sandbox.document, sandbox.navigator, sandbox.fetch, sandbox.URL,
    sandbox.console, sandbox.Promise, sandbox.Object,
  );
  return tools;
}

/**
 * Chrome 149 variant of sandboxWithFetch: stubs navigator.modelContext
 * instead of document.modelContext. Used by the Chrome 149 tests.
 */
function sandboxWithFetchChrome149(fetchImpl) {
  const tools = [];
  const sandbox = {
    navigator: {
      modelContext: { registerTool: (def) => tools.push(def) },
    },
    fetch: fetchImpl,
    URL, console, Promise, Object,
  };
  const fn = new Function(
    "document", "navigator", "fetch", "URL", "console", "Promise", "Object",
    EVALUABLE_WEBMCP_JS,
  );
  fn(
    sandbox.document, sandbox.navigator, sandbox.fetch, sandbox.URL,
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
  test("registers render_markdown and list_render_options tools", () => {
    const tools = loadWebmcp();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_render_options", "render_markdown"]);
  });

  test("render_markdown input schema requires markdown or markdownUrl", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    expect(t.inputSchema.properties.markdown.type).toBe("string");
    expect(t.inputSchema.properties.markdownUrl.type).toBe("string");
    expect(t.inputSchema.required).toEqual([]);
    expect(t.inputSchema.oneOf).toEqual([
      { required: ["markdown"] },
      { required: ["markdownUrl"] },
    ]);
    expect(t.inputSchema.properties.fontFamily.type).toBe("string");
    expect(t.inputSchema.properties.pageSize.type).toBe("string");
  });

  test("render_markdown input schema accepts deprecated url alias", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    // The canonical name is `markdownUrl`. The deprecated alias `url`
    // is still accepted by the execute handler for backward compatibility.
    expect(t.inputSchema.properties.markdownUrl).toBeDefined();
  });

  test("tools are marked read-only", () => {
    const tools = loadWebmcp();
    for (const t of tools) {
      expect(t.annotations && t.annotations.readOnlyHint).toBe(true);
    }
  });

  test("does nothing when neither document.modelContext nor navigator.modelContext is present", () => {
    // Regression: with both namespaces absent, the script must no-op.
    // Earlier versions used a single-namespace guard (whichever one
    // we hadn't probed at the time) and broke the OTHER Chrome build.
    const sandbox = {};
    const fn = new Function(
      "document", "navigator", "URL", "console", "Promise", "Object",
      EVALUABLE_WEBMCP_JS,
    );
    fn(sandbox, sandbox, URL, console, Promise, Object);
    expect(sandbox.tools).toBeUndefined();
  });

  test("probes BOTH document.modelContext (Chrome 150+) and navigator.modelContext (Chrome 149)", () => {
    // webmcp.js must work on either Chrome build. Chrome 149 (the
    // DevTrial release at the time of writing) exposed WebMCP on
    // `navigator`; Chrome 150+ moved it to `document`. We probe both.
    // Reference: nekuda.ai/scripts/webmcp.js does the same.
    const chrome150Tools = loadWebmcp();                  // document.modelContext stubbed
    const chrome149Tools = loadWebmcpChrome149();          // navigator.modelContext stubbed
    expect(chrome150Tools.map(t => t.name).sort()).toEqual(["list_render_options", "render_markdown"]);
    expect(chrome149Tools.map(t => t.name).sort()).toEqual(["list_render_options", "render_markdown"]);
    // And the no-op path still works (both namespaces absent).
    const sandbox = {};
    const fn = new Function(
      "document", "navigator", "URL", "console", "Promise", "Object",
      EVALUABLE_WEBMCP_JS,
    );
    fn(sandbox, sandbox, URL, console, Promise, Object);
    expect(sandbox.tools).toBeUndefined();
  });

  test("Chrome 149 tools call the same execute function as Chrome 150+ tools", () => {
    // Regression for the dual-namespace fix: both probe paths must
    // register tools whose `execute` body is byte-identical. We compare
    // the render_markdown inputSchema and execute.toString() across
    // both Chrome variants — if the Chrome 149 path were registering
    // a stub or a different function, the bodies would diverge.
    const a = findTool(loadWebmcp(), "render_markdown");
    const b = findTool(loadWebmcpChrome149(), "render_markdown");
    expect(b.execute.toString()).toBe(a.execute.toString());
    expect(b.inputSchema).toEqual(a.inputSchema);
    expect(b.outputSchema).toEqual(a.outputSchema);
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
    const t = findTool(loadWebmcp(), "render_markdown");
    const orient = t.inputSchema.properties.orientation;
    expect(orient).toBeDefined();
    expect(orient.type).toBe("string");
    expect(orient.enum).toEqual(["portrait", "landscape"]);
  });

  test("every registered tool declares an outputSchema", () => {
    const tools = loadWebmcp();
    for (const t of tools) {
      expect(t.outputSchema).toBeDefined();
      expect(t.outputSchema.type).toBe("object");
    }
  });

  test("render_markdown outputSchema requires head and body", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    expect(t.outputSchema.required).toContain("head");
    expect(t.outputSchema.required).toContain("body");
    expect(t.outputSchema.properties.head.type).toBe("string");
    expect(t.outputSchema.properties.body.type).toBe("string");
  });

  test("output schema is hardened with title, description, and additionalProperties false", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    expect(t.outputSchema.type).toBe("object");
    expect(t.outputSchema.title).toBe("RenderOutput");
    expect(t.outputSchema.description).toContain("HTML fragments");
    expect(t.outputSchema.additionalProperties).toBe(false);
    expect(t.outputSchema.required).toContain("head");
    expect(t.outputSchema.required).toContain("body");
  });

  test("style fields use strict enums and ranges where applicable", () => {
    const t = findTool(loadWebmcp(), "render_markdown");
    const p = t.inputSchema.properties;
    // Core allowlisted fields are hard enums so the schema itself
    // enforces the value set, not just prose or examples.
    expect(p.fontFamily.enum).toEqual(
      expect.arrayContaining(["Inter", "Comfortaa", "Unbounded"]),
    );
    expect(p.framework.enum).toEqual(
      expect.arrayContaining(["spectre", "pico", "chota"]),
    );
    expect(p.docEngine.enum).toEqual(
      expect.arrayContaining(["none", "pagedjs", "vivliostyle"]),
    );
    expect(p.surfaceMode.enum).toEqual(["doc", "app"]);
    // CSS/page-geometry fields stay strict enums because they map to
    // concrete @page rules or presets.
    expect(p.pageSize.enum).toEqual(
      expect.arrayContaining(["A4", "A3", "Letter", "Legal"]),
    );
    expect(p.marginsLR.enum).toEqual(["narrow", "normal", "wide"]);
    expect(p.marginsTB.enum).toEqual(["narrow", "normal", "wide"]);
    expect(p.orientation.enum).toEqual(["portrait", "landscape"]);
    expect(p.fontSize.minimum).toBe(8);
    expect(p.fontSize.maximum).toBe(72);
    expect(p.width.minimum).toBe(400);
    expect(p.width.maximum).toBe(1400);
    expect(p.uiZoom.minimum).toBe(0.25);
    expect(p.uiZoom.maximum).toBe(4.0);
  });
});

describe("webmcp.js — render_markdown handler", () => {
  test("rejects missing/empty markdown and markdownUrl with INVALID_INPUT", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(t.execute({})).rejects.toThrow(/INVALID_INPUT/);
    await expect(t.execute({ markdown: "" })).rejects.toThrow(/INVALID_INPUT/);
    await expect(t.execute({ markdownUrl: "" })).rejects.toThrow(/INVALID_INPUT/);
  });

  test("rejects both markdown and markdownUrl together", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(
      t.execute({
        markdown: "# Hi",
        markdownUrl: "https://raw.githubusercontent.com/foo/bar/main/README.md",
      }),
    ).rejects.toThrow(/INVALID_INPUT/);
  });

  test("rejects unknown fontFamily with INVALID_FONT_FAMILY", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(
      t.execute({ markdown: "# Hi", fontFamily: "Comic Sans" }),
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
        t.execute({ markdown: "# Hi", fontFamily: f }),
      ).rejects.toThrow("SENTINEL");
    }
  });

  test("mints a token from /mcp-token and uses X-Mcp-Token (not X-Api-Key) for markdown", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    const result = await t.execute({
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
    // Result is returned in WebMCP structuredContent format.
    expect(result.content).toEqual([
      { type: "text", text: "Rendered markdown as HTML head/body fragments" },
    ]);
    expect(result.structuredContent.head).toBe("<style/>");
    expect(result.structuredContent.body).toBe("<h1>Hi</h1>");
  });

  test("translates string scale tokens to canonical size/weight/line fields", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    await t.execute({
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
    await t.execute({
      markdown: "# Theme test",
      theme: "dark",
    });
    const renderCall = calls.find((c) => c.url.endsWith("/render"));
    expect(renderCall.body.theme).toBe("dark");
  });

  test("rejects URL on a disallowed host with DISALLOWED_HOST", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(
      t.execute({ url: "https://github.com/foo/bar/blob/main/README.md" }),
    ).rejects.toThrow(/DISALLOWED_HOST/);
  });

  test("accepts the deprecated `url` alias for backward compat", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    // Older agents send `url`; the handler must still translate it to
    // the canonical `markdownUrl` on the wire.
    const result = await t.execute({
      url: "https://raw.githubusercontent.com/foo/bar/main/README.md",
    });
    const renderCall = calls.find((c) => c.url.endsWith("/render"));
    expect(renderCall.body.markdownUrl).toBe(
      "https://raw.githubusercontent.com/foo/bar/main/README.md",
    );
    expect(result.structuredContent.body).toBe("<h1>Hi</h1>");
  });

  test("canonical markdownUrl wins when both url and markdownUrl are sent", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    await t.execute({
      url: "https://wrong-host.example.com/rejected.md",
      markdownUrl: "https://raw.githubusercontent.com/foo/bar/main/README.md",
    });
    const renderCall = calls.find((c) => c.url.endsWith("/render"));
    expect(renderCall.body.markdownUrl).toBe(
      "https://raw.githubusercontent.com/foo/bar/main/README.md",
    );
  });

  test("rejects ftp:// URL with UNSUPPORTED_SCHEME", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(
      t.execute({ url: "ftp://example.com/file.md" }),
    ).rejects.toThrow(/UNSUPPORTED_SCHEME/);
  });

  test("rejects malformed URL with INVALID_URL", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    await expect(
      t.execute({ url: "not a url at all" }),
    ).rejects.toThrow(/INVALID_URL/);
  });

  test("accepts an allowlisted URL, mints a token, and forwards markdownUrl", async () => {
    const { fakeFetch, calls } = fakeFetchWithTokenMint();
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    const result = await t.execute({
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
    expect(result.structuredContent.body).toBe("<h1>Hi</h1>");
  });

  test("list_render_options returns bundled allowlists without network calls", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "list_render_options");
    const result = await t.execute({});
    expect(result.content).toEqual([
      { type: "text", text: "Supported render options" },
    ]);
    expect(result.structuredContent.fonts).toContain("Inter");
    expect(result.structuredContent.fonts).toContain("Comfortaa");
    expect(result.structuredContent.frameworks).toContain("spectre");
    expect(result.structuredContent.docEngines).toContain("none");
    expect(result.structuredContent.pageSizes).toContain("A4");
    expect(result.structuredContent.orientations).toEqual(["portrait", "landscape"]);
    expect(result.structuredContent.margins).toEqual(["narrow", "normal", "wide"]);
    expect(result.structuredContent.surfaceModes).toEqual(["doc", "app"]);
  });
});

/**
 * Manifest parity tests. The `.well-known/model-context.docs.json`
 * manifest is generated from `mcpShared.ts` at build time, and
 * `webmcp.js` is hand-written (it predates the manifest generator).
 * These tests catch drift between the two surfaces — adding a tool,
 * renaming a field, or changing a required-flag must be reflected in
 * BOTH places or the manifest becomes a lie.
 */

describe("manifest parity — public/.well-known/model-context.docs.json vs webmcp.js", () => {
  const MANIFEST_PATH = resolve(
    REPO_ROOT,
    "public/.well-known/model-context.docs.json",
  );
  const APPS_MANIFEST_PATH = resolve(
    REPO_ROOT,
    "public/.well-known/model-context.apps.json",
  );

  function loadManifest(p) {
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  test("docs manifest exists and is well-formed", () => {
    const m = loadManifest(MANIFEST_PATH);
    expect(m.$schema).toBeTruthy();
    expect(m.name).toBe("FlatWrite Render — Docs");
    expect(m.surfaceMode).toBe("doc");
    expect(m.status).toBe("ready");
    expect(Array.isArray(m.tools)).toBe(true);
    expect(m.tools.length).toBe(2);
  });

  test("apps manifest exists with ready status and two tools", () => {
    const m = loadManifest(APPS_MANIFEST_PATH);
    expect(m.surfaceMode).toBe("app");
    expect(m.status).toBe("ready");
    expect(m.tools.length).toBe(2);
    expect(m.tools.map(t => t.name).sort()).toEqual(["list_render_options", "render_markdown"]);
  });

  test("manifest and webmcp.js declare the same tool set", () => {
    const m = loadManifest(MANIFEST_PATH);
    const manifestNames = new Set(m.tools.map((t) => t.name));
    // Extract tool names from webmcp.js by finding the `name: '...'`
    // occurrences in the registerTool blocks.
    const webmcpNames = new Set();
    const re = /name:\s*['"]([a-z_]+)['"]/g;
    let match;
    while ((match = re.exec(WEBMCP_JS)) !== null) {
      webmcpNames.add(match[1]);
    }
    expect([...manifestNames].sort()).toEqual([...webmcpNames].sort());
  });

  test("manifest required fields match webmcp.js required fields per tool", () => {
    const m = loadManifest(MANIFEST_PATH);
    for (const tool of m.tools) {
      const webmcpTool = findToolInWebmcpSource(tool.name);
      expect(webmcpTool).toBeTruthy();
      expect([...tool.inputSchema.required].sort()).toEqual(
        [...webmcpTool.required].sort(),
      );
    }
  });

  test("every displayHints.inputFieldAliases value maps to a real property in webmcp.js", () => {
    const m = loadManifest(MANIFEST_PATH);
    const tools = loadWebmcp();
    for (const tool of m.tools) {
      const props = tool.inputSchema.properties;
      const webmcpTool = tools.find((t) => t.name === tool.name);
      expect(webmcpTool).toBeTruthy();
      const webmcpProps = webmcpTool.inputSchema.properties;
      const aliases = Object.values(tool.displayHints.inputFieldAliases);
      // Every friendly alias must appear in webmcp.js's input schema.
      for (const friendly of aliases) {
        expect(friendly in webmcpProps).toBe(true);
      }
      // Every canonical key in inputFieldAliases must be in the
      // manifest's properties.
      for (const canonical of Object.keys(tool.displayHints.inputFieldAliases)) {
        expect(canonical in props).toBe(true);
      }
    }
  });

  test("docs manifest declares the MCP Streamable HTTP handler as the preferred (first) entry", () => {
    const m = loadManifest(MANIFEST_PATH);
    // Schema uses `handlers` (array) — the old `handler` (singular)
    // is intentionally absent.
    expect(m.handler).toBeUndefined();
    expect(Array.isArray(m.handlers)).toBe(true);
    expect(m.handlers.length).toBeGreaterThanOrEqual(2);
    // First entry is the Streamable HTTP MCP handler.
    expect(m.handlers[0].transport).toBe("streamable-http");
    expect(m.handlers[0].url).toBe("https://mcp.flatwrite.md/mcp");
    // Second entry is the plain HTTP /render fallback.
    expect(m.handlers[1].transport).toBe("http");
    expect(m.handlers[1].url).toBe("https://render.flatwrite.md/render");
  });

  test("apps manifest declares two tools and the app handler", () => {
    const m = loadManifest(APPS_MANIFEST_PATH);
    expect(m.handler).toBeUndefined();
    expect(Array.isArray(m.handlers)).toBe(true);
    expect(m.handlers.length).toBe(1);
    expect(m.handlers[0].url).toBe("https://render.flatwrite.md/render?surface=app");
    expect(m.handlers[0].transport).toBe("http");
    expect(m.tools.length).toBe(2);
    expect(m.tools.map(t => t.name).sort()).toEqual(["list_render_options", "render_markdown"]);
  });

  /**
   * Re-parse webmcp.js to extract a single tool's input schema and
   * required-field list. The script is hand-written, so we can't
   * rely on JSON.parse; instead we find the matching `name: 'foo'`
   * and walk forward to `required: [ ... ]`.
   */
  function findToolInWebmcpSource(toolName) {
    const re = new RegExp(
      "name:\\s*['\"]" + toolName + "['\"][\\s\\S]*?required:\\s*\\[([^\\]]*)\\]",
      "m",
    );
    const m = WEBMCP_JS.match(re);
    if (!m) return null;
    const requiredStr = m[1];
    const required = [...requiredStr.matchAll(/['"]([^'"]+)['"]/g)].map(
      (x) => x[1],
    );
    // Extract property names by finding the next `properties: { ... }`
    // block and pulling quoted keys.
    const toolSlice = m[0];
    const propsMatch = toolSlice.match(/properties:\s*\{([\s\S]*?)\},\s*required:/);
    const propertyNames = new Set();
    if (propsMatch) {
      for (const k of propsMatch[1].matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)) {
        propertyNames.add(k[1]);
      }
    }
    return { required, propertyNames };
  }
});
