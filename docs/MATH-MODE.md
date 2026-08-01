# Math Mode architecture

## Why a manual toggle (not always-on detection)

FlatWrite documents are overwhelmingly prose, tables, and light formatting.
Always-on math scanning would:

1. tax every keystroke/render path for a rare feature,
2. mis-fire on currency (`$40`), shell vars, and Windows paths,
3. force KaTeX CSS/JS onto every preview iframe and export.

Math Mode is therefore **opt-in per document**, default OFF. When OFF the
render path is byte-identical to pre-math FlatWrite: global `marked.parse`,
no extensions, no KaTeX network requests, no DOM placeholder scan.

## Persistence

| Surface | Key | Values |
|---|---|---|
| Share / export YAML frontmatter | `math:` | `true` / `false` (also accepts `on`/`off`) |
| IndexedDB `docLayout` | `math` | boolean |
| Toolbar | `#btn-math` `aria-pressed` | reflects live state |

`buildShareYaml()` writes `math:` next to `footer:`. `applyFrontmatter()`
reads it with the same boolean/string contract as footer. Absent key ⇒ leave
current state alone on partial maps; fresh docs start at `false`.

This fits FlatWrite’s existing metadata model cleanly — no new store, no
schema migration beyond “unknown keys were already ignored.”

## Parsing model

Shared module: `core/math.js` (Node /api/render, MCP, tests).
Browser mirror: `public/math-render.js` → `window.FlatWriteMath`.

When ON, a **dedicated** `marked.Marked` instance is created with:

- block `$$...$$` → `.fw-math-display`
- block `\[...\]` → `.fw-math-display`
- inline `$...$` → `.fw-math-inline` (currency guard: `$` + digit skipped)
- inline `\(...\)` → `.fw-math-inline`
- fenced ` ```math|latex|tex ` → `.fw-math-display` via code renderer

Placeholders carry raw LaTeX in `data-latex`. Marked tokenizes fenced code and
inline code **before** our inline extensions, so `$` inside `` `code` `` or
` ``` ` is invisible to math.

When OFF, `parseMarkdown(md, false)` calls the default marked parse with
**zero** extension registration.

## Nudge heuristic (load/save only)

`hasMathHeuristic(body)`:

1. positive on fenced `math|latex|tex`, `$$`, `\(`, `\[`, or `$` not followed
   by whitespace/digit,
2. strips fenced/indented/inline code first,
3. runs only from load (shared doc, IDB restore, URL import) and autosave —
   never on `input`.

UI: `#math-nudge` pill next to the toggle. Dismiss sticks for the session
(`mathNudgeDismissed`); enabling Math Mode dismisses automatically.

## Engine integration (Plain / Paged.js / Vivliostyle)

All three engines share one path:

1. `renderToFragment` → placeholders (if ON)
2. DOMPurify (allows `data-latex` + MathML tags used by KaTeX)
3. `finalizeMathHtml` → parent-window `katex.render` into static HTML/MathML
4. Inject KaTeX CSS into the iframe/export `<head>`
5. Hand static HTML to Plain / Paged.js / Vivliostyle

**Why pre-render before pagination:** Paged.js and Vivliostyle paginate an
already-built DOM. Mid-formula line breaks are catastrophic. Vivliostyle’s
blob document runs with `allowScripts: false`, so in-document KaTeX scripts
cannot run there — parent-side pre-render is mandatory for that engine and
is used uniformly for the others.

PDF export reuses the committed preview snapshot (already math-static) or
rebuilds through the same finalize path.

## Server / share / MCP

`core/render.js` reads `math` from frontmatter via `resolveRenderOptions`.
When true, `renderToDocument` emits placeholders + `katexInlineAssets()`
(CSS link + self-executing render script) so headless HTML is self-sufficient
without a `katex` npm dependency on the worker.

## Import pipelines

| Source | Typical math output | Nudge |
|---|---|---|
| Direct edit | author-written `$` / `$$` / `\( \)` / fences | on save if heuristic hits |
| MarkItDown (PDF/DOCX/…) | often loses equations or emits images/OMML poorly; sometimes `$...$` survives | heuristic if delimiters present |
| markdown.new (`/api/import-url`) | preserves page LaTeX-ish `$` / `$$` on math-heavy sites (e.g. Andrew Ng notes) | on import |

Users importing math-heavy pages get a one-shot “Enable Math Mode?” pill;
nothing is forced.

## Error handling

- `katex.render({ throwOnError: false })`
- try/catch still present; fallback sets element text to raw LaTeX +
  `data-latex-fallback="true"`
- load failures log to console; placeholders remain visible

## Accessibility

KaTeX `output: "htmlAndMathml"` emits MathML alongside HTML so AT gets a
semantic tree when the engine preserves it. Display math is block-level with
horizontal overflow for long expressions.

## Performance budget

| Mode | Parse | Network | DOM |
|---|---|---|---|
| OFF | global marked only | none | none |
| ON, no math tokens | isolated Marked (cached) | none until first placeholder | none |
| ON, with math | isolated Marked | KaTeX CSS+JS once (lazy) | one `querySelectorAll` + render pass |

## Files

- `core/math.js` — source of truth
- `core/render.js` — server flag + asset injection
- `public/math-render.js` — browser IIFE
- `public/app.js` — toggle, persistence, finalize-before-paginate, nudge
- `public/index.html` — `#btn-math`, `#math-nudge`
- `public/styles.css` — toggle/nudge chrome
- `test/math.test.js` — unit coverage
- `test/fixtures/math-*.md` — fixtures
