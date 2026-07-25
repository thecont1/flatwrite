# FlatWrite Assist (Morph)

In-product AI document assist powered by Morph:

| Step | Product | Role |
| --- | --- | --- |
| 1 | **Reflex** | Block jailbreak / NSFW; flag incomplete custom instructions |
| 2 | **Model Router** | Classify difficulty → pick Fast Model tier |
| 3 | **Compact** | Shrink long docs before generation (never the active selection) |
| 4 | **Fast Models** | Generate rewrite / shorten / fix / custom edit |

## Deploy

Worker source: `workers/flatwrite-assist/`

```bash
cd workers/flatwrite-assist
npx wrangler secret put API_KEY        # same public key pattern as render
npx wrangler secret put MORPH_API_KEY  # from https://morphllm.com/dashboard/api-keys
npx wrangler deploy
```

DNS: `assist.flatwrite.md` is configured in `wrangler.toml` (`route.pattern`).

Optional vars:

- `MORPH_BASE_URL` (default `https://api.morphllm.com/v1`)
- `MORPH_MODEL_EASY` / `MORPH_MODEL_MEDIUM` / `MORPH_MODEL_HARD`

Default tiers:

| Tier | Model ID |
| --- | --- |
| easy | `morph-qwen36-27b` |
| medium | `morph-minimax27-230b` |
| hard | `morph-glm52-744b` |

## Auth

Mirrors `render.flatwrite.md`:

- **Browser:** `POST /mcp-token` (trusted Origin) → short-lived `X-Mcp-Token` (scope `assist`)
- **Server / MCP:** `X-Api-Key` (rejected if `Origin` is present)

Trusted origins: `https://flatwrite.md`, `https://www.flatwrite.md`, `*.flatwrite.md`, localhost.

## API

### `GET /health`

```json
{ "ok": true, "service": "flatwrite-assist", "morphConfigured": true }
```

### `POST /assist`

```bash
curl -s https://assist.flatwrite.md/assist \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: $FLATWRITE_API_KEY" \
  -d '{
    "mode": "rewrite",
    "markdown": "# Hello\n\nThis is a draft.",
    "instruction": ""
  }'
```

Modes: `rewrite` | `shorten` | `fix_grammar` | `custom` (custom requires `instruction`).

Optional `selection: { start, end, text? }` — operate on a span; response includes:

- `piece` — edited span (or full doc when no selection)
- `markdown` — full document with splice applied
- `scope` — `selection` | `document`
- `model`, `routing`, `compacted`, `usage`, `reflex`

Errors use `{ ok: false, error: { code, message, retryable } }`.

Rate limit: 10 req/min/IP (token mint and assist separately).

## Editor UI

Edit-mode toolbar star → panel:

1. Pick mode
2. Optional instruction
3. **Run** (selection-aware)
4. **Accept** / **Discard** — never auto-applies

Bridge: `window.__flatwrite.assistDocument({ mode, instruction, markdown?, selection? })`.

## Local test

```bash
bun test ./test/assist.test.js
```

Mocks Morph HTTP; no live key required.

## Security notes

- `MORPH_API_KEY` never leaves the Worker
- Reflex pre-filter on every call
- Markdown size caps enforced in `schema.js`
- Do not log full document bodies in production logs
