# FlatWrite — Technical Specification

Engineering reference for FlatWrite: architecture, conversion, rendering, deployment, security, and testing. For the product overview, see [README.md](./README.md); for product-design principles, see [.impeccable.md](./.impeccable.md).

## 1. System overview

FlatWrite has no always-on VM or container. The editor is a static browser application; interactive conversion runs as WebAssembly in the user's browser; programmatic conversion runs in a Cloudflare Worker; remaining backend behavior is implemented as Cloudflare Workers and small serverless handlers.

| Plane | Responsibility | Implementation |
|---|---|---|
| Client | Editor, interactive conversion, OCR, tables, typography, pagination | Vanilla JS SPA, AnyDoc/pdf-inspector WASM, Tesseract.js, Paged.js, Vivliostyle |
| Edge APIs | Render, extract, assist, MCP, token minting | Independent Cloudflare Workers on `*.flatwrite.md` |
| Apex host | Static app and `/api/*` adapters | Vercel production deployment plus a Cloudflare Workers mirror |
| Share backend | Paste storage for share links | External Dustebin service configured by `DUSTEBIN_BASE_URL` |

The defining migration decision: **the retired Python/FastAPI/Fly.io conversion service was replaced by pinned Rust-derived WASM modules**. Local interactive conversion never transits a conversion server; the public extract API executes the same engines inside the extract Worker isolate.

### Browser application and rendering

The browser app is framework-free vanilla JavaScript centered on `public/app.js`.

- **Persistence:** IndexedDB stores the active document and preferences. YAML frontmatter carries those settings into shared documents.
- **Modes:** Edit shows the markdown source; View shows the styled preview with typography/layout controls; Read is distraction-free, uses the Plain renderer, forces 100% zoom, and hides resize handles.
- **Preview isolation:** rendered output is sanitized and placed in sandboxed iframes. A staging iframe reduces visual flicker during re-renders.
- **Sanitization:** browser rendering uses vendored DOMPurify and fails closed to escaped text if it is unavailable; server rendering uses `sanitize-html` with a matching allowlist.
- **Pagination:** Plain is unpaginated; Paged.js favors speed; Vivliostyle favors complex paged layout and tables. Engine scripts currently load from upstream CDNs rather than vendored assets; Vivliostyle is version-pinned, while the Paged.js URL is not.
- **Typography:** bundled fonts are self-hosted. Browser and server use matching scale tables to map user controls into document CSS. Browser previews/exports link the vendored font stylesheet; server-rendered documents inline font assets.
- **Math Mode:** opt-in per document. `core/math.js` parses TeX-style delimiters into placeholders, then KaTeX renders them before pagination so Paged.js/Vivliostyle receive static math output.
- **App surface:** an unfinished component/framework surface exists behind the `?appsurface=1` opt-in and is not part of the primary document workflow.

## 2. Deployment topology

```text
flatwrite.md                    Cloudflare-proxied Vercel: static public/ app + serverless /api/* handlers
*.thecontrarian.workers.dev     Cloudflare mirror of the static app and /api routing shim
render.flatwrite.md             render API + /mcp-token
extract.flatwrite.md            extract API + /mcp-token
assist.flatwrite.md             Morph AI-assist API + /mcp-token
mcp.flatwrite.md                MCP Streamable HTTP transport
```

Operational facts:

- Pushing `main` ships the production apex through Vercel's git integration.
- The root `wrangler deploy` updates only the Workers mirror described by `wrangler.jsonc`; no production apex route is declared in that file.
- Each subdomain Worker deploys independently from `workers/flatwrite-*/` with its own `wrangler.toml`.
- `workers/flatwrite-extract/deploy.sh` forces the correct config/environment and stashes `public/_redirects` during upload so staging cannot steal the production route and Cloudflare's validator does not reject the SPA fallback.

### Secrets inventory

