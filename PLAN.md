# Plan — WebMCP + Streamable HTTP Transport for FlatWrite

---

## Objective 1 — WebMCP in `public/`

### Goal
Register `render_markdown` and `render_markdown_from_url` as [navigator.modelContext](https://bug0.com/blog/webmcp-chrome-146-guide) tools when a user has `flatwrite.md` open in Chrome 146+. The handler calls the existing `/api/render` Vercel function (same one the editor already uses for the live preview) and returns the rendered head/body to the agent.

### Why
Right now an AI agent can only interact with `flatwrite.md` by parsing DOM, simulating clicks, or scraping the editor. WebMCP exposes a structured contract: same tools the MCP server exposes, but registered directly by the page. No new server needed — the existing canonical render path is the truth.

### File touches

| Path | Change |
|---|---|
| `public/webmcp.js` (new) | Registers `render_markdown` and `render_markdown_from_url` via `navigator.modelContext.registerTool(...)`. ~80 LOC. |
| `public/index.html` | Add `<script src="webmcp.js?v=93" defer></script>` just before `app.js`. Bump `app.js?v=` to `93` for cache-bust. |
| `mcp/flatwrite-render-server/src/tools/*.ts` | (no change — schemas already exported and stable). |
| `test/webmcp.test.js` (new) | Bun test using a minimal `navigator.modelContext` stub: verifies the tool list, input schemas, and that calling `render_markdown` with the canonical settings returns `head` + `body`. Doesn't require Chrome. |

### What the page registers

```js
if (!('modelContext' in navigator)) return; // graceful no-op on older browsers

navigator.modelContext.registerTool({
  name: 'render_markdown',
  description: 'Render raw markdown to FlatWrite-styled HTML head/body fragments. Same schema as the flatwrite-render MCP server.',
  inputSchema: { /* mirror of src/tools/renderMarkdown.ts zod schema */ },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    const r = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toCanonicalStyle(args)),
    });
    if (!r.ok) throw new Error(`render failed: ${r.status}`);
    return await r.json(); // { head, body }
  },
});

navigator.modelContext.registerTool({
  name: 'render_markdown_from_url',
  description: 'Fetch markdown from an allowlisted URL and render it.',
  inputSchema: { /* mirror of src/tools/renderMarkdownFromUrl.ts */ },
  annotations: { readOnlyHint: true },
  handler: async (args) => { /* same, but with markdownUrl */ },
});
```

Notes:
- `toCanonicalStyle()` is the same translator that lives in `mcp/flatwrite-render-server/src/renderClient.ts`. I'll inline a minimal version in `webmcp.js` (same logic, ~30 lines). The MCP test `test/renderClient.test.ts` already pins the translation semantics — the WebMCP test will verify the same shapes end-to-end.
- `/api/render` is HMAC-protected. The browser-side call will use the **internal** HMAC key path: `/api/render` accepts anonymous POSTs from the same zone (Cloudflare rule) — same way the editor's live preview already calls it. Verify the existing `api/render.js` middleware doesn't reject same-origin POSTs.
- `navigator.modelContext` is the only API surface. No polyfill, no fallback for older Chrome. Tools just don't show up.

### Verification
1. Local: `bun test test/webmcp.test.js` — Bun-style stub for `navigator.modelContext`, verify tool shapes.
2. Live: open `https://flatwrite.md` in Chrome 146+ with "Experimental Web Platform Features" flag on. Inspect the page in DevTools console — `navigator.modelContext` should list `render_markdown` and `render_markdown_from_url`.
3. End-to-end with an agent: have an MCP-capable browser extension list the page's tools, then call `render_markdown` with `{ markdown: "# Hi", fontFamily: "Comfortaa" }`. Confirm the response has a populated `body` containing `<h1>Hi</h1>`.

### Risk
- The `/api/render` HMAC middleware currently requires `X-Render-Timestamp` and `X-Render-Signature` headers. If the browser-side call doesn't pass those, the request fails. The editor's own preview already calls `/api/render` — check how `public/app.js` does it. If there's a same-origin exception baked into the rate-limit/auth middleware, the WebMCP path works automatically. If not, we'll need to either:
  (a) extend the middleware to allow same-origin requests, or
  (b) have the WebMCP handler go through the public `render.flatwrite.md` Worker instead (same X-Api-Key, but we need to expose the key to the page — not ideal).
- Option (a) is preferred. Same-origin calls can include the HMAC headers generated client-side if we expose a small `/api/sign` endpoint, but that's a future iteration. For now, simplest: allow unauthenticated same-origin POSTs to `/api/render` and rely on the rate-limiter for abuse control.

---

## Objective 2 — Streamable HTTP transport for the MCP server

### Goal
Expose the existing MCP tools (`render_markdown`, `render_markdown_from_url`) over MCP's Streamable HTTP transport at `https://mcp.flatwrite.md/mcp`. Hermes (and any other MCP client supporting streamable-http) can connect without spawning a local stdio process.

### Why
Right now the MCP server only speaks stdio — every Hermes install needs a local Node process. For hosted agents (e.g. AI assistants running in a SaaS) this is wrong. Streamable HTTP is the MCP transport of choice for remote servers (the legacy SSE transport is deprecated in the spec).

### File touches

| Path | Change |
|---|---|
| `workers/flatwrite-mcp/wrangler.toml` (new) | name = "flatwrite-mcp", route = "mcp.flatwrite.md/*", main = "src/index.js". |
| `workers/flatwrite-mcp/src/index.js` (new) | CF Worker: handles `POST /mcp` and `GET /mcp` via `WebStandardStreamableHTTPServerTransport`. Wraps a single `McpServer` instance. Verifies `X-Api-Key`. |
| `workers/flatwrite-mcp/package.json` (new) | deps: `@modelcontextprotocol/sdk`, `zod`. |
| `workers/flatwrite-mcp/README.md` (new) | Documents the endpoint, auth, CORS, session model. |
| `mcp/flatwrite-render-server/src/streamableServer.ts` (new) | Pure-Node entry that wires the same tools to a `StreamableHTTPServerTransport` — useful for self-hosting or local dev. ~60 LOC. |
| `mcp/flatwrite-render-server/src/index.ts` | Branch: if `FLATWRITE_TRANSPORT=streamable-http`, bind to `process.env.PORT` and use the streamable server. Else (default), keep stdio. |
| `mcp/flatwrite-render-server/test/streamableHttp.test.ts` (new) | Start the streamable server on a random port; `initialize` + `tools/list` + `tools/call` roundtrip. ~80 LOC. |
| `openapi.yaml` | Append a new section documenting the streamable HTTP endpoint shape (`POST /mcp`, `GET /mcp`, `DELETE /mcp`). |
| `README.md` | Add "Streamable HTTP transport" section to the MCP server block. |
| DNS | Add a CNAME from `mcp.flatwrite.md` → `flatwrite-md.flatwrite-render.workers.dev` (or whatever CF gives). |

### What the Worker looks like

```js
// workers/flatwrite-mcp/src/index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'flatwrite-render', version: '0.2.0' });

server.registerTool('render_markdown', { /* same as src/tools/renderMarkdown.ts */ }, handler);
server.registerTool('render_markdown_from_url', { /* same */ }, handler);

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.headers.get('X-Api-Key') !== env.API_KEY) return new Response('Unauthorized', { status: 401 });

    // Stateless mode — one transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true, // simpler for one-shot calls; revisit for streaming
    });
    await server.connect(transport);
    const response = await transport.handleRequest(req, ctx);
    return response;
  },
};
```

Notes:
- **Stateless mode**: each request gets a fresh transport. Simpler than tracking sessions across Worker invocations (Workers are short-lived). The MCP client won't get resumable SSE streams, but `tools/call` roundtrips work fine — and `enableJsonResponse: true` makes the response shape stable.
- **Single shared `McpServer`**: tools are registered once on import. The transport is per-request, but the tool definitions are not. This is the pattern the SDK examples recommend.
- **Auth**: same `X-Api-Key` as the public Worker. Cloudflare `wrangler secret put API_KEY` to set the value (one secret, same value as `render.flatwrite.md`).

### What the Node entry looks like

```ts
// mcp/flatwrite-render-server/src/streamableServer.ts
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcpServer.js';

export function startStreamableHttp(port: number, apiKey: string) {
  const server = createServer(async (req, res) => {
    if (req.url === '/mcp' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== apiKey) {
        res.writeHead(401); res.end(); return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const mcp = createMcpServer(apiKey);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.writeHead(404); res.end();
    }
  });
  server.listen(port);
  return server;
}