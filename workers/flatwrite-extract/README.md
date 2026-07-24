# flatwrite-extract Worker

Cloudflare Worker serving the public `https://extract.flatwrite.md/extract`
endpoint. It is a thin proxy in front of the MarkItDown-backed
`flatwrite-extract` service on Fly.io.

## Endpoints

- `POST /extract` (primary): `multipart/form-data` with a single
  `file` field. Forwards the body verbatim to
  `https://flatwrite-extract.fly.dev/extract` and returns the upstream
  JSON response.
- `POST /mcp-token`: Mints a short-lived (60s) HMAC-signed token for
  browser-side WebMCP clients. Mirrors the render worker's flow.
- `OPTIONS`: 204 with CORS headers (trusted origins only).
- Any other method or path: 405 / 404.

## Auth

Two paths:

- `X-Api-Key` — long-lived key, server-to-server only. Rejected if
  the request carries an `Origin` header.
- `X-Mcp-Token` — short-lived HMAC (60s), browser-safe. The Worker
  validates the signature against `env.API_KEY`, then strips the
  caller's credential and re-signs with `env.INTERNAL_EXTRACT_KEY`
  for the upstream call. The upstream never sees the caller's
  `X-Api-Key` or `X-Mcp-Token`.

Outbound calls to the Fly service carry an HMAC-SHA256 signature
(`X-Extract-Signature`) over `<unix-timestamp>.POST./extract`, plus the
timestamp in `X-Extract-Timestamp`. The Fly service has a 5-minute
replay window and a constant-time signature comparison.

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

| Name | Direction | Purpose |
|---|---|---|
| `API_KEY` | inbound | The public-facing key clients send in `X-Api-Key`. |
| `INTERNAL_EXTRACT_KEY` | outbound | The HMAC secret used to sign upstream calls to the Fly service. Same value MUST be set on the Fly app's `INTERNAL_EXTRACT_KEY` env var. |

`UPSTREAM_URL` is a var (set in `wrangler.toml`) defaulting to
`https://flatwrite-extract.fly.dev`. Override for staging by setting
it as a secret: `wrangler secret put UPSTREAM_URL`.

## Local dev

Create `workers/flatwrite-extract/.dev.vars` (NOT committed) with:

```
API_KEY=anything
INTERNAL_EXTRACT_KEY=anything
```

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
2. Runs `wrangler deploy --config wrangler.toml` (the `--config` flag
   bypasses the parent `wrangler.jsonc` and keeps this Worker
   isolated).
3. Restores `public/_redirects` via an `EXIT` trap (idempotent and
   safe to interrupt).

```sh
./workers/flatwrite-extract/deploy.sh
```

## DNS

The Worker is bound to the route `extract.flatwrite.md/*`. Until the
`extract.flatwrite.md` CNAME is added in Cloudflare DNS, the Worker
is only reachable via `wrangler dev` (locally) or by hitting the
`flatwrite-extract` script's `*.workers.dev` URL — which only
responds to direct invocations, not the routed path.