| Worker | Secrets | Purpose |
|---|---|---|
| `flatwrite` mirror | `INTERNAL_RENDER_KEY`, `DUSTEBIN_BASE_URL` | Render forwarding and share paste access |
| `flatwrite-render` | `API_KEY`, `INTERNAL_RENDER_KEY` | Public auth and HMAC-signed forwarding to `/api/render` |
| `flatwrite-extract` | `API_KEY` | API-key verification and HMAC token minting |
| `flatwrite-assist` | `API_KEY`, Morph credentials | Public auth and Morph access |

`EXTRACT_SERVICE_URL` and `INTERNAL_EXTRACT_KEY` are retired; tests assert that they remain absent from live source.

## 3. Document conversion pipeline

### Engines and formats

Structured conversion uses exact pinned WASM versions:

- `@firecrawl/anydoc-wasm` **0.2.4** — DOC/DOCX/DOCM/ODT/RTF, PPT/PPS/POT/PPTX/PPTM/PPSX/PPSM/ODP, XLS/XLSX/XLSM/XLSB/ODS/CSV, and EPUB.
- `@firecrawl/pdf-inspector-wasm` **1.26.1** — text-based PDFs, including columns, tables, and heading inference.

Do not upgrade casually: behavior is locked by the golden corpus, and the old live Python reference service no longer exists.

### Browser execution

```text
app.js → local-extract.js → extract-worker.js → extract-core.js
                              ↓ lazy-loads one WASM family
                    vendor/anydoc-0.2.4 or pdf-inspector-1.26.1
```

- `extract-core.js` is engine-agnostic shared logic: extension routing, errors, metadata stubs, OCR post-processing, frontmatter, and titles. Engines are injected so the same module runs in the browser, tests, and the extract Worker.
- `extract-worker.js` keeps synchronous WASM CPU work off the main thread and lazy-loads only the needed engine family.
- `local-extract.js` coordinates browser File objects and Tesseract OCR.
- The input ceiling is 25 MiB.

### OCR and deliberate limits

- Standalone PNG/JPEG/GIF/WebP/TIFF images are OCR'd locally with Tesseract.js 7.0.0. OCR lines are reconstructed into headings, lists, and paragraphs by the ported `ocrLinesToMarkdown` logic.
- Tesseract is known to be weaker than the retired RapidOCR pipeline, especially for bullets. Empty or failed OCR degrades to an image metadata stub rather than an error.
- Scanned/image-only PDFs return `422 NEEDS_OCR`; PDF pages are not OCR'd.
- Encrypted files return `422 ENCRYPTED`.
- Audio files produce metadata stubs; there is no transcription.
- The public extract API rejects images and audio with `415 UNSUPPORTED_FILE_TYPE`; OCR is intentionally browser-interactive only.

## 4. Extract API Worker

`workers/flatwrite-extract/` implements `POST https://extract.flatwrite.md/extract`:

```text
multipart/form-data upload (≤25 MiB)
  → auth (X-Api-Key or X-Mcp-Token)
  → extension/type validation
  → in-process WASM conversion
  → { markdown, metadata } or structured error
```

Validation errors use the flat shape `{"error", "code"}`; conversion errors use the legacy wrapped shape `{"detail": {"error", "code"}}` for backward compatibility. A workers.dev-only staging environment exists for measurement and pre-production verification.

## 5. URL import pipeline

`POST /api/import-url` is permanently retired and returns `410 ENDPOINT_RETIRED` because fetching and server-side conversion are no longer conflated.

Its replacement, `POST /api/fetch-document`, performs server-side fetch only:

- accepts `http`/`https` URLs;
- blocks localhost, private, loopback, link-local, CGNAT, multicast, benchmarking, protocol-assignment, and IPv4-transition address ranges;
- validates DNS resolution and revalidates every redirect hop, with a maximum of five redirects;
- enforces a 25 MiB streaming cap, 60 second timeout, and 20 requests/minute/IP limit;
- returns raw bytes as `application/octet-stream` with FlatWrite filename/source headers and `Cache-Control: no-store`;
- never forwards upstream error bodies.

