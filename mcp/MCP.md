# FlatWrite MCP — Theory & User Manual

This document explains how FlatWrite's Model Context Protocol (MCP) integration works, what tools are available, and how to use them — whether you're an AI agent, a developer wiring up an MCP client, or a curious human who wants to understand the plumbing.

---

## Table of contents

1. [What is MCP?](#1-what-is-mcp)
2. [What is WebMCP?](#2-what-is-webmcp)
3. [How FlatWrite uses both](#3-how-flatwrite-uses-both)
4. [The four surfaces](#4-the-four-surfaces)
5. [Authentication model](#5-authentication-model)
6. [Tool reference (12 tools)](#6-tool-reference-12-tools)
7. [Output schemas — what every tool returns](#7-output-schemas--what-every-tool-returns)
8. [Error handling](#8-error-handling)
9. [Using the MCP server (stdio)](#9-using-the-mcp-server-stdio)
10. [Using the Streamable HTTP endpoint](#10-using-the-streamable-http-endpoint)
11. [Using WebMCP in the browser](#11-using-webmcp-in-the-browser)
12. [Using the plain HTTP API](#12-using-the-plain-http-api)
13. [Architecture: where the code lives](#13-architecture-where-the-code-lives)
14. [Build & deployment](#14-build--deployment)
15. [Testing](#15-testing)
16. [Glossary](#16-glossary)

---

## 1. What is MCP?

The **Model Context Protocol** (MCP) is an open standard that lets AI agents talk to external tools and data sources in a structured way. Think of it as a USB port for AI: instead of every app inventing its own integration format, MCP defines a common language for "here are the tools I offer, here's what they accept, and here's what they return."

An MCP **server** publishes a list of **tools**. Each tool has:

- A **name** (e.g. `render_markdown`)
- A **description** (what it does, in plain language)
- An **input schema** (what arguments it accepts, with types and constraints)
- An **output schema** (what shape the result has — this is the part many implementations skip, but FlatWrite doesn't)
- An **execute handler** (the code that runs when the tool is called)

An MCP **client** (like Claude, Cursor, or any MCP-aware agent) discovers these tools, presents them to the user or model, and calls them on demand. The protocol handles the request/response cycle, including error surfacing and structured content.

**Key idea**: the agent never guesses. It reads the schema, knows exactly what to send, and knows exactly what shape comes back. No scraping web pages, no parsing free-form text, no retrying because the output was ambiguous.

---

## 2. What is WebMCP?

**WebMCP** is a related standard that brings MCP-style tool discovery to web pages. Instead of running a separate server process, the web page itself registers tools directly in the browser via a JavaScript API:

```js
document.modelContext.registerTool({
  name: 'render_markdown',
  description: '...',
  inputSchema: { ... },
  outputSchema: { ... },
  execute: function(args) { ... },
});
```

When Chrome (146+ DevTrial, 150+ stable) loads a page with WebMCP tools, an AI agent driving the browser can discover and call those tools without any external server. The tools run in the page's JavaScript context — they can read the editor's state, trigger exports, create share links, and do everything the user can do through the UI.

**Declarative discovery**: Web pages can also publish **manifest files** — static JSON documents at well-known URLs (`.well-known/model-context.docs.json`) that describe the available tools without executing any JavaScript. Agents and scanners can read these manifests to understand a site's capabilities before visiting. FlatWrite publishes two: one for the Docs surface and one for the Apps surface.

---

## 3. How FlatWrite uses both

FlatWrite exposes its rendering and document-management capabilities through **four parallel surfaces**, all backed by the same canonical tool definitions:

```
                    mcpShared.ts
                  (single source of truth)
                        |
          +-------------+-------------+-------------+
          |             |             |             |
     Manifests    WebMCP page    MCP server    HTTP API
     (.json)      (webmcp.js)    (stdio/HTTP)  (/render)
          |             |             |             |
   Agent reads   Agent in browser  Agent via MCP  Any client
   capabilities   calls tools      client calls   POST JSON
```

- **Manifests** (`public/.well-known/model-context.*.json`): Static JSON files that declare what tools exist. Generated at build time from `mcpShared.ts`. Scanners and agents read these to discover capabilities without running code.
- **WebMCP** (`public/webmcp.js`): Runs in the browser tab when someone visits flatwrite.md. Registers 12 tools via `document.modelContext.registerTool()`. An agent driving Chrome can call these directly — they interact with the live editor.
- **MCP server** (`mcp/flatwrite-render-server/`): A standalone process that speaks the MCP protocol over stdio or Streamable HTTP. Exposes `render_markdown` and `render_markdown_from_url` for server-to-server clients like Claude Desktop or Cursor.
- **HTTP API** (`https://render.flatwrite.md/render`): A plain JSON POST endpoint. Not MCP-formatted, but produces byte-identical output. Useful for curl, scripts, and integrations that don't speak MCP.

All four surfaces produce the same rendered output because they all funnel through the same Cloudflare Worker at `render.flatwrite.md`.

---

## 4. The four surfaces

### 4.1 Declarative manifests

Two JSON files are published at well-known URLs and linked from `index.html`:

```html
<link rel="model-context" href="/.well-known/model-context.docs.json" title="FlatWrite Render — Docs" />
<link rel="model-context" href="/.well-known/model-context.apps.json" title="FlatWrite Render — Apps" />
```

| Manifest | URL | Tools | Purpose |
|---|---|---|---|
| Docs | `/.well-known/model-context.docs.json` | 12 | Full document lifecycle: render, inspect, edit, export, share |
| Apps | `/.well-known/model-context.apps.json` | 2 | App-surface rendering (framework-styled output) |

Each manifest contains:
- `$schema` — the WebMCP manifest schema URL
- `name`, `version`, `surfaceMode`, `status`
- `handlers` — one or more endpoint configurations (transport, URL, auth notes)
- `tools` — array of tool definitions (name, description, category, inputSchema, outputSchema, annotations, displayHints)

### 4.2 WebMCP (browser-side)

`public/webmcp.js` runs in the browser when flatwrite.md is loaded. It imports tool metadata from the generated `public/webmcp-tools.js` (produced by `build-manifest.mjs` from `mcpShared.ts`) and binds an `execute` handler to each tool.

The browser-side tools have two flavours:

- **Server-backed tools** (`render_markdown`, `list_render_options`): Call the render Worker at `render.flatwrite.md/render` using a short-lived token. The output is byte-identical to what an external MCP client gets.
- **Editor-bridge tools** (`get_document_state`, `create_document`, `export_document_pdf`, etc.): Interact with the live editor via `window.__flatwrite`, a bridge object that `app.js` exposes. These tools can read the editor's content, change modes, trigger exports, and create share links — all without DOM scraping.

### 4.3 MCP server (stdio + Streamable HTTP)

The MCP server at `mcp/flatwrite-render-server/` is a Node.js process that speaks the MCP protocol. It can run in two modes:

- **Stdio** (default): For local-process MCP clients like Claude Desktop. The client spawns the server as a child process and communicates over stdin/stdout.
- **Streamable HTTP**: For remote clients. Runs as a long-lived HTTP server on a configurable port. Each session gets its own `McpServer` instance. Supports CORS for browser callers from trusted origins.

The server currently registers two tools: `render_markdown` and `render_markdown_from_url`. These are the server-side equivalents of the browser's `render_markdown` — they call the same render Worker and return the same `{ head, body }` output.

### 4.4 Plain HTTP API

`https://render.flatwrite.md/render` is a simple JSON POST endpoint. It's not MCP-formatted (no tool wrappers, no `content`/`structuredContent` envelope), but the underlying render output is identical. Useful for curl, scripts, and integrations that don't need the MCP protocol overhead.

```bash
curl -X POST https://render.flatwrite.md/render \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: YOUR_KEY" \
  -d '{"markdown": "# Hello World"}'
```

Returns:

```json
{
  "head": "<style>...</style>",
  "body": "<body class=\"fw-render\"><main><h1>Hello World</h1></main></body>"
}
```

---

## 5. Authentication model

FlatWrite uses a **two-tier auth model** designed to keep long-lived secrets out of browser-shipped JavaScript:

### X-Api-Key (server-to-server)

A long-lived API key set as a Cloudflare Worker secret (`wrangler secret put API_KEY`). Used by:
- The MCP stdio server
- The MCP Streamable HTTP server (when the request has no `Origin` header)
- curl scripts and server-side integrations

**Never embedded in client-side JavaScript.** The Worker rejects any request that sends `X-Api-Key` with a browser `Origin` header.

### X-Mcp-Token (browser-safe)

A short-lived HMAC-signed token (60-second TTL) minted by the Worker at `POST /mcp-token`. Used by:
- `public/webmcp.js` (the browser-side WebMCP script)
- Browser-based MCP Streamable HTTP clients

The flow:
1. Browser script POSTs to `https://render.flatwrite.md/mcp-token` (no auth required — the Worker validates the `Origin` header against a trusted-origin allowlist).
2. Worker returns `{ token: "...", expiresAt: ... }`.
3. Browser script caches the token in memory and sends it as `X-Mcp-Token` on render requests.
4. Worker validates the token's HMAC signature and expiry, then swaps it for the real `X-Api-Key` before forwarding to the render endpoint.
5. The script refreshes the token ~10 seconds before expiry.

**Why two tiers?** The long-lived key must never appear in shipped JavaScript — anyone could read it with View Source. The short-lived token is safe to expose: even if intercepted, it expires in 60 seconds and is scoped to the `mcp` scope.

---

## 6. Tool reference (12 tools)

All 12 tools are defined in `mcpShared.ts` as `RENDER_TOOLS_DOCS` and exposed via the Docs manifest and the browser-side WebMCP script. Each tool belongs to a **category** that groups related functionality:

### Render tools (2)

#### `render_markdown`

Render markdown into FlatWrite-styled HTML `<head>` and `<body>` fragments. Provide either raw markdown inline or an allowlisted URL.

- **Category**: `render`
- **Read-only**: yes
- **Inputs**: `markdown` (string) OR `markdownUrl` (string, must be on `raw.githubusercontent.com`, `raw.gitlab.com`, or `bitbucket.org`), plus optional style fields (font, size, weight, line, docEngine, pageSize, orientation, margins, theme, etc.)
- **Output**: `{ ok: true, kind: "html", document: { title, wordCount, charCount }, artifacts: { head, body }, warnings: [] }`
- **When to use**: You need the rendered HTML to inject into another page. Use `render_markdown_preview` if you want to see the result in the FlatWrite editor instead.

#### `render_markdown_preview`

Render markdown into the FlatWrite editor's preview pane, applying current style and layout settings.

- **Category**: `render`
- **Read-only**: no (changes editor state)
- **Inputs**: Optional `markdown` (if omitted, previews the current editor content), plus optional style fields.
- **Output**: `{ ok: true, kind: "preview", documentId: "...", warnings: [] }`
- **When to use**: You want to see how the document looks in the editor. Use `render_markdown` when you need the actual HTML artifacts.

### Discovery tools (1)

#### `list_render_options`

Return the supported fonts, UI frameworks, document engines, page sizes, orientations, margins, surface modes, and default values.

- **Category**: `discovery`
- **Read-only**: yes
- **Inputs**: none
- **Output**: `{ ok: true, options: { fonts, frameworks, docEngines, pageSizes, orientations, margins, surfaceModes }, defaults: { font, docEngine, surfaceMode, pageSize, orientation } }`
- **When to use**: Before calling `render_markdown` if you need to know which enum values are valid.

### Lifecycle tools (5)

#### `get_document_state`

Return the current state of the active document in the FlatWrite editor.

- **Category**: `lifecycle`
- **Read-only**: yes
- **Inputs**: none
- **Output**: `{ ok: true, documentId, title, wordCount, charCount, unsavedChanges, renderMode, docEngine, surfaceMode, url, availableExports, canShare }`
- **When to use**: Before export or share tools to check readiness. Use `update_document_content` to change the content.

#### `create_document`

Create a new blank document in the editor, optionally with initial markdown content.

- **Category**: `lifecycle`
- **Read-only**: no
- **Inputs**: `markdown` (optional string), `title` (optional string)
- **Output**: `{ ok: true, documentId, title, url, nextSuggestedTool: "update_document_content" }`
- **When to use**: To start a new document. Use `open_document` to load an existing one.

#### `open_document`

Open an existing document from a URL or share link in the editor.

- **Category**: `lifecycle`
- **Read-only**: no
- **Inputs**: `url` (required string — a raw markdown URL or a FlatWrite share link with `?s=...`)
- **Output**: `{ ok: true, documentId, title, url, active: true, nextSuggestedTool: "get_document_state" }`
- **When to use**: To load a remote markdown file or a previously shared document. Use `create_document` to start blank.

#### `update_document_content`

Update the markdown content of the active document.

- **Category**: `lifecycle`
- **Read-only**: no
- **Inputs**: `markdown` (required string)
- **Output**: `{ ok: true, documentId, updatedAt, stateVersion, nextSuggestedTool: "render_markdown_preview" }`
- **When to use**: To edit the document programmatically. Use `get_document_state` to inspect the result.

#### `list_recent_documents`

Return a list of recently opened documents from the editor session.

- **Category**: `lifecycle`
- **Read-only**: yes
- **Inputs**: none
- **Output**: `{ ok: true, documents: [{ documentId, title, url, updatedAt }] }`
- **When to use**: To discover what the user has been working on. Use `open_document` to load one.

### Export tools (3)

#### `export_document_html`

Export the active document as a self-contained HTML file and open it in a new tab.

- **Category**: `export`
- **Read-only**: no
- **Inputs**: none
- **Output**: `{ ok: true, documentId, format: "html", warnings: [] }`
- **When to use**: When you need the full HTML document. Use `export_document_pdf` for print-ready output.

#### `export_document_pdf`

Export the active document as a PDF by triggering the browser print dialog with the rendered preview.

- **Category**: `export`
- **Read-only**: no
- **Inputs**: none
- **Output**: `{ ok: true, documentId, format: "pdf", warnings: [] }`
- **When to use**: For print-ready output. Use `export_document_html` for a downloadable HTML file.

#### `get_export_status`

Return the status of an asynchronous export job.

> **Status note**: This is a forward-looking placeholder for future async export support. Today FlatWrite exports are synchronous (browser-initiated new tab or print dialog), so the executor always returns `{ ok: true, jobId, status: "completed" }` with no `downloadUrl`.

- **Category**: `export`
- **Read-only**: yes
- **Inputs**: `jobId` (required string)
- **Output**: `{ ok: true, jobId, status: "completed" }` (no `downloadUrl` for synchronous exports)
- **When to use**: After `export_document_pdf` or `export_document_html` if the export is queued. FlatWrite exports are synchronous, so this always returns `completed` immediately.

### Share tools (1)

#### `create_share_link`

Create a shareable URL for the active document and copy it to the clipboard.

- **Category**: `share`
- **Read-only**: no
- **Inputs**: none
- **Output**: `{ ok: true, documentId, shareUrl, expiresAt }`
- **When to use**: To share the document. The link expires after 30 days. Use `get_document_state` to check `canShare` before calling.

---

## 7. Output schemas — what every tool returns

Every tool returns a **discriminated envelope**: a JSON object where the `ok` field tells you whether the call succeeded, and the remaining fields tell you what happened.

### Success shape

```json
{
  "ok": true,
  "kind": "html",
  "document": {
    "title": "My Document",
    "wordCount": 42,
    "charCount": 312
  },
  "artifacts": {
    "head": "<style>...</style>",
    "body": "<body class=\"fw-render\"><main>...</main></body>"
  },
  "warnings": []
}
```

Not every tool returns all of these fields — `kind`, `document`, and `artifacts` are specific to `render_markdown`. But every tool returns `ok: true` on success, plus the fields declared in its `outputSchema`.

### Error shape

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_MARKDOWN",
    "message": "The document exceeds the PDF export size limit.",
    "retryable": false
  }
}
```

Every error includes a machine-readable `code`, a human-readable `message`, and a `retryable` flag that tells the agent whether to try again.

### Why this matters

Before this pattern, tools returned free-form strings or HTML blobs. An agent had to guess whether the call worked by parsing the output. Now, the agent branches on `ok`:

- `ok: true` → read the tool-specific success fields
- `ok: false` → read `error.code` and decide what to do

This is what the WebMCP scanner checks for when grading a site's MCP implementation. Every FlatWrite tool has an `outputSchema` with at least one required top-level field, and every schema has `additionalProperties: false` so agents can pre-validate returned data.

---

## 8. Error handling

FlatWrite tools return typed errors, not exceptions. When a tool fails, the `execute` handler returns a structured error result instead of throwing:

| Error code | Meaning | Retryable? |
|---|---|---|
| `INVALID_INPUT` | Required argument missing or empty | No |
| `INVALID_URL` | URL is not parseable | No |
| `UNSUPPORTED_SCHEME` | URL uses ftp:// or similar | No |
| `DISALLOWED_HOST` | URL host is not on the allowlist | No |
| `INVALID_FONT_FAMILY` | Font family is not bundled | No |
| `RENDER_FAILED` | Upstream render Worker returned an error | Yes (if 401) |
| `BRIDGE_UNAVAILABLE` | Editor bridge (`window.__flatwrite`) not ready | Yes |
| `BRIDGE_ERROR` | Editor bridge threw an error | Maybe |
| `OPEN_FAILED` | Could not fetch the document from the URL | Maybe |
| `EXPORT_FAILED` | Export operation failed | Maybe |
| `SHARE_FAILED` | Share link creation failed | Maybe |
| `TOO_LARGE` | Document exceeds the 400K char share limit | No |

The error envelope is the same regardless of which surface you use (WebMCP, MCP server, or HTTP API). Agents can branch on `error.code` without parsing error messages.

---

## 9. Using the MCP server (stdio)

The MCP server is a Node.js process that speaks the MCP protocol over stdin/stdout. It's designed for local-process MCP clients like Claude Desktop.

### Setup

```bash
cd mcp/flatwrite-render-server
npm install
npm run build
```

### Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `FLATWRITE_RENDER_API_KEY` | yes | — | Sent as `X-Api-Key` to the upstream render Worker. |
| `FLATWRITE_RENDER_BASE_URL` | no | `https://render.flatwrite.md/render` | Override for self-hosted upstream. |
| `FLATWRITE_TRANSPORT` | no | `stdio` | Set to `streamable-http` for HTTP mode. |
| `FLATWRITE_PORT` | no | `3000` | Bind port for HTTP mode. |

```bash
export FLATWRITE_RENDER_API_KEY="your-64-char-hex-key"
export FLATWRITE_RENDER_BASE_URL="https://render.flatwrite.md/render"  # default
```

### Client config (Claude Desktop example)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "flatwrite-render": {
      "command": "node",
      "args": ["/path/to/flatwrite/mcp/flatwrite-render-server/dist/index.js"],
      "env": {
        "FLATWRITE_RENDER_API_KEY": "your-key"
      }
    }
  }
}
```

### Build & run

```bash
cd mcp/flatwrite-render-server
npm install
npm run build
npm start
```

### Available tools

The stdio server registers two tools:
- `render_markdown` — render raw markdown to HTML fragments
- `render_markdown_from_url` — fetch markdown from a URL and render it

Both return `{ head, body }` in the MCP `structuredContent` format.

### Hermes config

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

---

## 10. Using the Streamable HTTP endpoint

For remote MCP clients (web-based agents, MCP Inspector, etc.), the server can run in Streamable HTTP mode:

```bash
FLATWRITE_TRANSPORT=streamable-http \
FLATWRITE_PORT=3000 \
FLATWRITE_RENDER_API_KEY="your-key" \
node dist/index.js
```

The endpoint is `http://localhost:3000/mcp`. In production, this runs at `https://mcp.flatwrite.md/mcp` via a Cloudflare Worker (`workers/flatwrite-mcp/`).

### Client config

```json
{
  "mcpServers": {
    "flatwrite-render": {
      "type": "streamable-http",
      "url": "https://mcp.flatwrite.md/mcp"
    }
  }
}
```

### Hermes config

```yaml
mcpServers:
  flatwrite-render:
    type: streamable-http
    url: https://mcp.flatwrite.md/mcp
```

### Auth for browser callers

Browser-based callers cannot use `X-Api-Key` (the Worker rejects it when an `Origin` header is present). Instead:

1. POST to `https://render.flatwrite.md/mcp-token` from the browser.
2. Receive `{ token, expiresAt }`.
3. Send the token as `X-Mcp-Token` on subsequent MCP requests.

The `webmcp.js` script handles this automatically — you don't need to mint tokens manually when using the browser tools.

---

## 11. Using WebMCP in the browser

When you visit flatwrite.md in Chrome 146+ (with the WebMCP flag enabled), `webmcp.js` automatically registers 12 tools. An AI agent driving the browser can discover and call them.

### What happens under the hood

1. Page loads → `webmcp.js` executes.
2. It imports tool definitions from `webmcp-tools.js` (generated at build time from `mcpShared.ts`).
3. It imports helpers from `webmcp-shared.js` (compiled from `mcpShared.ts` — validation functions, allowlists, body builders).
4. It probes `document.modelContext` (Chrome 150+) and falls back to `navigator.modelContext` (Chrome 149 DevTrial).
5. For each tool in `DOC_TOOLS`, it calls `mc.registerTool({ ...tool, execute: EXECUTORS[tool.name] })`.
6. It pre-warms a token from `/mcp-token` so the first `render_markdown` call is fast.

### The editor bridge

Browser-side tools that interact with the editor (lifecycle, export, share) go through `window.__flatwrite`, a bridge object that `app.js` exposes:

| Bridge method | What it does | Used by |
|---|---|---|
| `getDocumentState()` | Returns current title, word count, mode, unsaved flag, etc. | `get_document_state` |
| `createDocument(md, title)` | Clears the editor and sets new content | `create_document` |
| `openDocument(url)` | Fetches markdown from a URL or share link and loads it | `open_document` |
| `updateDocumentContent(md)` | Replaces editor content and triggers re-render | `update_document_content` |
| `listRecentDocuments()` | Returns recently opened docs from IndexedDB | `list_recent_documents` |
| `renderPreview()` | Switches to preview mode and renders | `render_markdown_preview` |
| `exportHTML()` | Triggers HTML export in a new tab | `export_document_html` |
| `exportPDF()` | Triggers the browser print dialog | `export_document_pdf` |
| `createShareLink()` | POSTs to `/api/share` and returns a share URL | `create_share_link` |

If the bridge isn't ready (e.g. `app.js` hasn't loaded yet), tools return a `BRIDGE_UNAVAILABLE` error with `retryable: true`.

---

## 12. Using the plain HTTP API

The simplest way to render markdown without any MCP client:

```bash
curl -X POST https://render.flatwrite.md/render \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: YOUR_KEY" \
  -d '{"markdown": "# Hello", "font": "Inter", "docEngine": "none"}'
```

### Full parameter reference

| Parameter | Type | Values | Default |
|---|---|---|---|
| `markdown` | string | Raw markdown content | — |
| `markdownUrl` | string | URL on allowlisted host | — |
| `font` | string | `Inter`, `JetBrains Mono`, `Lato`, `Lora`, `Merriweather`, `Playfair Display`, `Comfortaa`, `Unbounded` | `Inter` |
| `appFramework` | string | `spectre`, `poshui`, `pico`, `milligram`, `chota` | — |
| `size` | string or number | Scale token (`"-1"`, `"0"`, `"1"`) or absolute px (8–72) | `0` |
| `weight` | string or number | Scale token or absolute (100–900) | `0` |
| `line` | string or number | Scale token or absolute (0.8–4.0) | `0` |
| `docEngine` | string | `none`, `pagedjs`, `vivliostyle` | `none` |
| `surfaceMode` | string | `doc`, `app` | `doc` |
| `pageSize` | string | `A0`–`A5`, `Letter`, `Legal` | `A4` |
| `orientation` | string | `portrait`, `landscape` | `portrait` |
| `marginsLR` | string | `narrow`, `normal`, `wide` | `normal` |
| `marginsTB` | string | `narrow`, `normal`, `wide` | `normal` |
| `footer` | boolean | Include page-number footer | `false` |
| `width` | number | Content width in px (400–1400) | `780` |
| `theme` | string | Free-form (e.g. `"light"`, `"dark"`) | — |

Provide exactly one of `markdown` or `markdownUrl`. If both are sent, `markdown` wins and `markdownUrl` is used as the base URL for resolving relative links.

---

## 13. Architecture: where the code lives

```
flatwrite/
├── mcp/flatwrite-render-server/     ← MCP server (stdio + Streamable HTTP)
│   ├── src/
│   │   ├── index.ts                 ← Entry point (stdio mode)
│   │   ├── streamableHttpServer.ts  ← Streamable HTTP transport
│   │   ├── renderClient.ts          ← HTTP client for the render Worker
│   │   ├── tools/
│   │   │   ├── renderMarkdown.ts    ← render_markdown tool handler
│   │   │   ├── renderMarkdownFromUrl.ts ← render_markdown_from_url tool
│   │   │   └── error.ts            ← Shared error-result helper
│   │   └── shared/
│   │       └── mcpShared.ts         ← SINGLE SOURCE OF TRUTH (schemas, tools, allowlists)
│   └── scripts/
│       └── build-manifest.mjs       ← Generates manifests + webmcp-tools.js
│
├── public/                          ← Browser-side assets
│   ├── webmcp.js                    ← WebMCP runtime (imports tools, binds executors)
│   ├── webmcp-tools.js              ← GENERATED tool definitions (from build-manifest.mjs)
│   ├── webmcp-shared.js             ← COMPILED mcpShared.ts (allowlists, validators)
│   ├── app.js                       ← Editor logic + window.__flatwrite bridge
│   ├── index.html                   ← Page with <link rel="model-context"> manifest pointers
│   └── .well-known/
│       ├── model-context.docs.json  ← GENERATED Docs manifest (12 tools)
│       └── model-context.apps.json  ← GENERATED Apps manifest (2 tools)
│
├── workers/
│   ├── flatwrite-render/            ← Cloudflare Worker: render.flatwrite.md
│   │   └── src/index.js             ← JSON render API + /mcp-token minting
│   └── flatwrite-mcp/               ← Cloudflare Worker: mcp.flatwrite.md
│       └── src/index.js             ← MCP Streamable HTTP transport (edge)
│
├── api/
│   ├── render.js                    ← Canonical /api/render handler (Node.js)
│   ├── share.js                     ← Share link creation (Dustebin proxy)
│   └── s.js                         ← Share link retrieval
│
├── test/
│   └── webmcp.test.js               ← 47 tests: registration, handlers, parity, scan-oriented
│
└── openapi.yaml                     ← OpenAPI spec for the HTTP API
```

### The single-source-of-truth principle

`mcpShared.ts` is the canonical definition for:
- Tool names, descriptions, and categories
- Input field specifications (types, enums, ranges)
- Output schemas (discriminated envelopes)
- Allowlists (fonts, frameworks, doc engines, page sizes, etc.)
- Handler configurations (URLs, transports, auth notes)
- Validation functions (`validateMarkdownUrl`, `validateFontFamily`)
- Style translation (`toCanonicalStyle`)
- Token utilities (`mintToken`, `verifyToken`)

At build time, `build-manifest.mjs` reads the compiled `mcpShared.js` and generates:
1. `public/.well-known/model-context.docs.json` — 12-tool manifest
2. `public/.well-known/model-context.apps.json` — 2-tool manifest
3. `public/webmcp-tools.js` — JS module with tool definitions for `webmcp.js`

The MCP server (`mcp/flatwrite-render-server/`) imports `mcpShared.ts` directly at compile time. The Cloudflare Workers import `webmcp-shared.js` (the compiled output). The browser imports both `webmcp-shared.js` and `webmcp-tools.js`.

This means **adding a new tool is a single edit in `mcpShared.ts`** — the manifests, the runtime registration, and the tests all pick it up automatically on the next build.

---

## 14. Build & deployment

### Building the MCP server and generating manifests

```bash
cd mcp/flatwrite-render-server
npm run build
```

This runs:
1. `tsc` — compiles TypeScript to `dist/`
2. Copies `dist/shared/mcpShared.js` to `public/webmcp-shared.js`
3. Runs `build-manifest.mjs` — generates manifests + `webmcp-tools.js`

Output:
```
wrote public/.well-known/model-context.docs.json (12 tools, status=ready)
wrote public/.well-known/model-context.apps.json (2 tools, status=ready)
wrote public/webmcp-tools.js (runtime tool definitions)
build-manifest: 2 manifest files written + 1 runtime module.
```

### Deploying the Cloudflare Workers

```bash
# Render Worker (render.flatwrite.md)
cd workers/flatwrite-render
wrangler deploy

# MCP Worker (mcp.flatwrite.md)
cd workers/flatwrite-mcp
wrangler deploy
```

Set the `API_KEY` secret on each Worker:
```bash
wrangler secret put API_KEY
```

### Deploying the static site

The `public/` directory is served as a static site. The manifests and generated JS files are committed to the repo so they're available without a build step in the deployment pipeline.

---

## 15. Testing

```bash
# Run all tests
bun test

# Run only WebMCP tests
bun test test/webmcp.test.js
```

The test suite (242 tests across 9 files) includes:

### MCP server tests

The `streamableHttp.test.ts` suite spins up a real HTTP server on a random port and roundtrips JSON-RPC over the wire, including:

- `initialize` and `tools/list` for capability discovery
- `tools/call` for both tools, verifying head/body shape
- Pre-flight rejection of disallowed URLs, unsupported schemes, malformed URLs, and unrecognised font families
- CORS preflight (204 with full headers)
- Auth (401 for wrong `X-Api-Key`)

The upstream call is mocked via `mock.module("../src/renderClient.js", ...)`, so the tests don't depend on the live API or an API key.

### Tool registration tests
- All 12 tools are registered from the generated `DOC_TOOLS` array
- Input schemas have correct types, enums, and ranges
- Output schemas use the discriminated `{ ok, kind, ... }` pattern
- Both Chrome 149 (`navigator.modelContext`) and Chrome 150+ (`document.modelContext`) probes work

### Handler tests
- `render_markdown` validates inputs and returns typed errors
- Token minting uses `X-Mcp-Token` (never `X-Api-Key`)
- Friendly aliases (`fontFamily` → `font`) translate to canonical names
- URL validation rejects disallowed hosts, non-http schemes, and malformed URLs
- `list_render_options` returns the full allowlist with defaults

### Manifest parity tests
- Manifest and runtime declare the same tool set
- Manifest and runtime declare the same `outputSchema` per tool
- Manifest and runtime declare the same required input fields
- `displayHints.inputFieldAliases` keys exist in both surfaces

### Scan-oriented tests (grader-facing)
- Every tool has `name`, `description`, `inputSchema`, and `outputSchema`
- Every `outputSchema` has at least one required top-level field
- Every tool has a `category` field
- No two tools have overlapping names
- No two tools have indistinguishable descriptions (first 40 chars differ)
- Every tool name starts with a verb (`create_`, `open_`, `get_`, etc.)
- Manifests and runtime registry expose the same tool set
- Every `outputSchema` has `additionalProperties: false`
- Lifecycle tools return `documentId`
- Export tools return `format`

---

## 16. Glossary

| Term | Meaning |
|---|---|
| **MCP** | Model Context Protocol — an open standard for AI agents to call external tools |
| **WebMCP** | Browser-based variant where web pages register tools via `document.modelContext` |
| **Tool** | A named capability with an input schema, output schema, and execute handler |
| **Manifest** | A static JSON file at `.well-known/model-context.*.json` declaring a site's tools |
| **Surface** | A grouping of tools by context — FlatWrite has "doc" (12 tools) and "app" (2 tools) |
| **Discriminated envelope** | A response shape where `ok: true/false` tells you which fields to read |
| **X-Api-Key** | Long-lived server-to-server API key (never in browser JS) |
| **X-Mcp-Token** | Short-lived (60s) HMAC-signed browser-safe token |
| **Bridge** | `window.__flatwrite` — the object `app.js` exposes for WebMCP tools to interact with the editor |
| **Canonical style** | The compact field names the renderer reads (`font`, `size`, `weight`, `line`) |
| **Friendly alias** | The human-readable names (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`) |
| `mcpShared.ts` | The single source of truth for all tool definitions, schemas, and allowlists |
| `webmcp-tools.js` | Generated JS module with tool definitions (consumed by `webmcp.js`) |
| `webmcp-shared.js` | Compiled `mcpShared.ts` — allowlists, validators, token utilities (consumed by browser + Workers) |
