# FlatWrite Bruno v4 integration

The canonical usage guide is [`bruno/README.md`](../bruno/README.md).

## Coverage

`bruno/flatwrite-api` contains one request per OpenAPI operation:

1. `POST /render`
2. `OPTIONS /render`
3. `POST /extract`
4. `OPTIONS /extract`
5. `POST /assist`
6. `POST /mcp-token`
7. `GET /health`

`bruno/flatwrite-webmcp` contains:

- four executable HTTP requests (`render_markdown`, two auth modes for `assist_document`, `create_share_link`)
- one skipped contract for `list_render_options`, because no HTTP endpoint exists
- nine skipped browser-only side-effect contracts from `public/webmcp-tools.js`

## Design corrections discovered during porting

The planning counts were stale. `public/webmcp-tools.js` currently exposes 12 document tools: two render/discovery tools, nine browser/editor tools (including browser-mode sharing), and `assist_document`. Counting two HTTP auth flavours and the HTTP share adapter produces five planned HTTP files, but only four map to real endpoints.

Token issuers are not interchangeable. Assist uses HMAC scope `assist`; Render and Extract use `mcp`, and the workers keep independent API-key secrets. Collection pre-request scripts therefore choose the issuer from the target host and cache separate token/expiry variables.

The token workers require `Origin`, return a 60-second token, and encode `expiresAt` as seconds since Unix epoch. A millisecond comparison would refresh every token immediately.

Transient token and retry state uses Bruno runtime variables. `bru.setCollectionVar`
persists mutations into `collection.bru` in CLI v4 and must never hold credentials.

The share handler is `POST /api/share`, not `/share`, and returns `{ key }`. The richer WebMCP share envelope is assembled in browser code.

## Regeneration policy

`npm run bruno:import` writes to `bruno/.openapi-import/`. Never import directly over `bruno/flatwrite-api`; the importer cannot preserve the manual auth, host routing, multipart fixture, tests, and retry behavior.

After changing `openapi.yaml`:

1. Run `npm run bruno:import`.
2. Diff `bruno/.openapi-import` against `bruno/flatwrite-api`.
3. Port intentional operation/schema changes.
4. Run `npm run bruno:lint`.
5. With `FW_API_KEY` set, run the relevant production requests.

## Secret handling

`Local.bru` and `.openapi-import/` are gitignored. Committed `example.bru` files contain placeholders only. Shell interpolation is `{{process.env.FW_API_KEY}}`.

The validator must not require `Local.bru` to exist: it is intentionally absent
from a clean clone. Bruno Desktop users copy `example.bru` to `Local.bru` and
store their machine-local key there, or launch Desktop from a shell exporting
`FW_API_KEY`.
