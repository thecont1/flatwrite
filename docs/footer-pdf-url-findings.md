# Footer, PDF, and URL-loading findings

Observed on 2026-07-27 at `deff726`, then verified against the implementation in this branch.

## Baseline findings

- Paged.js field fixture (`?s=IUWxUVzE.md`): 5 logical pages, 5 printed PDF sheets, one text node and no `::before`/`::after` content in each footer box. The reported 8→10 screenshot could not be reproduced from a fresh headless Chromium profile at HEAD. This refutes the current-source “second emitter” hypothesis: the duplicate came from a stale `app.js?v=128` browser cache after commit `572a402` removed the CSS emitter without bumping the cache key.
- Paged.js still had a real geometry defect: the 0.8px `.pagedjs_sheet` border put the footer bottom 0.73px outside the sheet rect. Replacing the layout-affecting border with an inset outline keeps the footer inside the physical sheet.
- Vivliostyle had no footer at all. `buildPageCSS()` emitted no margin-box rules and `_applyFooterContent()` explicitly handled only Paged.js.
- Vivliostyle’s print clone removed every stylesheet containing `data-vivliostyle`; this deleted `vivliostyle-viewport-screen-css`, `vivliostyle-viewport-css`, and `vivliostyle-polyfill-css`. Only the page rules and font faces survived. The clone now removes only FlatWrite’s known preview shell and `#vivl-scroll-style`.
- Vivliostyle page detection was non-zero in all observed cells; the old `pageCount > 0` guard was therefore not triggered in the baseline, but it still represented a silent-failure path. Zero pages now throw a user-facing export error.
- Multi-column CSS targeted `main`, the engine flow root, with `column-fill:auto`. It now targets an inner `.fw-column-flow` wrapper with `column-fill:balance`.

## Footer ownership

- Paged.js: DOM-owned (`_applyFooterContent`), because real text nodes survive the static print clone. No CSS margin-box content is emitted for this engine.
- Vivliostyle: CSS-owned (`buildFooterCSS`), with native `@bottom-left` / `@bottom-right` rules. No DOM injection runs for this engine.
- `FOOTER_OWNERS` makes the single-owner contract explicit.

## Real-browser verification

The Playwright suite exercises:

- Engines: Paged.js and Vivliostyle
- Footer: on/off
- Columns: 1/2/3
- A4 and Letter, portrait and landscape
- Synthetic fixture, local shared-doc fixture, and recorded markdown.new import
- Preview page count versus generated Chromium PDF sheet count
- Footer text, line count, denominator, and sheet containment
- Empty-page checks

The recorded markdown.new response lives at `test/fixtures/import-url/thecontrarian-ayodhya.json`; the live upstream check is opt-in via `bun run test:e2e:live-import`.

## URL loading

- The checkbox has been removed.
- Known document extensions/raw GitHub URLs load directly.
- Extensionless URLs are fetched once and routed using response `Content-Type`; `text/html` routes to `/api/import-url`. A failed extensionless direct probe falls back to the importer.
- The client sends exactly one automatic `method=auto` request. `method=browser` is available only through an explicit post-failure button.
- Imported Markdown link/image destinations are rewritten with RFC 3986 semantics before entering the editor. The Ayodhya `/library/...` image becomes an absolute `https://www.thecontrarian.in/library/...` URL, so Markdown export is portable.
- URL resolution is centralized in `public/url-routing.js` and reused by rendered-HTML and Markdown-source paths.

## markdown.new capability note

A live POST to `https://markdown.new` with `method=auto&retain_images=true` returned the full Ayodhya essay as a JSON envelope (`application/json`, 7,393 Markdown characters, 1,848 tokens). FlatWrite keeps its server proxy because it supplies SSRF/DNS-rebinding controls, rate limiting, timeout, and a 4 MB streaming cap.
