# flatwrite-render Worker

Cloudflare Worker serving the public `https://render.flatwrite.md/render`
endpoint. It is a thin JSON-first façade in front of the canonical
`/api/render` handler on `flatwrite.md`.

## Endpoints

- `POST /render` (primary): `application/json` body with
  `{ markdown?, markdownUrl?, framework?, fontFamily?, theme?, fontSize?, lineHeight?, uiZoom? }`.
  Forwards directly to `/api/render` and returns `{ head, body }`.
- `POST /render` (legacy): `text/yaml` body with `{ url, framework?, ... }`.
  Fetches the markdown, builds a JSON request, and forwards to `/api/render`.
- `OPTIONS /render`: 204 with CORS headers.
- Any other method: 405 `METHOD_NOT_ALLOWED`.

## Auth

- Public clients must send `X-Api-Key: <API_KEY>` (env `API_KEY`).
- Outbound calls to `/api/render` carry an HMAC-SHA256 signature using
  `INTERNAL_RENDER_KEY`, plus a 1-second timestamp to match the canonical
  handler's replay window.

## CORS

All responses (success and error) include:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Api-Key
Access-Control-Max-Age: 600
```

## Error shape

All errors are JSON with `{ error, code, retryAfter?, detail? }`. Codes
include `UNAUTHORIZED`, `MISSING_CONTENT`, `INVALID_JSON`, `INVALID_YAML`,
`METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMIT`,
`UPSTREAM_FETCH_FAILED`, `UPSTREAM_UNREACHABLE`, `UNSUPPORTED_MEDIA_TYPE`,
`MISCONFIGURED`, `RENDER_FAILED`, `BAD_REQUEST`.

Rate-limit headers from the upstream `/api/render` (`X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `Retry-After`) are forwarded as-is.

## Local development

```bash
# from repo root
cd workers/flatwrite-render
wrangler dev
```

Requires `API_KEY` and `INTERNAL_RENDER_KEY` in `.dev.vars` (gitignored).

## Deploy

```bash
cd workers/flatwrite-render
wrangler deploy
```

Routes to `render.flatwrite.md/*` (configured in `wrangler.toml`).