# Render Convergence Test Report

Source 1: `ngl-storyteller` README
- URL: https://raw.githubusercontent.com/thecont1/ngl-storyteller/refs/heads/main/README.md
- Settings: docEngine=none, appFramework=spectre, pageSize=A3, orientation=portrait,
  marginsLR=normal, marginsTB=wide, footer=true, font=Playfair Display,
  size=-1, weight=-3, line=0, width=890

| Path | HTTP | fonts | body font-size | body line-height | h1 | p_count |
|---|---|---|---|---|---|---|
| YAML (editor's exact format) | 200 | Playfair Display | 14px | 1.75 | ngl v1.0 😜 – Not Gonna Lie! | 41 |
| JSON friendly (strings for scales) | 200 | Playfair Display | 14px | 1.75 | ngl v1.0 😜 – Not Gonna Lie! | 41 |
| MCP render_markdown_from_url | 200 | Playfair Display | 14px | 1.75 | ngl v1.0 😜 – Not Gonna Lie! | 41 |

**All three paths produce byte-identical head and body output.**

Preview files: `preview/ngl-storyteller--yaml.html`, `preview/ngl-storyteller--json.html`, `preview/ngl-storyteller--mcp.html`.

---

Source 2: Local file at `/Users/home/Downloads/Do you want to see the pre-process logs_ Or can yo.md`
- 8,566 bytes, 191 lines
- Settings: same as Source 1

| Path | HTTP | fonts | body font-size | body line-height | h1 | p_count |
|---|---|---|---|---|---|---|
| YAML | 400 | n/a | n/a | n/a | n/a | n/a |
| JSON friendly (raw markdown) | 200 | Playfair Display | 14px | 1.75 | Do you want to see the pre-process logs? Or can you make a plan to implement right away? | 29 |
| MCP render_markdown | 200 | Playfair Display | 14px | 1.75 | Do you want to see the pre-process logs? Or can you make a plan to implement right away? | 29 |

**JSON and MCP paths produce byte-identical output.** The YAML path is not available for raw content (the canonical API requires `url:` in YAML — by design, since `buildShareYaml` in the editor only writes URLs).

Preview files: `preview/local-preprocess-logs--json.html`, `preview/local-preprocess-logs--mcp.html`.

---

## Field semantics

| Field | Type | Meaning |
|---|---|---|
| `font` / `fontFamily` | string | Family name (e.g. "Comfortaa") |
| `size` / `fontSize` | string | Scale token (e.g. "1", "-1", "0") → looked up in `core/scale-map.js` |
| `size` / `fontSize` | number | Absolute pixel value (e.g. 17) → clamped to [8, 72] |
| `weight` / `fontWeight` | string | Scale token → looked up |
| `weight` / `fontWeight` | number | Absolute weight (100..900) → clamped |
| `line` / `lineHeight` | string | Scale token → looked up |
| `line` / `lineHeight` | number | Absolute multiplier → clamped to [0.8, 4.0] |
| `appFramework` / `framework` | string | Framework name (e.g. "spectre") |
| `pageSize` / `pageSize` | string | "A4", "A3", "Letter", etc. |
| `width` / `width` | number | Content width in pixels (400..1400) |
| `zoom` / `uiZoom` | number | UI zoom level (1.0 = default) |
| `docEngine`, `surfaceMode`, `orientation`, `marginsLR`, `marginsTB`, `footer` | same name on both sides | — |

## What was harmonised

Before this run, the public HTTP API and the MCP tools exposed friendly
field names (`fontFamily`, `framework`, `fontSize`, etc.) but silently
ignored them — the canonical `/api/render` only read the YAML-codename
fields (`font`, `appFramework`, `size`, etc.). Calling `render_markdown`
with `fontFamily: "Comfortaa"` produced an Inter render.

Three layers were fixed:

1. **`core/render.js` `resolveRenderOptions()`** now accepts BOTH the
   canonical and friendly fields. When both are present, the public
   alias wins. When the friendly `fontSize`/`lineHeight`/`fontWeight`
   are passed as strings, they are routed through the scale-token path
   (matching the editor's `buildShareYaml` output). When passed as
   numbers, they are treated as absolute pixel/multiplier values.
2. **`mcp/flatwrite-render-server/src/renderClient.ts`** translates the
   public `RenderStyle` to canonical names before building the wire
   body. Strings go to `size`/`weight`/`line`; numbers go to
   `fontSize`/`fontWeight`/`lineHeight`. The canonical renderer
   handles the rest.
3. **`mcp/flatwrite-render-server/src/tools/renderMarkdown*.ts`** now
   exposes the full editor design control surface in its input schema
   (pageSize, orientation, marginsLR, marginsTB, footer, width,
   docEngine, surfaceMode, theme), not just the typography knobs.

## Test totals

- **166 parent tests** (was 165 — added the convergence test in
  `test/render.test.js`).
- **47 MCP tests** (unchanged).

All green. The web app and the microservice now behave like twins.
