# FlatWrite

Markdown is one of the greatest cross-platform information formats ever invented. Ironically, while it is easy to read, it is also somehow difficult to read.

**FlatWrite** makes it easy — and actually pleasant — to work with markdown files. It renders your markdown in the most pleasing, customisable viewing format. From there, it is one quick step to becoming the markdown editor you reach for by default. And once the file looks and reads the way you love it, export it as **HTML** or **PDF**, or send it around as a **shareable URL**.

> **Write once, style many worlds.**

## What it does

- **Load** markdown from a URL or straight from your disk.
- **Edit** markdown with a clean, minimal editor and a helpful formatting toolbar.
- **View** your rendered markdown with a choice of lightweight CSS frameworks.
- **Read** mode gives you a focused, distraction-free preview you can resize to taste.
- **Export** to `.md`, `.html`, or `.pdf` whenever you are ready.
- **Share** your document as a real URL — the server stores the markdown and gives you a short link anyone can open.

## Share & publish

The share button is the jewel in the crown. Instead of stuffing a long document into a URL hash, FlatWrite saves the markdown to a paste bin backend and returns a short, readable link. The recipient can open the link and immediately see the document in the same preview style you chose.

- Links are short enough to paste into a chat, email, or a tweet.
- The document is stored server-side, so it works with large files and survives URL-length limits.
- Opening a shared link loads the exact content, ready to read, edit, or re-export.

## UI frameworks

FlatWrite ships with a small but curated set of frameworks:

- **Spectre.css** — a lightweight, responsive framework with useful components.
- **PoshUI** — an elegant, modern class-light option.
- **Oat** — minimal and tasteful.
- **Pico CSS** — classless, semantic-first styling.
- **Milligram** — tiny, typography-focused.
- **Chota** — a micro framework with a simple grid.
- **Simple.css** — classless, sensible defaults.

Switching between them is instant, so you can see the same content in entirely different clothes.

## Typography and layout

The preview is not just skinned by the framework. You also get fine-grained controls:

- **Eight bundled fonts**, each shipped as an inlined woff2 so the rendered output has no external font dependency:
  - **Inter** (variable, 100–900) — the workhorse
  - **JetBrains Mono** (variable, 100–800) — for code-heavy docs
  - **Lora** (variable, 400–700) — a contemporary serif
  - **Merriweather** (variable, 400–900) — a reading serif
  - **Playfair Display** (variable, 400–900) — a high-contrast display serif
  - **Comfortaa** (variable, 300–700) — a friendly geometric
  - **Lato** (300 / 400 / 700) — a humanist sans
  - **Unbounded** (variable, 200–900) — an expressive display sans
- Pick a font, then tune **size**, **weight**, and **line spacing** until the reading rhythm feels right. Adjust **UI zoom** when the chrome needs to be a little larger or smaller.

Because the fonts ship as inlined woff2 data URIs, a FlatWrite preview is fully self-contained — no Google Fonts request, no FOIT, no fallback to system-ui for the fonts you actually picked.

The font inventory lives in **one place** — `core/font-inventory.js` — and is consumed by both:

- `core/font-loader.js` (server-side render path that embeds the woff2 as a data URI for `/api/render` and `render.flatwrite.md`).
- `scripts/build-fonts-css.mjs` (regenerates `public/fonts.css`, which `public/index.html` loads via `<link rel="stylesheet">` for the static preview).

Adding a font = drop a woff2 in `public/fonts/`, add an entry to `core/font-inventory.js`, run `node scripts/build-fonts-css.mjs`. The regression test `test/font-inventory.test.js` cross-checks all three sources (the inventory, the generated CSS, the render-core loader, the picker allowlist) so they can't drift silently.

## Components

Some frameworks expose small UI components — cards, forms, badges, alerts, avatars, grids, and so on. FlatWrite lets you insert them through a simple picker that writes the correct markup for you. This means your markdown can look like a polished document rather than a wall of text.

## How to run it

FlatWrite is now a small Node.js/Vercel app. The frontend lives in `public/`, and the share feature uses the API routes in `api/`.

```bash
# Start the local server (serves public/ at the root)
bun run start
# or
node public/server.js
```

Then open the printed URL in a browser.

The local server only serves the static frontend. When deployed to Vercel, `index.js` and the `api/` routes handle the share backend. To use the **Share** feature locally, run the API routes through the Vercel CLI (`vercel dev`) or set the `DUSTEBIN_BASE_URL` environment variable and wire the API endpoints into your local setup.

```bash
# On Vercel, the share API is live automatically
DUSTEBIN_BASE_URL=https://your-dustebin-instance.example.com vercel dev
```

## Tests

```bash
bun test
```

The test suite lives in `test/` and includes:

