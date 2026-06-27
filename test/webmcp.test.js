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
 * Build a sandbox with a stubbed navigator.modelContext that records
 * every registered tool, then evaluate webmcp.js inside it.
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
    fetch: async () => {
      throw new Error("fetch should be mocked in the calling test");
    },
    URL,
    console,
    Promise,
    Object,
  };
  const fn = new Function(
    "navigator",
    "fetch",
    "URL",
    "console",
    "Promise",
    "Object",
    WEBMCP_JS,
  );
  fn(
    sandbox.navigator,
    sandbox.fetch,
    sandbox.URL,
    sandbox.console,
    sandbox.Promise,
    sandbox.Object,
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
    sandbox.navigator,
    sandbox.fetch,
    sandbox.URL,
    sandbox.console,
    sandbox.Promise,
    sandbox.Object,
  );
  return tools;
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

  test("translates friendly aliases to canonical frontmatter and POSTs JSON to render.flatwrite.md", async () => {
    let captured = null;
    const fakeFetch = async (url, init) => {
      captured = { url: url, init: init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ head: "<style/>", body: "<h1>Hi</h1>" }),
      };
    };
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
    expect(captured.url).toBe("https://render.flatwrite.md/render");
    expect(captured.init.method).toBe("POST");
    expect(captured.init.headers["Content-Type"]).toBe("application/json");
    expect(typeof captured.init.headers["X-Api-Key"]).toBe("string");
    expect(captured.init.headers["X-Api-Key"].length).toBeGreaterThanOrEqual(64);
    // Friendly aliases translated to canonical names
    expect(captured.body.font).toBe("Comfortaa");
    expect(captured.body.appFramework).toBe("spectre");
    expect(captured.body.fontSize).toBe(18);
    expect(captured.body.lineHeight).toBe(1.6);
    expect(captured.body.pageSize).toBe("A3");
    expect(captured.body.markdown).toBe("# Hi");
    // Public alias `fontFamily` should NOT leak onto the wire
    expect("fontFamily" in captured.body).toBe(false);
    // Result returns the head/body pair
    expect(result.head).toBe("<style/>");
    expect(result.body).toBe("<h1>Hi</h1>");
  });

  test("translates string scale tokens to canonical size/weight/line fields", async () => {
    let captured = null;
    const fakeFetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ head: "", body: "" }),
      };
    };
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown");
    await t.handler({
      markdown: "# Hi",
      fontFamily: "Playfair Display",
      fontSize: "-1",
      fontWeight: "-3",
      lineHeight: "0",
    });
    expect(captured.font).toBe("Playfair Display");
    expect(captured.size).toBe("-1");
    expect(captured.weight).toBe("-3");
    expect(captured.line).toBe("0");
    expect(captured.fontSize).toBeUndefined();
    expect(captured.fontWeight).toBeUndefined();
    expect(captured.lineHeight).toBeUndefined();
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

  test("accepts an allowlisted URL and forwards markdownUrl", async () => {
    let captured = null;
    const fakeFetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ head: "", body: "<p>ok</p>" }),
      };
    };
    const tools = sandboxWithFetch(fakeFetch);
    const t = findTool(tools, "render_markdown_from_url");
    const result = await t.handler({
      url: "https://raw.githubusercontent.com/foo/bar/main/README.md",
      fontFamily: "Comfortaa",
    });
    expect(captured.markdownUrl).toBe(
      "https://raw.githubusercontent.com/foo/bar/main/README.md",
    );
    expect(captured.font).toBe("Comfortaa");
    expect(result.body).toBe("<p>ok</p>");
  });
});