A DNS time-of-check/time-of-use gap remains because neither portability layer exposes connection-level IP pinning. Mitigations are deny-by-default resolution, redirect revalidation, bounded responses, and the recommendation that strict deployments add platform-level egress filtering.

After fetching, the browser constructs a `File` and runs the same local conversion path as drag-and-drop. Direct markdown/text URLs are fetched from the browser when CORS permits; document imports depend on `/api/fetch-document` being deployed.

## 6. Render, share, assist, and MCP

- **Render:** `render.flatwrite.md` is a JSON-first facade over the canonical `/api/render` handler. `core/render.js` backs the HTTP API and MCP surfaces. The browser preview uses a parallel marked pipeline with matching task-list, math, sanitization, and document-CSS behavior; parity is pinned by tests rather than shared imports. Legacy YAML input is preserved.
- **Share:** `/api/share` posts markdown plus style frontmatter to Dustebin with `language: "markdown"`; `/api/s` resolves the paste id. The client enforces a 400,000-character share limit. The server currently requests `expiration: "30d"`, while the client toast says links are available for up to 7 days — a known copy/contract inconsistency that should be reconciled before documenting a precise lifetime.
- **Assist:** `assist.flatwrite.md` implements the Morph pipeline documented in `docs/MORPH-ASSIST.md` (Reflex → Router → Compact → Fast model). The API and WebMCP bridge exist, but the visible editor toolbar is still deliberately gated behind the “coming soon” toast.
- **MCP:** the same tool implementations back the stdio server, Streamable HTTP Worker, in-browser WebMCP tools, and HTTP API. See `mcp/MCP.md`.

## 7. Authentication and security model

Public Workers use two credential types:

- **`X-Api-Key`:** long-lived server-to-server secret. Any request carrying an `Origin` header is rejected with `API_KEY_NOT_ALLOWED_FROM_BROWSER`, and preflight responses do not advertise the header.
- **`X-Mcp-Token`:** 60-second HMAC-signed token minted by `POST /mcp-token` for trusted browser origins. Render/extract tokens use scope `mcp`; assist tokens use scope `assist`.

HMAC comparison is constant-time. Trusted origins include the apex, single-label `*.flatwrite.md` subdomains such as `www`, and worker-specific local-development allowances. CORS is allowlist-only.

Other security properties:

- Interactive local conversion is structurally private: bytes never leave the browser for conversion.
- `/api/fetch-document` is a byte proxy only and does not store fetched documents.
- Browser preview iframes are sandboxed; rendered HTML is sanitized before injection.
- Vendored copies of `marked` and `dompurify` avoid third-party runtime script execution in the apex origin.
- `/api/render` expects an `INTERNAL_RENDER_KEY` HMAC signature when called through the render Worker.

## 8. Error contracts

Canonical public errors:

| Condition | Status | Code | Shape |
|---|---:|---|---|
| Unsupported API file type, including images/audio | 415 | `UNSUPPORTED_FILE_TYPE` | flat validation |
| Payload over 25 MiB | 413 | `PAYLOAD_TOO_LARGE` | flat validation |
| Scanned/image-only PDF | 422 | `NEEDS_OCR` | wrapped conversion |
| Encrypted file | 422 | `ENCRYPTED` | wrapped conversion |
| Conversion engine failure | 500 | `CONVERT_FAILED` | wrapped conversion |
| Invalid/expired token | 401 | `INVALID_TOKEN` | flat |
| API key used from a browser | 401 | `API_KEY_NOT_ALLOWED_FROM_BROWSER` | flat |
| Untrusted origin | 403 | `ORIGIN_NOT_ALLOWED` | flat |
| Rate limit | 429 | `RATE_LIMIT` | flat |
| Retired `/api/import-url` | 410 | `ENDPOINT_RETIRED` | flat |
| Missing Worker secret | 500 | `MISCONFIGURED` | flat |