- **Worker tests** — exercise the Cloudflare Worker logic directly (auth, CORS, JSON path, YAML path, rate-limit header forwarding, transport failures).
- **Font inventory tests** — every font in the picker allowlist must have a corresponding woff2 bundled, the file must exist on disk, and it must start with the `wOF2` magic bytes.
- **Render parity tests** — exported HTML and PDF styles stay in sync with the live preview.

## Render API and MCP tools

FlatWrite exposes its renderer as a small public HTTP service plus an MCP server in this monorepo. Both sit on top of the canonical `/api/render` handler on `flatwrite.md` (the same handler that powers the live preview).

```
                 ┌─────────────────────────────┐
                 │  Caller (HTTP / MCP / curl) │
                 └─────────────┬───────────────┘
                               │ POST + X-Api-Key
                               ▼
                 ┌─────────────────────────────┐
                 │  render.flatwrite.md  ← CF  │
                 │  workers/flatwrite-render/  │
                 │  JSON-first façade + CORS   │
                 └─────────────┬───────────────┘
                               │ POST + HMAC
                               ▼
                 ┌─────────────────────────────┐
                 │  flatwrite.md/api/render    │
                 │  canonical renderer:        │
                 │   - marked + DOMPurify      │
                 │   - font-loader (inlined)   │
                 │   - page CSS / engines      │
                 └─────────────────────────────┘
```

### Public HTTP API

`POST https://render.flatwrite.md/render`

The endpoint accepts **two content types**:

#### JSON (primary, recommended for new callers)

- Auth: `X-Api-Key: *** header.
- Body: `application/json` with `{ markdown?, markdownUrl?, framework?, fontFamily?, theme?, fontSize?, lineHeight?, uiZoom? }`.
  - `markdown` and `markdownUrl` are mutually optional, but at least one is required.
  - If both are supplied, `markdown` wins and `markdownUrl` is used as the base URL for resolving relative links.
- Response: `{ head, body }` HTML fragments.

#### YAML (legacy, used by `scripts/render_remote.py` and the existing share-pipeline callers)

- Auth: `X-Api-Key: *** header.
- Body: `text/yaml` (or `application/x-yaml`, `application/yaml`) with `{ url: <markdownUrl>, ...frontmatter }`.
- The Worker fetches `url`, merges `frontmatter` (font, size, weight, line, width, pageSize, orientation, appFramework, surfaceMode, etc.) into the render, and forwards to `/api/render`.
- This is the same shape FlatWrite's editor writes when you save a sidecar `.yaml` next to a markdown file.

#### Errors, CORS, and rate limits

- Errors: `{ error, code, retryAfter? }` JSON with codes like `MISSING_CONTENT`, `INVALID_JSON`, `INVALID_YAML`, `UNAUTHORIZED`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMIT`, `UPSTREAM_FETCH_FAILED`, `RENDER_FAILED`.
- CORS: preflight `OPTIONS` returns 204 with `Access-Control-Allow-*` headers; responses set `Access-Control-Allow-Origin: *`.
- Rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`) are forwarded from `/api/render` on every response.

#### Examples

```bash
# Raw markdown, JSON
curl -X POST https://render.flatwrite.md/render \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: YOUR_API_KEY' \
  -d '{"markdown":"# Hello, FlatWrite","framework":"spectre"}'

# Render a remote README with full design controls, YAML
curl -X POST https://render.flatwrite.md/render \
  -H 'Content-Type: text/yaml' \
  -H 'X-Api-Key: YOUR_API_KEY' \
  --data-binary @- <<'YAML'
font: Comfortaa
size: 1
weight: -1
line: 0
width: 890
pageSize: A3
orientation: portrait
appFramework: spectre
url: https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md
YAML
```

The full OpenAPI spec lives in [`openapi.yaml`](./openapi.yaml).

### MCP server (`mcp/flatwrite-render-server`)

A Node/TypeScript MCP server that exposes two tools, both backed by the same public HTTP endpoint:

| Tool | Input | Output |
| --- | --- | --- |
| `render_markdown` | `{ markdown, framework?, fontFamily?, fontSize?, fontWeight?, lineHeight?, uiZoom?, pageSize?, orientation?, marginsLR?, marginsTB?, footer?, width?, docEngine?, surfaceMode?, theme? }` | `{ head, body }` |
| `render_markdown_from_url` | `{ url, framework?, fontFamily?, fontSize?, fontWeight?, lineHeight?, uiZoom?, pageSize?, orientation?, marginsLR?, marginsTB?, footer?, width?, docEngine?, surfaceMode?, theme? }` | `{ head, body }` |

The MCP tool schemas mirror the FlatWrite editor's design controls
(`fontFamily`, `framework`, `pageSize`, etc.) and translate internally to
the canonical render frontmatter (`font`, `appFramework`, `pageSize`,
...) before forwarding to `/api/render`. The wire format matches what
the editor writes into shared-URL YAML, so the web app and the
microservice produce identical output.

