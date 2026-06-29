# FlatWrite Render MCP Server

A Node/TypeScript MCP server exposing the FlatWrite render pipeline
to AI agents. Two transports:

1. **stdio** (default) — for local-process MCP clients (e.g. Hermes,
   Claude Desktop). Started via `npm start` / `node dist/index.js`.

2. **Streamable HTTP** — for hosted agents that can't spawn a local
   process. Started via `FLATWRITE_TRANSPORT=streamable-http npm start`.
   Default port 3000; override with `FLATWRITE_PORT`.

A Cloudflare Worker deployment of the Streamable HTTP transport lives at
[`workers/flatwrite-mcp/`](../workers/flatwrite-mcp/).

## Tools

Both transports expose the same two tools:

- `render_markdown` — render raw markdown to FlatWrite-styled HTML.
- `render_markdown_from_url` — fetch markdown from an allowlisted URL
  (`raw.githubusercontent.com`, `raw.gitlab.com`, `bitbucket.org`) and
  render it.

Input schemas mirror the editor's design controls: `fontFamily`,
`framework`, `pageSize`, `orientation`, `marginsLR`, `marginsTB`,
`footer`, `width`, `fontSize`/`fontWeight`/`lineHeight` (string scale
tokens or absolute numbers), `docEngine`, `surfaceMode`, `theme`.

Output is `{ head, body }`: head is CSS to inject, body is the
document fragment.

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `FLATWRITE_RENDER_API_KEY` | yes | — | Sent as `X-Api-Key` to the upstream render Worker. |
| `FLATWRITE_RENDER_BASE_URL` | no | `https://render.flatwrite.md/render` | Override for self-hosted upstream. |
| `FLATWRITE_TRANSPORT` | no | `stdio` | Set to `streamable-http` for HTTP mode. |
| `FLATWRITE_PORT` | no | `3000` | Bind port for HTTP mode. |

## Build

```
npm install
npm run build
npm start
```

## Test

```
bun test test/
```

The streamableHttp.test.ts suite spins up a real HTTP server on a
random port and roundtrips JSON-RPC over the wire, including:

- `initialize` and `tools/list` for capability discovery
- `tools/call` for both tools, verifying head/body shape
- Pre-flight rejection of disallowed URLs, unsupported schemes,
  malformed URLs, and unrecognised font families
- CORS preflight (204 with full headers)
- Auth (401 for wrong `X-Api-Key`)

The upstream call is mocked via `mock.module("../src/renderClient.js", ...)`,
so the tests don't depend on the live API or an API key.

## Hermes config

```yaml
mcpServers:
  flatwrite-render:
    type: streamable-http
    url: https://mcp.flatwrite.md/mcp
```

For local development (stdio transport):

```yaml
mcpServers:
  flatwrite-render:
    type: stdio
    command: node
    args:
      - /path/to/flatwrite/mcp/flatwrite-render-server/dist/index.js
    env:
      FLATWRITE_RENDER_API_KEY: <your-key>
```
