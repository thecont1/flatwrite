# FlatWrite — Technical Specification

This document is the detailed engineering breakdown of FlatWrite for technical inspectors: architecture, conversion pipeline, deployment topology, security model, error contracts, and testing. For the product overview, see [README.md](./README.md).

## Table of contents

1. [System overview](#1-system-overview)
2. [Deployment topology](#2-deployment-topology)
3. [The document conversion pipeline](#3-the-document-conversion-pipeline)
4. [The extract API worker](#4-the-extract-api-worker)
5. [URL import pipeline](#5-url-import-pipeline)
6. [Render, share, and assist services](#6-render-share-and-assist-services)
7. [Authentication and security model](#7-authentication-and-security-model)
8. [Error contracts](#8-error-contracts)
9. [Asset vendoring and versioning](#9-asset-vendoring-and-versioning)
10. [Performance characteristics](#10-performance-characteristics)
11. [Testing infrastructure](#11-testing-infrastructure)
12. [Repository layout](#12-repository-layout)

---

## 1. System overview

FlatWrite is a zero-VM, zero-container web application. There is no server-side application runtime anywhere in the system: the editor is a static single-page app, document conversion executes as WebAssembly either inside the user's browser or inside Cloudflare Workers, and all backend functionality is implemented as edge Workers plus one serverless function host.

The system has four planes:

| Plane | What runs there | Technology |
|---|---|---|
| **Client** | Editor, all interactive document conversion, image OCR, table workshop, pagination engines | Vanilla JS SPA, AnyDoc/pdf-inspector WASM, Tesseract.js, Paged.js, Vivliostyle |
| **Edge API** | Public render/extract/assist/MCP APIs, token minting | Cloudflare Workers on `*.flatwrite.md` subdomains |
| **Static host + API adapter** | `flatwrite.md` apex, `/api/*` serverless functions | Vercel (git-integration deploys) with a mirror Cloudflare Worker for `*.workers.dev` |
| **Share backend** | Paste bin for shareable URLs | External `dustebin` service, configured via `DUSTEBIN_BASE_URL` |

The defining architectural decision (November 2026 migration): **document conversion never runs on a VM or container.** The previous implementation — a Python/FastAPI service wrapping AnyDoc, pdf-inspector, and RapidOCR on Fly.io — was fully retired and the Fly app destroyed. The conversion engines now ship as WebAssembly compiled from the same Rust cores, pinned to exact versions, vendored into the repository, and executed wherever the work is cheapest:

- Interactive conversion (drag-and-drop, URL import) runs **in the user's browser** — file bytes never transit any server.
- The public programmatic extract API runs **in-process in a Cloudflare Worker**.

## 2. Deployment topology

```
 flatwrite.md (apex)          — Vercel, auto-deployed from git main.
                                Static assets from public/ + serverless /api/* functions.
 *.thecontrarian.workers.dev  — Cloudflare Workers mirror of the same static app
                                (wrangler deploy of worker/index.js). Not the production
                                apex path; useful for pre-production verification.
 render.flatwrite.md          — Cloudflare Worker: render API + /mcp-token
 extract.flatwrite.md         — Cloudflare Worker: extract API + /mcp-token
 assist.flatwrite.md          — Cloudflare Worker: Morph AI-assist pipeline + /mcp-token
 mcp.flatwrite.md             — Cloudflare Worker: MCP Streamable HTTP transport
```

**Critical operational fact:** pushing to `main` on GitHub is what ships the production apex. `wrangler deploy` of the root project only affects the `workers.dev` mirror. DNS for the zone is Cloudflare-proxied, but the apex ultimately serves from Vercel.

The four subdomain Workers are deployed independently with wrangler from their own directories (`workers/flatwrite-*/`), each with its own `wrangler.toml`. The extract Worker additionally has `deploy.sh`, which exists because wrangler 4.x auto-discovers the parent `wrangler.jsonc` and would otherwise deploy to the wrong Worker; the script forces `--config wrangler.toml`, always passes an explicit `--env` (so the staging deploy can't steal the production route), and stashes `public/_redirects` during upload because the SPA-fallback rule trips Cloudflare's upload validator.

### Secrets inventory

| Worker | Secrets | Notes |
|---|---|---|
| `flatwrite` (apex mirror) | `INTERNAL_RENDER_KEY`, `DUSTEBIN_BASE_URL` | No extract-related secrets remain |
| `flatwrite-render` | `API_KEY`, `INTERNAL_RENDER_KEY` | `INTERNAL_RENDER_KEY` HMAC-signs forwarding to `/api/render` |
| `flatwrite-extract` | `API_KEY` | HMAC key for token mint/verify and `X-Api-Key` auth |
| `flatwrite-assist` | `API_KEY` + Morph credentials | See `docs/MORPH-ASSIST.md` |

The retired `EXTRACT_SERVICE_URL` and `INTERNAL_EXTRACT_KEY` secrets no longer exist anywhere — there is no upstream service left to point at. Repo tests assert their absence from live source.

## 3. The document conversion pipeline

### 3.1 Conversion engines

Two WebAssembly modules compiled from Rust do all structured document conversion:

- **`@firecrawl/anydoc-wasm` 0.2.4** — office formats (DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV/TSV)
- **`@firecrawl/pdf-inspector-wasm` 1.26.1** — text-based PDFs, including column detection, table reconstruction, and heading-tier inference

These versions are exact pins. The WASM builds are not byte-identical to the old Python bindings (they are newer upstream and in some ways better — math handling, xlsb support), so the behavioral contract is enforced by golden fixtures rather than by assuming upstream parity.

One caveat on upgrades: earlier research validated 0.2.5/1.27.1 but production pins 0.2.4/1.26.1. Do not upgrade without re-capturing the golden corpus (`scripts/capture-extract-golden.mjs` no longer has a live Fly reference — regeneration requires a deliberate fixture review).

### 3.2 Client-side execution

Conversion in the browser is a three-layer structure, all in `public/`:

```
app.js  →  local-extract.js  →  extract-worker.js (Web Worker)  →  extract-core.js
                                    ↓ lazy-loads WASM
                              vendor/anydoc-0.2.4/*, vendor/pdf-inspector-1.26.1/*
```

- **`extract-core.js`** is the shared pure-logic module: the extension/type table, OCR line-to-markdown layout reconstruction, metadata stubs for audio/blank images, frontmatter parsing, title extraction, and the error-code mapping. It is engine-agnostic — engines (AnyDoc, pdf-inspector, OCR) are injected, which is what makes the same logic testable in Node/bun and reusable across browser and Worker contexts. It is a line-for-line port of the retired Python service's `converter.py`/`ocr.py`/`rules.py` behavior.
- **`extract-worker.js`** is a module Web Worker wrapper. AnyDoc/pdf-inspector calls are synchronous CPU work, so they must not run on the main thread. WASM modules are lazy-loaded on first use per format family — a PDF conversion never downloads the AnyDoc module.
- **`local-extract.js`** is the main-thread facade. Images are the exception to worker placement: Tesseract.js already owns its internal worker, so OCR is orchestrated here and only the layout reconstruction is shared.

### 3.3 Image OCR

Standalone image files (png/jpg/jpeg/gif/webp/tiff) dropped into the editor are OCR'd locally with **Tesseract.js 7.0.0** (English data, `@tesseract.js-data/eng` 1.0.0, core 7.0.0). Recognized line boxes `{x, y, w, h, text, conf}` are flattened into structured markdown by `ocrLinesToMarkdown` — headings, bullet lists, continuation lines — a direct port of the old service's RapidOCR post-processing.

Known quality regression, accepted as a product decision: Tesseract is visibly weaker than RapidOCR, especially on bullet glyphs. If OCR finds no readable text, or the OCR engine itself fails, the result degrades to a metadata stub (filename/size/type + explanatory note) rather than an error — same contract as the Python service.

### 3.4 What is deliberately not converted

- **Scanned or image-only PDFs** are rejected with `422 NEEDS_OCR` everywhere. No part of the system OCRs PDF pages (the retired service didn't truly either).
- **Encrypted files** are rejected with `422 ENCRYPTED`.
- **Audio files** get a metadata-only stub — there is no transcription and never was.
- **Images/audio through the public extract API** are rejected with `415 UNSUPPORTED_FILE_TYPE` — OCR is browser-interactive only, by design.

## 4. The extract API worker

`workers/flatwrite-extract/` implements `POST https://extract.flatwrite.md/extract` — the public programmatic conversion API. It runs the same two WASM modules **in-process inside the Worker isolate**; there is no upstream service, no `UPSTREAM_URL`, no HMAC re-signing hop.

Request flow:

```
multipart/form-data upload (≤25 MB)
  → auth (X-Api-Key or X-Mcp-Token, see §7)
  → validation (extension/type table shared with the browser pipeline)
  → in-process WASM conversion
  → { markdown, metadata } or structured error
```

Error wire shapes intentionally differ by stage (backward compatibility with the old API's consumers):

- **Validation failures** (auth, unsupported type, size) — flat: `{"error", "code"}`
- **Conversion failures** — FastAPI-style wrapped: `{"detail": {"error", "code"}}`

A staging copy (`flatwrite-extract-staging`, workers.dev-only) exists for pre-production measurement. `./deploy.sh --env staging` deploys it; the production route lives only in `[env.production]` so a staging deploy can never steal `extract.flatwrite.md/*`.

## 5. URL import pipeline

`POST /api/import-url` is retired — it returns `410 ENDPOINT_RETIRED` permanently. The old endpoint conflated fetching with server-side conversion, which is impossible in the zero-VM architecture. Its replacement splits the two responsibilities:

**`POST /api/fetch-document`** (`api/fetch-document.js`) — server-side fetch only:

- Body: `{url}`; `http`/`https` only
- SSRF hardening: no localhost, no private/reserved network ranges, DNS resolution validation with a rebinding guard (Workers `resolve4`/`resolve6` fallback), and **every redirect hop re-validated** (manual redirect following, max 5)
- 25 MB streaming cap, 60 s timeout, 20 req/min/IP rate limit
- Extension validated against the same `EXTENSIONS` table the browser converter uses
- Success: raw bytes as `application/octet-stream` with `X-Flatwrite-Filename` (URI-encoded), `X-Flatwrite-Source-Url`, `X-Flatwrite-Source-Content-Type`, `Cache-Control: no-store`. Raw upstream error bodies are never forwarded.

The browser then constructs a `File` from those bytes and runs the exact same local conversion pipeline as drag-and-drop, including frontmatter parsing and title extraction. There is one document model — everything lands in the editor through `setEditorContent()`.

Direct URL loading (sidebar → From URL) still fetches plain markdown/text directly from the browser when CORS allows, and falls back to `/api/fetch-document` only for convertible document types. Consequence: against a static-assets-only deployment (no `/api` functions), CORS-blocked document imports cannot work — the conversion itself has no such dependency.

## 6. Render, share, and assist services

- **Render** — `render.flatwrite.md` is a JSON-first façade in front of the canonical `/api/render` handler, forwarding with an `INTERNAL_RENDER_KEY` HMAC signature. Rendering itself (`core/render.js`, marked-based) is shared code executed identically in the browser preview, the API, and the MCP tools — one renderer, byte-identical output across all surfaces. Legacy YAML input mode is preserved.
- **Share** — markdown is POSTed to a `dustebin` paste service (`DUSTEBIN_BASE_URL`); the resulting short id becomes the share URL (`/s/:id` resolves it). This is why shared links are short and survive URL-length limits.
- **MCP** — four surfaces documented in `mcp/MCP.md`: a stdio server (`mcp/flatwrite-render-server`), the Streamable HTTP worker (`mcp.flatwrite.md`), in-browser WebMCP tools (`public/webmcp*.js`), and the plain HTTP API. The same tool implementations back all four.
- **Assist** — `assist.flatwrite.md` proxies the Morph models pipeline (Reflex → Router → Compact → Fast) for rewrite/shorten/grammar/custom instructions. Spec in `docs/MORPH-ASSIST.md`.

## 7. Authentication and security model

The public Workers share one auth model (`public/webmcp-shared.js` is the canonical implementation):

- **`X-Api-Key`** — long-lived secret (`API_KEY` Worker secret), accepted only from non-browser callers. Any request carrying an `Origin` header with an API key is rejected (`API_KEY_NOT_ALLOWED_FROM_BROWSER`) so the key can never be exercised from a browser context.
- **`X-Mcp-Token`** — short-lived HMAC-signed token minted by `POST /mcp-token`, gated by a trusted-origin allowlist (`https://flatwrite.md`, `https://*.flatwrite.md`, plus an opt-in `ALLOWED_DEV_ORIGINS` var for local development) and per-IP rate limiting. This is how the browser editor and WebMCP clients authenticate.
- HMAC comparison is constant-time; tokens carry scope (`mcp`, `assist`) and expiry.

Transport security properties worth noting:

- Interactive conversion is structurally private: document bytes never leave the browser, verified in production by network-trace regression tests asserting zero requests to any conversion endpoint during a drop.
- `/api/fetch-document` never forwards upstream response bodies on failure — a scanned/attacker-controlled upstream cannot smuggle content-shaped errors into the client.
- CORS on the API workers is allowlist-only; preflight succeeds solely for trusted origins.

## 8. Error contracts

| Condition | Status | Code | Shape |
|---|---|---|---|
| Unsupported type for the API (incl. all images/audio) | 415 | `UNSUPPORTED_FILE_TYPE` | flat (validation) |
| Scanned/image-only PDF | 422 | `NEEDS_OCR` | wrapped (conversion) |
| Encrypted file | 422 | `ENCRYPTED` | wrapped |
| Conversion engine failure | 500 | `CONVERT_FAILED` | wrapped |
| Invalid/expired token | 401 | `INVALID_TOKEN` | flat |
| API key used from a browser | 401 | `API_KEY_NOT_ALLOWED_FROM_BROWSER` | flat |
| Untrusted origin | 403 | `ORIGIN_NOT_ALLOWED` | flat |
| Rate limit | 429 | `RATE_LIMIT` | flat |
| `/api/import-url` anything | 410 | `ENDPOINT_RETIRED` | flat |
| Missing worker secret | 500 | `MISCONFIGURED` | flat |

The browser drop pipeline maps the same codes into user-facing error UI; audio/blank-image metadata stubs are success responses, not errors.

## 9. Asset vendoring and versioning

WASM and OCR assets are **committed to git** under `public/vendor/` (≈35 MB total, ≈16 MB gzipped on the wire):

```
public/vendor/
  anydoc-0.2.4/          6.4 MB
  pdf-inspector-1.26.1/  5.8 MB
  tesseract-7.0.0/       23 MB (multiple SIMD variants for browser support tiers)
  extract-manifest.json  — version map consumed at runtime
```

Rationale: production ships through Vercel's git integration, and build-time generation could not be verified to run reliably there. Committed assets are deployment-target-independent and bit-deterministic — `scripts/vendor-extract-assets.mjs` copies exactly these files out of the pinned `node_modules` versions, so local builds and wrangler deploys regenerate byte-identical output. The versioned directory names are the cache-busting mechanism: upgrades change the path, never the contents of an existing path.

Cache-busting of application code is manual and test-enforced: `app.js?v=N` and `local-extract.js?v=N` query strings in `index.html` are pinned by unit tests, forcing a deliberate bump on every change. (Vercel serves immutable-cache headers for static assets; see `vercel.json`.)

## 10. Performance characteristics

Measured against the production extract Worker (Workers Free plan, November 2026, `scripts/measure-extract-cpu.mjs` + `wrangler tail`, 150+ runs):

- Typical documents (the 30-file corpus: pptx/docx/xlsx/pdf/csv/epub): **0–20 ms CPU**, ~70 ms wall-clock end-to-end for a small pptx.
- WASM module startup is single-digit milliseconds per isolate; both modules combined are ~12.7 MB raw, well under the 64 MiB uncompressed Worker size limit (bundle ≈6.5 MiB, ≈2.9 MiB gzip) and the 128 MB isolate memory limit even with a 25 MB upload expanded in memory.
- A stress-case 2.4 MB docx with ~40k paragraphs measured **260–345 ms CPU** and still returned 200.

The Workers Free plan nominally allows 10 ms CPU per request. Cloudflare tolerates bursts in practice — every measured request succeeded — but very large files rely on that tolerance and could theoretically hit error 1102 under strict enforcement. This is a documented best-effort posture: the plan is deliberately unchanged because the high-volume interactive path never touches the Worker at all. The escalation path, if 1102s ever appear in production logs, is moving only the extract Worker to Workers Paid (5 min CPU ceiling).

Browser-side conversion has no such ceiling: a reference pptx converts in roughly a second on commodity hardware including WASM warm-up, with the ~2.9 MB compressed engine lazy-loaded once per format family.

## 11. Testing infrastructure

- **Unit/golden tests** — `bun test ./test/*.test.js`, 480 tests. Includes the 30-file golden corpus (`test/fixtures/extract-corpus/` + `extract-golden/`) captured from the production Fly service before decommissioning, so the WASM pipeline is continuously compared against the behavior users actually experienced. Also asserts negative contracts: retired secrets absent from source, import-url retirement shape, cache-bump versions pinned.
- **End-to-end** — Playwright (`test/e2e/`), including network-trace assertions that interactive conversion fires zero requests toward any conversion backend, and the URL-import flow.
- **HTTP API collections** — Bruno collections (`bruno:run:api`, `bruno:run:webmcp` npm scripts).
- **Production smoke** — the migration was verified in production with scripted Playwright drops (exact 232-character golden markdown reproduced against the live site) and raw `curl` probes of every error contract.

## 12. Repository layout

```
public/                  static SPA — editor, conversion pipeline, vendored WASM
  app.js                 main application logic (~5.8k lines)
  extract-core.js        shared conversion logic (engine-injected, port of Python service)
  extract-worker.js      Web Worker host for WASM conversion
  local-extract.js       main-thread facade + Tesseract orchestration
  vendor/                committed WASM/OCR assets (see §9)
  webmcp*.js             in-browser MCP tools
worker/index.js          Cloudflare mirror of apex: assets binding + /api routing shim
api/                     serverless functions (Vercel + Worker shim share these)
  fetch-document.js      SSRF-hardened document fetcher
  import-url.js          retired — returns 410
  render.js              canonical render handler
  share.js, s.js         paste-bin share + resolution
workers/
  flatwrite-render/      render API Worker
  flatwrite-extract/     extract API Worker (+ deploy.sh, staging env)
  flatwrite-assist/      Morph AI-assist Worker
  flatwrite-mcp/         MCP Streamable HTTP Worker
mcp/                     stdio MCP server + MCP.md spec
core/                    shared render logic
scripts/                 vendoring, CPU measurement, golden capture
test/                    unit/golden tests + fixtures + e2e
openapi.yaml             HTTP API specification
vercel.json              apex routing + immutable asset caching
wrangler.jsonc           apex-mirror Worker config (workers.dev)
```
