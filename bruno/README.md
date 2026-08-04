# Bruno collections for FlatWrite

Two Bruno v4 collections cover FlatWrite's HTTP API and its WebMCP contracts.

- `flatwrite-api`: the seven operations in `openapi.yaml`
- `flatwrite-webmcp`: four verified HTTP adapters, one documented unsupported HTTP mapping, and nine browser-only stubs

## Install

The repository's authoritative lockfile is `package-lock.json`, so use npm here:

```bash
npm install
```

This installs `@usebruno/cli` v4 as a dev dependency. Run it through package scripts; a global `bru` is not required.

## Credentials

Set the server-to-server key in the shell:

```bash
export FW_API_KEY=sk_...
```

Committed environments interpolate it as `{{process.env.FW_API_KEY}}`. Do not put a real key in `example.bru` or commit `Local.bru`.

### Bruno Desktop

When Bruno Desktop is launched from Finder/Dock, it may not inherit shell
variables. Create a machine-local environment from the committed template:

```bash
cp bruno/flatwrite-api/environments/example.bru \
  bruno/flatwrite-api/environments/Local.bru
cp bruno/flatwrite-webmcp/environments/example.bru \
  bruno/flatwrite-webmcp/environments/Local.bru
```

Open each `Local` environment in Bruno Desktop and replace
`replace-with-server-api-key` with the real key. Both files are gitignored.
Alternatively, launch Bruno Desktop from a shell that exports `FW_API_KEY` and
keep `apiKey: {{process.env.FW_API_KEY}}` in the local files.

For the API collection, change the copied `Local.bru` host variables to local
service URLs only when local Workers are actually running; otherwise retain the
production URLs. Package scripts default to committed production environments;
select `BRUNO_ENV=Local` only after creating the local files.

## Import from OpenAPI

```bash
npm run bruno:import
```

Bruno v4's actual syntax is `bru import openapi --source ... --collection-format bru`. The script writes raw importer output to `bruno/.openapi-import/` so it cannot overwrite the repaired collection. Compare and port intentional spec changes manually.

The v4 importer preserves all seven operations but needs repairs for host-specific URLs, API-key versus browser-token auth, multipart files, tests, and response scripts.

## Validate

```bash
npm run bruno:lint
```

Bruno CLI 4.0.0 has no `bru lint` command. This script runs `bruno/scripts/validate-collections.mjs`, which uses Bruno's parser and checks operation counts, auth headers, multipart shape, environments, token logic, test blocks, and stub metadata.

Bruno CLI 4.0.0 also has no `--dry-run` option. To inspect the request inventory without network traffic:

```bash
find bruno/flatwrite-api -name '*.bru' \
  ! -path '*/environments/*' ! -name collection.bru -print | sort
```

## Run

Production HTTP API:

```bash
npm run bruno:run:api
```

To select another environment (the package script defaults to `Render`):

```bash
BRUNO_ENV=Local npm run bruno:run:api
```

Production WebMCP adapters:

```bash
npm run bruno:run:webmcp
```

For local WebMCP adapters, create `Local.bru` as described above, start the
local services, and override the environment:

```bash
BRUNO_ENV=Local npm run bruno:run:webmcp
```

The scripts `cd` to each collection root because Bruno CLI v4 refuses a collection path. `-r` is required because requests live in nested folders.

`Local.bru` is intentionally absent from a clean clone. Create it from
`example.bru` as shown above before selecting `BRUNO_ENV=Local`.

## Auth

- `X-Api-Key`: long-lived server-to-server credential, sourced from `FW_API_KEY`.
- `X-Mcp-Token`: short-lived browser credential. Requests opt in by declaring the header; the collection-level script mints and caches the correct host-specific token.

Token details from the Worker implementations:

- Assist signs scope `assist`.
- Render and Extract sign scope `mcp`.
- Each host exposes its own `/mcp-token` issuer.
- Minting requires an allowed `Origin` header.
- Tokens last 60 seconds, not five minutes.
- `expiresAt` is Unix epoch seconds. Collection scripts refresh ten seconds early.
- Token and rate-limit caches use runtime variables (`bru.setVar`), not persisted
  collection variables, so running Bruno cannot write credentials into a tracked file.

## Multipart extraction

The API collection uses the committed `bruno/fixtures/sample.md` by default. Override `sampleFile` in a local environment to test PDF, DOCX, or another allowlisted format.

## WebMCP mapping

Verified HTTP adapters:

| Tool/request | Endpoint | HTTP response note |
|---|---|---|
| `render_markdown` | `POST https://render.flatwrite.md/render` | HTTP returns `{ head, body }`; the WebMCP bridge wraps it as artifacts. |
| `assist_document` | `POST https://assist.flatwrite.md/assist` | Tested with `X-Api-Key`. |
| `assist_document` browser mode | same endpoint | Mints an Assist-scoped token first. |
| `create_share_link` | `POST https://flatwrite.md/api/share` | HTTP returns `{ key }`; the browser bridge builds `shareUrl`. |

`list_render_options` has no HTTP endpoint. `renderClient.ts`, the Render Worker, and the Vercel render handler contain no options route or `optionsOnly` branch. Its `.bru` file documents the schema and skips execution instead of making a knowingly invalid request.

Nine tools are browser-only and tagged `browser-only` plus `webmcp-side-effect`. Their pre-request scripts call `bru.runner.skipRequest()` because they require `document.modelContext` and editor state:

- `get_document_state`
- `create_document`
- `open_document`
- `update_document_content`
- `list_recent_documents`
- `render_markdown_preview`
- `export_document_html`
- `export_document_pdf`
- browser-mode `create_share_link`

## Rate limiting

`/render` and `/assist` response scripts capture `Retry-After`. Both collections sleep before a later request until that delay has elapsed. The guard handles absent, zero, expired, and malformed values without sleeping.

Do not hammer production merely to manufacture a 429. Test this against a local Worker with a deliberately low limit.

## Future CI example

Not installed in workflows:

```yaml
- name: Validate Bruno collections
  run: npm run bruno:lint
- name: Run Bruno API collection
  env:
    FW_API_KEY: ${{ secrets.FW_API_KEY }}
  run: cd bruno/flatwrite-api && npx --no-install bru run --env Render -r --reporter-junit results.xml
```
