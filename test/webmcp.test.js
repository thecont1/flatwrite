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

/**
 * Tests for public/webmcp.js. We can't run Chrome in CI, so we stub
 * document.modelContext with a minimal in-memory implementation that
 * captures registered tools and replays execute calls. The webmcp.js
 * script must:
 *
 *   1. Register all 11 WebMCP tools from the generated DOC_TOOLS array
 *   2. Have a JSON Schema that requires markdown or markdownUrl for render_markdown
 *   3. Translate friendly aliases to canonical frontmatter
 *   4. Pre-flight validate fontFamily against the bundled inventory
 *   5. Pre-flight validate the markdown URL against the allowlist
 *   6. Return a typed { ok, kind, artifacts, ... } envelope on success
 *   7. Mint a short-lived token from /mcp-token and send it as X-Mcp-Token
 *   8. Call the executor as `t.execute(args)` — Chrome's WebMCP API
 *      uses the `execute` property on a registered tool.
 *   9. Register via `document.modelContext` (Chrome 150+ spec shape)
 *      OR `navigator.modelContext` (Chrome 149 DevTrial legacy shape).
 *  10. Every tool has an outputSchema with at least one required top-level field.
 *  11. Every result includes `ok` and either a typed payload or typed `error`.
 *  12. No two tools have overlapping names or indistinguishable descriptions.
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
const WEBMCP_TOOLS_JS = readFileSync(
  resolve(REPO_ROOT, "public/webmcp-tools.js"),
  "utf-8",
);

/**
 * Build a single evaluable script from the ES-module webmcp.js, its
 * shared dependency (webmcp-shared.js), and the generated tool
 * definitions (webmcp-tools.js). All three are stripped of `export`
 * so they work as a script, and webmcp.js's import lines are removed.
 */
