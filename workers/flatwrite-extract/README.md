# flatwrite-extract Worker

Cloudflare Worker serving the public `https://extract.flatwrite.md/extract`
endpoint. It converts documents to Markdown **in-process** with WASM
engines — `@firecrawl/anydoc-wasm` (office/epub/csv, PDF fallback) and
`@firecrawl/pdf-inspector-wasm` (primary PDF path) — initialized once per
isolate at module scope. There is no upstream service: the previous
Fly.io proxying, HMAC request signing (`INTERNAL_EXTRACT_KEY`), and
`UPSTREAM_URL` are gone.

## Endpoints

- `POST /extract` (primary): `multipart/form-data` with a single
  `file` field. Converts in-process and returns
  `{ markdown, metadata: { extractionType, filename, fileType, sizeBytes } }`.
- `POST /mcp-token`: Mints a short-lived (60s) HMAC-signed token for
  browser-side WebMCP clients. Mirrors the render worker's flow.
- `OPTIONS`: 204 with CORS headers (trusted origins only).
- Any other method or path: 405 / 404.

## Accepted file types

Documents only: `pdf`, `word`, `powerpoint`, `excel`, `csv`, `epub`.

**Images and audio are rejected with 415 UNSUPPORTED_FILE_TYPE** on this
API, even though the shared extraction core supports them — OCR and audio
metadata extraction run browser-side instead, and the public API is
document-only by design.

## Error wire contract

Two shapes, preserved from the previous architecture (the frontend and
API clients parse both):

- **Worker-level validation** (method, auth, content-type, missing
  multipart boundary, 25 MB size pre-check, missing file field):
  flat `{ error, code }`.
- **Conversion-stage errors** (everything `convert()` raises):
  FastAPI-style wrapped `{ detail: { error, code } }` —
  `EMPTY_FILE` 400, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_FILE_TYPE` 415,
  `ENCRYPTED` 422, `NEEDS_OCR` 422, `CONVERT_FAILED` 500.

## Auth

Two paths:

- `X-Api-Key` — long-lived key, server-to-server only. Rejected if
  the request carries an `Origin` header.
- `X-Mcp-Token` — short-lived HMAC (60s), browser-safe. The Worker
  validates the signature against `env.API_KEY`.

## CORS

Same trusted-origin allowlist as `flatwrite-render`:

```
https://flatwrite.md
https://<anything>.flatwrite.md
```

Untrusted origins get no `Access-Control-Allow-Origin`, so the
browser blocks the response from being read by JS.

The preflight `Access-Control-Allow-Headers` is
`Content-Type, X-Mcp-Token, Accept`. `X-Api-Key` is intentionally
absent — long-lived keys are server-to-server only.

## Secrets (set via `wrangler secret put`)

| Name | Purpose |
|---|---|
| `API_KEY` | The public-facing key clients send in `X-Api-Key`. |

Only one secret remains (`INTERNAL_EXTRACT_KEY` is retired with the Fly
service). It must be set **once per environment**:

```sh
wrangler secret put API_KEY --env production
wrangler secret put API_KEY --env staging
```

## Environments and route inheritance (verified)

Verified against the wrangler 4.104 source (`normalizeAndValidateRoute` /
`inheritable` / `triggersDeploy` in `wrangler-dist/cli.js`):

- **`route` IS inherited by named environments**, and wrangler publishes
  inherited routes even when the environment sets `workers_dev = true`.
  Worse, the "route already assigned to another worker" safety check is
  skipped when `workers_dev` is true — so a staging deploy inheriting
  the production route would silently reassign `extract.flatwrite.md/*`
  to the staging worker and steal production traffic.
- Therefore the route lives **only** in `[env.production]`, and
  `[env.staging]` has no route anywhere above it — it is a
  workers.dev-only copy named `flatwrite-extract-staging` by
  construction, not by override.
- Conversely **`vars` is NOT inherited** by environments (wrangler warns
  about this), so each environment carries its own `ALLOWED_DEV_ORIGINS`
  copy.
- `[env.production]` sets `name = "flatwrite-extract"` explicitly —
  without it wrangler would deploy to a NEW worker named
  `flatwrite-extract-production` instead of updating the existing one.
- Deploying with no `--env` now targets the top-level config, which has
  no route. **Do not deploy manually** — `deploy.sh` always passes an
  explicit `--env` and refuses unknown arguments.

## Local dev

Create `workers/flatwrite-extract/.dev.vars` (NOT committed) with:

```
API_KEY=anything
```

No other secret is needed — conversion is fully in-process, so local dev
no longer requires `INTERNAL_EXTRACT_KEY` or a running Fly service.
Then:

```sh
bunx wrangler dev --port 8787 --config wrangler.toml
```

The `wrangler dev` server will pick up `.dev.vars` automatically. The
`--config wrangler.toml` flag is required to bypass the repo-root
`wrangler.jsonc` (which declares a different Worker and would
otherwise be merged into this one's config).

## Deploy

**Use the wrapper script** — `workers/flatwrite-extract/deploy.sh`.
The script:

1. Temporarily stashes `public/_redirects` (otherwise CF's upload
   validator rejects the deploy with "Infinite loop detected [code:
   100324]" because that file is a CF Pages SPA-fallback rule).
2. Runs `wrangler deploy --config wrangler.toml --env <name>` (the
   `--config` flag bypasses the parent `wrangler.jsonc` and keeps this
   Worker isolated).
3. Restores `public/_redirects` via an `EXIT` trap (idempotent and
   safe to interrupt).

```sh
./workers/flatwrite-extract/deploy.sh                  # production (default)
./workers/flatwrite-extract/deploy.sh --env staging    # workers.dev-only copy
```

## CPU-time caveat (Workers Free)

The two WASM modules are ~12.7 MB raw combined, and conversion is real
CPU work inside the isolate. Workers Free allows only **10 ms of CPU
time per request** (wall-clock unlimited). Production measurements
(`scripts/measure-extract-cpu.mjs` + `wrangler tail`, November 2026):
typical documents convert in 0–20 ms of CPU and every corpus request
succeeded; a 2.4 MB docx with ~40k paragraphs used 260–345 ms CPU and
still returned 200 because Cloudflare tolerates bursts. The API is
therefore best-effort on the Free plan: very large files rely on that
burst tolerance and could hit error 1102 if Cloudflare enforces the
limit strictly. The interactive editor path is unaffected because
conversion there runs in the user's browser, not in this Worker.

## DNS

The production Worker is bound to the route `extract.flatwrite.md/*`.
The staging environment has no route and is reachable only at
`https://flatwrite-extract-staging.<subdomain>.workers.dev`.