Both tools pre-flight validate their inputs against the upstream renderer's
constraints.

- **`render_markdown_from_url`** rejects the call with a structured `isError: true` (and a `[DISALLOWED_HOST]`, `[UNSUPPORTED_SCHEME]`, or `[INVALID_URL]` code) when the URL is malformed, uses a non-http(s) scheme, or points at a host outside the markdown URL allowlist (`raw.githubusercontent.com`, `raw.gitlab.com`, `bitbucket.org` — kept in sync with `api/render.js`'s canonical allowlist). That avoids waiting for a 502 roundtrip when the caller passes something the upstream was always going to reject.
- **Both tools** validate `fontFamily` against the bundled font inventory (`Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded` — kept in sync with `core/font-inventory.js`) and reject with `[INVALID_FONT_FAMILY]` immediately if the requested family has no bundled woff2.

The MCP server supports two transports:

- **stdio** (default) — local process, started via `npm start` in `mcp/flatwrite-render-server/`. Used by Hermes when configured with `command: node ...`.
- **Streamable HTTP** — long-running HTTP server exposing `/mcp`. Set `FLATWRITE_TRANSPORT=streamable-http` (and optionally `FLATWRITE_PORT`) and start the same way. Clients connect via `type: streamable-http` in their MCP config. A Cloudflare Worker deployment of this transport lives at `workers/flatwrite-mcp/` and is intended to be served at `mcp.flatwrite.md/mcp`.

All error details returned to MCP callers are scrubbed through
`sanitizeDetail()` before they leave the server: bearer tokens, API keys,
32+ char hex/base64 blobs, URLs with query strings, IPv4 addresses, Node
stack frames, and local filesystem paths are redacted. This prevents
upstream stack traces, fetch-failure messages with internal hostnames,
and Cloudflare/Vercel error pages from leaking into the LLM's context.
The high-level reason (`fetch failed`, `ECONNREFUSED`, `502 Bad Gateway`)
is preserved so the model can still reason about what to do next.

Run locally:

```bash
cd mcp/flatwrite-render-server
npm install
npm run build
FLATWRITE_RENDER_API_KEY=*** node dist/index.js
```

Wire it into Hermes Agent in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  flatwrite-render:
    command: node
    args: ["/absolute/path/to/flatwrite/mcp/flatwrite-render-server/dist/index.js"]
    env:
      FLATWRITE_RENDER_API_KEY: "your-api-key-here"
```

In any MCP host (Windsurf, Cursor, Claude Desktop, etc.) the two tools appear under the `flatwrite-render` server entry. See [`mcp/flatwrite-render-server/README.md`](./mcp/flatwrite-render-server/README.md) for transport details and the `~/.codeium/windsurf/mcp_config.json` example.

## Project structure

- `public/` — static app files (`index.html`, `app.js`, `styles.css`, fonts, etc.).
- `api/` — Vercel serverless API routes (`render.js`, `share.js`, `s.js`) for the canonical render handler and shared links.
- `core/` — render-core modules shared between the editor and the headless API (`render.js`, `font-loader.js`, `document-css.js`, `inline-assets.js`, `doc-engines.js`, `auth.js`, `rate-limit.js`).
- `workers/flatwrite-render/` — Cloudflare Worker JSON-first façade at `render.flatwrite.md`.
- `mcp/flatwrite-render-server/` — Node/TypeScript MCP server exposing `render_markdown` and `render_markdown_from_url`.
- `openapi.yaml` — public HTTP API spec for the CF endpoint.
- `scripts/render_remote.py` — build-script caller that POSTs YAML sidecars to the CF Worker.
- `index.js` — Vercel root request handler (static files + API fallbacks).
- `public/server.js` — tiny static file server for local development.

## Tech stack

- [marked.js](https://marked.js.org/) for Markdown → HTML.
- [DOMPurify](https://github.com/cure53/DOMPurify) to keep the rendered output safe.
- [html2pdf.js](https://ekoopmans.github.io/html2pdf.js/) for PDF export.
- [js-yaml](https://github.com/nodeca/js-yaml) for the legacy YAML frontmatter path.
- Self-hosted variable woff2 fonts in `public/fonts/` (Inter, JetBrains Mono, Lora, Merriweather, Playfair Display, Comfortaa, Lato, Unbounded), inlined as data URIs at render time.
- Dustebin (or any compatible paste backend with `/api/pastes`) for temporarily storing shared documents.
- Browser-native `CompressionStream` for compact local URL fallbacks.
- Cloudflare Workers + the [TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) for the public façade and the MCP server.

## Why another markdown editor?

Because most editors either look like a code playground or a publishing pipeline. FlatWrite sits somewhere sweeter: close enough to the raw text that you still control it, but polished enough that you actually enjoy reading and sharing what you create.

---

© 2026 [Mahesh Shantaram](https://thecontrarian.in)