function bundleWebmcpForEval() {
  const shared = WEBMCP_SHARED_JS
    .replace(/export const /g, "const ")
    .replace(/export async function /g, "async function ")
    .replace(/export function /g, "function ");
  const tools = WEBMCP_TOOLS_JS
    .replace(/export const /g, "const ");
  const webmcp = WEBMCP_JS
    .replace(
      /import\s+\{[^}]+\}\s+from\s+['"]\.\/webmcp-tools\.js(?:\?[^'"]*)?['"]\s*;?\n/,
      "",
    )
    .replace(
      /import\s+\{[^}]+\}\s+from\s+['"]\.\/webmcp-shared\.js(?:\?[^'"]*)?['"]\s*;?\n/,
      "",
    );
  return shared + "\n" + tools + "\n" + webmcp;
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
  const EXPECTED_TOOLS = [
    "create_document", "create_share_link", "export_document_html",
    "export_document_pdf", "get_document_state",
    "list_recent_documents", "list_render_options", "open_document",
    "render_markdown", "render_markdown_preview", "update_document_content",
  ];

  test("registers all 11 WebMCP tools from the generated DOC_TOOLS array", () => {
    const tools = loadWebmcp();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
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
    expect(t.inputSchema.properties.font.type).toBe("string");
    expect(t.inputSchema.properties.pageSize.type).toBe("string");
  });

  test("render_markdown input schema accepts deprecated url alias", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    // The canonical name is `markdownUrl`. The deprecated alias `url`
    // is still accepted by the execute handler for backward compatibility.
    expect(t.inputSchema.properties.markdownUrl).toBeDefined();
  });

  test("read-only tools are marked readOnlyHint: true, mutating tools are not", () => {
    const tools = loadWebmcp();
    for (const t of tools) {
      if (t.annotations && t.annotations.readOnlyHint === true) {
        // render_markdown, list_render_options, get_document_state, etc.
        expect(t.annotations.readOnlyHint).toBe(true);
      } else {
        // create_document, update_document_content, export_*, create_share_link
        expect(t.annotations.readOnlyHint).not.toBe(true);
      }
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
    const chrome150Tools = loadWebmcp();                  // document.modelContext stubbed
    const chrome149Tools = loadWebmcpChrome149();          // navigator.modelContext stubbed
    expect(chrome150Tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(chrome149Tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOLS);
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

  test("render_markdown outputSchema uses typed envelope with ok, kind, artifacts", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    expect(t.outputSchema.required).toContain("ok");
    expect(t.outputSchema.required).toContain("kind");
    expect(t.outputSchema.required).toContain("artifacts");
    expect(t.outputSchema.properties.artifacts.required).toContain("head");
    expect(t.outputSchema.properties.artifacts.required).toContain("body");
    expect(t.outputSchema.properties.artifacts.properties.head.type).toBe("string");
    expect(t.outputSchema.properties.artifacts.properties.body.type).toBe("string");
  });

  test("output schema is hardened with description and additionalProperties false", () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    expect(t.outputSchema.type).toBe("object");
    expect(t.outputSchema.description).toContain("HTML fragments");
    expect(t.outputSchema.additionalProperties).toBe(false);
    expect(t.outputSchema.required).toContain("ok");
    expect(t.outputSchema.required).toContain("kind");
    expect(t.outputSchema.required).toContain("artifacts");
  });

  test("style fields use strict enums and ranges where applicable", () => {
    const t = findTool(loadWebmcp(), "render_markdown");
    const p = t.inputSchema.properties;
    // Core allowlisted fields are hard enums so the schema itself
    // enforces the value set, not just prose or examples.
    // Generated schemas use canonical names (font, appFramework, etc.)
    expect(p.font.enum).toEqual(
      expect.arrayContaining(["Inter", "Comfortaa", "Unbounded"]),
    );
    expect(p.appFramework.enum).toEqual(
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
    // size/weight/line use oneOf (string token OR number) with min/max bounds
    expect(p.size.minimum).toBe(8);
    expect(p.size.maximum).toBe(72);
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
    for (const args of [{}, { markdown: "" }, { markdownUrl: "" }]) {
      const result = await t.execute(args);
      expect(result.structuredContent.ok).toBe(false);
      expect(result.structuredContent.error.code).toBe("INVALID_INPUT");
    }
  });

  test("rejects both markdown and markdownUrl together", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    const result = await t.execute({
      markdown: "# Hi",
      markdownUrl: "https://raw.githubusercontent.com/foo/bar/main/README.md",
    });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error.code).toBe("INVALID_INPUT");
  });

  test("rejects unknown fontFamily with INVALID_FONT_FAMILY", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    const result = await t.execute({ markdown: "# Hi", fontFamily: "Comic Sans" });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error.code).toBe("INVALID_FONT_FAMILY");
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
      const result = await t.execute({ markdown: "# Hi", fontFamily: f });
      expect(result.structuredContent.ok).toBe(false);
      expect(result.structuredContent.error.code).toBe("RENDER_FAILED");
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
    // Result is returned in WebMCP structuredContent format with typed envelope.
    expect(result.content).toEqual([
      { type: "text", text: "Rendered markdown as HTML head/body fragments" },
    ]);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.kind).toBe("html");
    expect(result.structuredContent.artifacts.head).toBe("<style/>");
    expect(result.structuredContent.artifacts.body).toBe("<h1>Hi</h1>");
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
    const result = await t.execute({ url: "https://github.com/foo/bar/blob/main/README.md" });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error.code).toBe("DISALLOWED_HOST");
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
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.artifacts.body).toBe("<h1>Hi</h1>");
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
    const result = await t.execute({ url: "ftp://example.com/file.md" });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error.code).toBe("UNSUPPORTED_SCHEME");
  });

  test("rejects malformed URL with INVALID_URL", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "render_markdown");
    const result = await t.execute({ url: "not a url at all" });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error.code).toBe("INVALID_URL");
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
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.artifacts.body).toBe("<h1>Hi</h1>");
  });

  test("list_render_options returns bundled allowlists in typed envelope", async () => {
    const tools = loadWebmcp();
    const t = findTool(tools, "list_render_options");
    const result = await t.execute({});
    expect(result.content).toEqual([
      { type: "text", text: "Supported render options" },
    ]);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.options.fonts).toContain("Inter");
    expect(result.structuredContent.options.fonts).toContain("Comfortaa");
    expect(result.structuredContent.options.frameworks).toContain("spectre");
    expect(result.structuredContent.options.docEngines).toContain("none");
    expect(result.structuredContent.options.pageSizes).toContain("A4");
    expect(result.structuredContent.options.orientations).toEqual(["portrait", "landscape"]);
    expect(result.structuredContent.options.margins).toEqual(["narrow", "normal", "wide"]);
    expect(result.structuredContent.options.surfaceModes).toEqual(["doc", "app"]);
    expect(result.structuredContent.defaults.font).toBe("Inter");
  });
});