Browser conversion maps the same codes into user-facing UI. Audio and blank-image metadata stubs are successful responses, not errors.

## 9. Asset vendoring and versioning

`public/vendor/` is committed to git so Vercel, Workers, and tests use bit-identical inputs. Current sizes are approximately:

| Asset | Raw | Gzip-sum |
|---|---:|---:|
| `anydoc-0.2.4/` | 6.40 MiB | 2.79 MiB |
| `pdf-inspector-1.26.1/` | 5.75 MiB | 2.45 MiB |
| `tesseract-7.0.0/` | 14.14 MiB | 7.04 MiB |
| all vendored assets | 26.37 MiB | 12.30 MiB |

Versioned directory names are the cache-busting mechanism: upgrades change paths rather than mutating existing assets. `scripts/vendor-extract-assets.mjs` regenerates the WASM/OCR payload from pinned `node_modules` versions. Application cache-busting is manual and test-enforced through query versions in `public/index.html`.

## 10. Performance characteristics

Production extract-Worker measurements from November 2026 (`scripts/measure-extract-cpu.mjs`, 150+ runs):

- Typical corpus documents: **0–20 ms CPU**; roughly 70 ms wall-clock for a small PPTX.
- WASM startup is single-digit milliseconds per isolate.
- A 2.4 MB DOCX with about 40,000 paragraphs measured **260–345 ms CPU** and returned 200.

The Workers Free plan nominally allows 10 ms CPU/request, but Cloudflare tolerated the measured bursts. Dense Office XML can amplify cost far beyond input size: a 68 KB DOCX with roughly 2M XML nodes converted in about 600 ms in Bun while holding about 300 MiB RSS. Inputs beyond engine ceilings fail with `500 CONVERT_FAILED` rather than crashing the isolate. If Worker error 1102 appears in production, the planned escalation is either a stricter input-node budget or moving only the extract Worker to Workers Paid.

Browser-side conversion has no equivalent request CPU ceiling; a reference PPTX converts in about a second on commodity hardware after lazy engine loading.

## 11. Testing infrastructure

- **Unit/golden tests:** `bun test ./test/*.test.js` currently passes **482 tests across 18 files**. Coverage includes the 30-file golden conversion corpus, error shapes, retired-secret absence, auth, rendering, math, import, share, and cache-version pins.
- **End-to-end:** Playwright covers pagination visual baselines, security, URL import, and network traces proving interactive local conversion does not call a conversion backend.
- **HTTP collections:** Bruno collections are available through `bruno:run:api` and `bruno:run:webmcp`.
- **Production smoke:** migration behavior was verified with scripted drops against the live site and raw curl probes of error contracts.

## 12. Repository layout

```text
public/                     static SPA, conversion pipeline, vendored runtime assets
  app.js                    main browser application
  extract-core.js           shared engine-injected conversion logic
  extract-worker.js         Web Worker host for WASM conversion
  local-extract.js          browser facade and Tesseract orchestration
  vendor/                   committed WASM/OCR/marked/DOMPurify assets
  webmcp*.js                in-browser MCP tools
worker/index.js             Cloudflare mirror: assets binding + /api routing shim
api/                        canonical serverless handlers shared by Vercel/Worker shim
  fetch-document.js         SSRF-hardened remote document fetcher
  import-url.js             retired endpoint; returns 410
  render.js                 canonical render handler
  share.js, s.js            Dustebin share creation/resolution
workers/                    independent render/extract/assist/MCP Workers
mcp/                        stdio MCP server and MCP manual
core/                       shared render, typography, math, auth, and utility logic
scripts/                    vendoring, measurement, fixtures, and e2e helpers
test/                       unit/golden tests, fixtures, and Playwright e2e
bruno/                      HTTP API collections
openapi.yaml                HTTP API specification
.impeccable.md              product design context
vercel.json                 apex routing and cache headers
wrangler.jsonc              Workers mirror configuration
```
