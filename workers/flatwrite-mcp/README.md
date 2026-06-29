# flatwrite-mcp (Cloudflare Worker)

Streamable HTTP MCP server exposing the FlatWrite render tools
(`render_markdown`, `render_markdown_from_url`) at
`https://mcp.flatwrite.md/mcp`.

Backs onto the same `render.flatwrite.md` Worker that the public
HTTP API and the WebMCP page-side tool use, so a tool call here
produces byte-identical output to all three surfaces.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | Send a JSON-RPC request. Used for `initialize`, `tools/list`, `tools/call`. |
| `GET` | `/mcp` | Subscribe to server-initiated notifications (SSE). Requires an existing session ID. |
| `DELETE` | `/mcp` | Close a session. |
| `OPTIONS` | `/mcp` | CORS preflight. |

The Worker returns responses in JSON-RPC form when the request's
`Accept` header is `application/json, text/event-stream`. SSE mode
uses the same single-request, single-response shape.

## Auth

Same `X-Api-Key` as the public render Worker. Set it with:

```
wrangler secret put API_KEY
```

Then add `X-Api-Key: <key>` to every request.

## Client config

```yaml
mcpServers:
  flatwrite-render:
    type: streamable-http
    url: https://mcp.flatwrite.md/mcp
```

Hermes and any other MCP client that supports the Streamable HTTP
transport can connect directly — no local Node process needed.

## DNS

The Worker route is `mcp.flatwrite.md/*`. Before the route resolves,
add a DNS record:

```
mcp.flatwrite.md  CNAME  flatwrite-mcp.<account>.workers.dev
```

(or whatever Cloudflare gives for the worker's `*.workers.dev` URL
once deployed).

## Deployment

```
cd workers/flatwrite-mcp
npm install
wrangler deploy
```

The `wrangler.toml` already has `route = { pattern = "mcp.flatwrite.md/*", zone_name = "flatwrite.md" }`
and the `name = "flatwrite-mcp"` Worker name. The deploy step
uploads the bundle to Cloudflare.

## Architecture

```
Client (Hermes / Claude / curl)
       │  POST /mcp   X-Api-Key: <key>
       ▼
mcp.flatwrite.md  ←  Cloudflare Worker (this directory)
       │  POST /render   X-Api-Key: <key>
       ▼
render.flatwrite.md  ←  Cloudflare Worker (workers/flatwrite-render/)
       │  POST /api/render   (HMAC-signed)
       ▼
flatwrite.md  ←  Vercel canonical renderer
```

The MCP Worker is stateless — each request gets a fresh transport
and a fresh `McpServer` instance. This is fine for tool-call style
usage (no SSE streaming) and avoids the complexity of stateful
Workers across invocations.

For more sophisticated use cases (server-initiated notifications,
multi-step sessions), revisit session management and switch to
stateful mode.

## Test

The Node-side `mcp/flatwrite-render-server/test/streamableHttp.test.ts`
suite exercises the same handler logic against a real HTTP server.
The Worker source mirrors that handler one-to-one (same tool
registrations, same translator, same validator), so the test
coverage applies.

Run locally:

```
cd workers/flatwrite-mcp
npm install
npx wrangler dev --local --port 8787
```

Then in another terminal:

```
curl -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Api-Key: *** \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
