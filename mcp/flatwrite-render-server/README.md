# @flatwrite/mcp-render-server

Node/TypeScript MCP server exposing FlatWrite's public render API as two
MCP tools. Backed by `https://render.flatwrite.md/render`.

## Tools

| Tool | Required input | Output |
| --- | --- | --- |
| `render_markdown` | `markdown: string` + optional `framework`, `fontFamily`, `theme`, `fontSize`, `lineHeight`, `uiZoom` | `{ head, body }` |
| `render_markdown_from_url` | `url: string (uri)` + optional styling | `{ head, body }` |

Errors are surfaced via `isError: true` plus a `content` text block that
includes the upstream `{ error, code, retryAfter? }` shape.

## Build

```bash
cd mcp/flatwrite-render-server
npm install
npm run build
```

## Run

```bash
FLATWRITE_RENDER_API_KEY=*** node dist/index.js
```

Optional `FLATWRITE_RENDER_BASE_URL` overrides the default
`https://render.flatwrite.md/render` (useful for local mocking or staging).

## Hermes Agent wiring

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  flatwrite-render:
    command: node
    args: ["/absolute/path/to/flatwrite/mcp/flatwrite-render-server/dist/index.js"]
    env:
      FLATWRITE_RENDER_API_KEY: "your-api-key-here"
```

Hermes will discover both tools and make them available to your agents.