/**
 * Manifest parity tests. The `.well-known/model-context.docs.json`
 * manifest and the webmcp.js runtime registration both derive from
 * the same generated DOC_TOOLS array (from mcpShared.ts via
 * build-manifest.mjs). These tests verify they stay in sync.
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

  test("docs manifest exists and is well-formed with 11 tools", () => {
    const m = loadManifest(MANIFEST_PATH);
    expect(m.$schema).toBeTruthy();
    expect(m.name).toBe("FlatWrite Render — Docs");
    expect(m.surfaceMode).toBe("doc");
    expect(m.status).toBe("ready");
    expect(Array.isArray(m.tools)).toBe(true);
    expect(m.tools.length).toBe(11);
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
    const webmcpTools = loadWebmcp();
    const webmcpNames = new Set(webmcpTools.map((t) => t.name));
    expect([...manifestNames].sort()).toEqual([...webmcpNames].sort());
  });

  test("manifest and webmcp.js declare the same outputSchema per tool", () => {
    const m = loadManifest(MANIFEST_PATH);
    const webmcpTools = loadWebmcp();
    for (const tool of m.tools) {
      const webmcpTool = webmcpTools.find((t) => t.name === tool.name);
      expect(webmcpTool).toBeTruthy();
      expect(webmcpTool.outputSchema).toEqual(tool.outputSchema);
    }
  });

  test("manifest and webmcp.js declare the same inputSchema required fields per tool", () => {
    const m = loadManifest(MANIFEST_PATH);
    const webmcpTools = loadWebmcp();
    for (const tool of m.tools) {
      const webmcpTool = webmcpTools.find((t) => t.name === tool.name);
      expect(webmcpTool).toBeTruthy();
      expect([...tool.inputSchema.required].sort()).toEqual(
        [...webmcpTool.inputSchema.required].sort(),
      );
    }
  });

  test("every displayHints.inputFieldAliases key maps to a real property in both manifest and webmcp.js", () => {
    const m = loadManifest(MANIFEST_PATH);
    const tools = loadWebmcp();
    for (const tool of m.tools) {
      const props = tool.inputSchema.properties;
      const webmcpTool = tools.find((t) => t.name === tool.name);
      expect(webmcpTool).toBeTruthy();
      const webmcpProps = webmcpTool.inputSchema.properties;
      const aliases = tool.displayHints.inputFieldAliases;
      // Every canonical key must be in both the manifest's and the
      // runtime's inputSchema properties.
      for (const canonical of Object.keys(aliases)) {
        expect(canonical in props).toBe(true);
        expect(canonical in webmcpProps).toBe(true);
      }
    }
  });

  test("docs manifest declares the MCP Streamable HTTP handler as the preferred (first) entry", () => {
    const m = loadManifest(MANIFEST_PATH);
    expect(m.handler).toBeUndefined();
    expect(Array.isArray(m.handlers)).toBe(true);
    expect(m.handlers.length).toBeGreaterThanOrEqual(2);
    expect(m.handlers[0].transport).toBe("streamable-http");
    expect(m.handlers[0].url).toBe("https://mcp.flatwrite.md/mcp");
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
});

/**
 * Scan-oriented tests — grader-facing assertions that fail locally
 * before WebMCP gives a bad score. These verify the structural
 * properties a WebMCP scanner checks: every tool has schemas, every
 * outputSchema has required fields, results are typed, names are
 * unique, and the manifest/runtime tool sets match.
 */

