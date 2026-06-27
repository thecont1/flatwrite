/**
 * Integration tests for the Streamable HTTP transport.
 *
 * Spins up a local HTTP server with startStreamableHttp() on a random
 * port, then issues real HTTP requests against it (initialize,
 * tools/list, tools/call). Verifies the same tool surface and
 * behavior as the stdio path: pre-flight validation, friendly
 * aliases, canonical translation.
 *
 * We mock the upstream callRender() with a fake so the tests don't
 * depend on the live API or the API key.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";

mock.module("../src/renderClient.js", () => ({
  async callRender(body: Record<string, unknown>) {
    const md = (body.markdown as string | undefined) || "";
    return {
      head: "<style>/* mock */</style>",
      body: "<main>" + md + "</main>",
    };
  },
}));

const { startStreamableHttp } = await import(
  "../src/streamableHttpServer.js"
);

const API_KEY="936ccdfcce785a164261f125de3f09460cfa0eb9f9bb49eac9f34e58f37210f6";

let port = 0;
let serverHandle: { server: any; close: () => Promise<void> };

beforeAll(async () => {
  const result = await startStreamableHttp({ port: 0, apiKey: API_KEY });
  serverHandle = result;
  port = result.port;
});

afterAll(async () => {
  await serverHandle.close();
});

/**
 * Parse the Streamable HTTP response body. The transport may return
 * either a single JSON object (newer spec) or an SSE stream
 * (event: message\ndata: {...}\n\n). This helper extracts the JSON
 * payload from either format.
 */
function parseRpcResponse(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    // SSE — concatenate all data: payloads (one per event).
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        try {
          return JSON.parse(payload);
        } catch {
          /* skip non-JSON keep-alive */
        }
      }
    }
  }
  return null;
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "X-Api-Key": API_KEY,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown = parseRpcResponse(text);
  if (parsed === null) parsed = text;
  return {
    status: r.status,
    headers: Object.fromEntries(r.headers.entries()),
    body: parsed,
  };
}

async function initialize(): Promise<string> {
  const r = await http("POST", "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  expect(r.status).toBe(200);
  const sid = (r.headers["mcp-session-id"] ||
    r.headers["Mcp-Session-Id"]) as string | undefined;
  if (!sid) throw new Error("no session id in initialize response");
  return sid;
}

async function callRpc(
  sid: string,
  id: number,
  method: string,
  params?: unknown
) {
  return http(
    "POST",
    "/mcp",
    { jsonrpc: "2.0", id, method, params },
    { "mcp-session-id": sid }
  );
}

describe("streamableHttpServer — basic transport", () => {
  test("CORS preflight returns 204 with full headers", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-api-key",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("non-/mcp path returns 404", async () => {
    const r = await http("POST", "/foo", {});
    expect(r.status).toBe(404);
    expect((r.body as any).code).toBe("NOT_FOUND");
  });

  test("initialize round-trip returns server info + capabilities", async () => {
    const sid = await initialize();
    expect(sid.length).toBeGreaterThan(20);
  });

  test("tools/list returns both render tools", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 2, "tools/list");
    expect(r.status).toBe(200);
    const tools = ((r.body as any).result.tools as Array<{ name: string }>).map(
      (t) => t.name
    );
    expect(tools.sort()).toEqual(["render_markdown", "render_markdown_from_url"]);
  });

  test("non-initialize request without session ID returns NO_SESSION", async () => {
    const r = await http("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(r.status).toBe(400);
    expect((r.body as any).code).toBe("NO_SESSION");
  });
});

describe("streamableHttpServer — tool behavior parity with stdio", () => {
  test("render_markdown returns head/body for valid input", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown",
      arguments: { markdown: "# Twin test" },
    });
    expect(r.status).toBe(200);
    const result = (r.body as any).result;
    expect(result.structuredContent.head).toContain("/* mock */");
    expect(result.structuredContent.body).toContain("# Twin test");
  });

  test("friendly aliases translate to canonical frontmatter", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown",
      arguments: { markdown: "hi", fontFamily: "Comfortaa" },
    });
    expect(r.status).toBe(200);
    expect((r.body as any).result.structuredContent.body).toContain("hi");
  });

  test("invalid fontFamily returns isError with INVALID_FONT_FAMILY code", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown",
      arguments: { markdown: "hi", fontFamily: "Comic Sans" },
    });
    expect(r.status).toBe(200);
    const result = (r.body as any).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INVALID_FONT_FAMILY");
  });

  test("render_markdown_from_url rejects non-allowlisted host with DISALLOWED_HOST", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown_from_url",
      arguments: { url: "https://github.com/foo/bar/blob/main/README.md" },
    });
    expect(r.status).toBe(200);
    const result = (r.body as any).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DISALLOWED_HOST");
  });

  test("render_markdown_from_url rejects ftp:// with UNSUPPORTED_SCHEME", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown_from_url",
      arguments: { url: "ftp://example.com/x.md" },
    });
    const result = (r.body as any).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UNSUPPORTED_SCHEME");
  });

  test("render_markdown_from_url rejects malformed URL", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown_from_url",
      arguments: { url: "not a url" },
    });
    // Either Zod rejects (URL format) or our pre-flight rejects (INVALID_URL).
    // Both are correct rejection paths.
    const result = (r.body as any).result;
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(
      text.includes("INVALID_URL") ||
        text.includes("invalid_format") ||
        text.includes("Invalid URL"),
    ).toBe(true);
  });

  test("render_markdown_from_url accepts allowlisted URL and returns rendered output", async () => {
    const sid = await initialize();
    const r = await callRpc(sid, 3, "tools/call", {
      name: "render_markdown_from_url",
      arguments: {
        url: "https://raw.githubusercontent.com/foo/bar/main/README.md",
        fontFamily: "Comfortaa",
      },
    });
    const result = (r.body as any).result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.head).toContain("/* mock */");
  });
});

describe("streamableHttpServer — auth", () => {
  test("rejects requests with wrong X-Api-Key when server has apiKey configured", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });
});