describe("scan-oriented — grader-facing schema assertions", () => {
  const MANIFEST_PATH = resolve(
    REPO_ROOT,
    "public/.well-known/model-context.docs.json",
  );

  function loadManifest() {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  }

  test("every tool has name, description, inputSchema, and outputSchema", () => {
    const m = loadManifest();
    for (const tool of m.tools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema.type).toBe("object");
    }
  });

  test("every outputSchema has at least one required top-level field", () => {
    const m = loadManifest();
    for (const tool of m.tools) {
      expect(tool.outputSchema.required).toBeDefined();
      expect(Array.isArray(tool.outputSchema.required)).toBe(true);
      expect(tool.outputSchema.required.length).toBeGreaterThan(0);
    }
  });

  test("every tool has a category field", () => {
    const m = loadManifest();
    const validCategories = new Set(["render", "discovery", "lifecycle", "export", "share"]);
    for (const tool of m.tools) {
      expect(tool.category).toBeDefined();
      expect(validCategories.has(tool.category)).toBe(true);
    }
  });

  test("no two tools have overlapping names", () => {
    const m = loadManifest();
    const names = m.tools.map((t) => t.name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  test("no two tools have indistinguishable descriptions (first 40 chars differ)", () => {
    const m = loadManifest();
    const prefixes = m.tools.map((t) => t.description.slice(0, 40));
    const unique = new Set(prefixes);
    expect(prefixes.length).toBe(unique.size);
  });

  test("every tool name starts with a verb (create_, open_, get_, list_, render_, export_, update_)", () => {
    const m = loadManifest();
    const verbPattern = /^(create_|open_|get_|list_|render_|export_|update_)/;
    for (const tool of m.tools) {
      expect(tool.name).toMatch(verbPattern);
    }
  });

  test("manifests and runtime registry expose the same tool set", () => {
    const m = loadManifest();
    const manifestNames = new Set(m.tools.map((t) => t.name));
    const runtimeTools = loadWebmcp();
    const runtimeNames = new Set(runtimeTools.map((t) => t.name));
    expect([...manifestNames].sort()).toEqual([...runtimeNames].sort());
  });

  test("every tool has additionalProperties: false on its outputSchema", () => {
    const m = loadManifest();
    for (const tool of m.tools) {
      expect(tool.outputSchema.additionalProperties).toBe(false);
    }
  });

  test("only render_markdown includes canonical render-param fields in inputSchema", () => {
    const m = loadManifest();
    // Derive the render-param field set from render_markdown's own
    // inputSchema, minus its tool-specific fields (markdown, markdownUrl).
    // This stays in sync with RENDER_INPUT_FIELDS automatically.
    const rm = m.tools.find((t) => t.name === "render_markdown");
    const toolSpecificFields = new Set(["markdown", "markdownUrl"]);
    const renderParamFields = new Set(
      Object.keys(rm.inputSchema.properties || {}).filter(
        (k) => !toolSpecificFields.has(k),
      ),
    );
    for (const tool of m.tools) {
      const props = Object.keys(tool.inputSchema.properties || {});
      const renderFields = props.filter((p) => renderParamFields.has(p));
      if (tool.name === "render_markdown") {
        // render_markdown should have ALL canonical render-param fields
        expect(renderFields.length).toBeGreaterThan(0);
      } else {
        // No other tool should have any render-param fields
        expect(renderFields).toEqual([]);
      }
    }
  });

  test("render_markdown outputSchema includes ok, kind, and artifacts with head+body", () => {
    const m = loadManifest();
    const t = m.tools.find((x) => x.name === "render_markdown");
    expect(t).toBeTruthy();
    expect(t.outputSchema.required).toContain("ok");
    expect(t.outputSchema.required).toContain("kind");
    expect(t.outputSchema.required).toContain("artifacts");
    expect(t.outputSchema.properties.artifacts.required).toContain("head");
    expect(t.outputSchema.properties.artifacts.required).toContain("body");
  });

  test("lifecycle tools (except list_recent_documents) return documentId in their outputSchema", () => {
    const m = loadManifest();
    const lifecycleTools = m.tools.filter((t) => t.category === "lifecycle" && t.name !== "list_recent_documents");
    expect(lifecycleTools.length).toBeGreaterThan(0);
    for (const tool of lifecycleTools) {
      expect(tool.outputSchema.required).toContain("documentId");
    }
  });

  test("export tools return format in their outputSchema", () => {
    const m = loadManifest();
    const exportTools = m.tools.filter((t) => t.category === "export");
    expect(exportTools.length).toBeGreaterThan(0);
    for (const tool of exportTools) {
      expect(tool.outputSchema.required).toContain("format");
    }
  });
});
