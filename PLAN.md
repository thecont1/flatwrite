# FlatWrite v3 — Implementation Plan

## Overview

Two major phases:

1. **Phase 1 — Document Mode:** Remove all seven web-app-oriented CSS frameworks and replace them with proper paged-media document engines (Paged.js, Vivliostyle).
2. **Phase 2 — Doc/App Switch:** Introduce a top-level surface toggle that bifurcates FlatWrite into two personalities — **Doc** (paged document layout) and **App** (web app layout composition) — each exposing only its relevant frameworks, components, controls, and export options.

---

## Phase 1 — Document Mode: Replace Web App Frameworks with Document Engines

### Milestone 1.1 — Audit & Strip Existing Frameworks

**Files affected:** `public/app.js`, `public/index.html`

- Remove the entire `FRAMEWORKS` object from `app.js` — all seven entries (Spectre, PoshUI, Oat, Pico, Milligram, Chota, Simple.css) and their CDN URLs.
- Remove `fwCssCache`, `applyFramework()`, and all `style(doc)` class-injection logic.
- Remove the `COMPONENTS` array and all 15 component entries.
- Remove the component picker UI from the sidebar (`.components-panel`, `.components-grid`, `.comp-btn`, `.comp-modal`) in both `index.html` and `styles.css`.
- Remove the framework dropdown selector from the toolbar in `index.html`.
- Update `saveToIDB()` schema: rename `framework` key to `docEngine` in the `preferences` store. Bump `DB_VERSION` to 2 and write a migration in `onupgradeneeded`.

**Validation:** App loads, editor works, preview renders unstyled markdown. No framework references remain in JS or HTML.

---

### Milestone 1.2 — Integrate Paged.js

**Files affected:** `public/app.js`, `public/index.html`

- Inject Paged.js via CDN into the sandboxed iframe `srcdoc` template inside `renderPreview()`:
  ```html
  <script src="https://unpkg.com/pagedjs/dist/paged.polyfill.js"></script>
  ```
- Add a baseline `@page` CSS block to the iframe's `<style>` section:
  ```css
  @page { size: A4; margin: 25mm 20mm; }
  body { font-family: var(--body-font); }
  ```
- Wire page size and margin controls (added in 1.4) to CSS custom properties inside the iframe via `postMessage`.
- Patch `exportHTML()` to bundle the Paged.js `<script>` tag so exported HTML self-paginates on open.
- Patch `exportPDF()`: replace `html2pdf.js` with a `window.print()` call inside the iframe after Paged.js has rendered. This is the canonical Paged.js PDF workflow and respects all `@page` rules.

**Validation:** Preview shows A4 page boundaries with crop marks. Content paginates across pages. PDF export via print dialog produces correctly sized pages.

---

### Milestone 1.3 — Integrate Vivliostyle (Second Engine Option)

**Files affected:** `public/app.js`, `public/index.html`

- Define a `DOC_ENGINES` object in `app.js` to replace the old `FRAMEWORKS` object:
  ```javascript
  var DOC_ENGINES = {
    pagedjs: {
      label: "Paged.js",
      script: "https://unpkg.com/pagedjs/dist/paged.polyfill.js",
      category: "paged-media"
    },
    vivliostyle: {
      label: "Vivliostyle",
      script: "https://unpkg.com/@vivliostyle/viewer/lib/vivliostyle.js",
      category: "css-books"
    },
    none: {
      label: "Plain CSS",
      script: null,
      category: "unstyled"
    }
  };
  ```
- Add a compact three-segment engine selector to the toolbar: `Paged.js | Vivliostyle | Plain`.
- Update `renderPreview()` to inject the correct engine script into the iframe based on selection.
- Persist selected engine to IndexedDB via the `docEngine` key.

**Validation:** Switching engines re-renders the preview. Vivliostyle correctly handles `@footnote` and `running()` CSS constructs. Plain mode renders undecorated HTML.

---

### Milestone 1.4 — Document Controls UI

**Files affected:** `public/styles.css`, `public/index.html`, `public/app.js`

Replace the old web-reading typography sliders with document-layout controls that map directly to `@page` CSS:

| Control | CSS Target | Values |
|---|---|---|
| Page size | `@page { size: ... }` | A4, A5, Letter, Legal, Custom |
| Margins | `@page { margin: ... }` | Narrow / Normal / Wide / Custom mm |
| Columns | `column-count` on `body` | 1 / 2 / 3 |
| Baseline grid | `line-height` on `body` | 1.2 → 2.0 |
| Running headers | `position: running(header)` toggle | On / Off |
| Page numbers | `@bottom-center { content: counter(page) }` toggle | On / Off |

- Build controls as plain `<select>` and `<input type="range">` elements consistent with existing shell styling.
- Write a `buildPageCSS()` function that assembles the `@page` block from current control values and injects it into the iframe via `postMessage`.
- Persist all document layout preferences to IndexedDB.

**Validation:** Changing page size re-renders preview at new dimensions. Columns split body text correctly. Running headers and page numbers appear in margins.

---

### Milestone 1.5 — Export Pipeline Update

**Files affected:** `public/app.js`

| Export | Behaviour |
|---|---|
| `.md` | No change — raw markdown text |
| `.html` | Bundle includes engine script tag + `@page` CSS block. Self-contained, self-paginating HTML document. |
| PDF | Remove `html2pdf.js`. New flow: render in iframe → `postMessage({ action: 'print' })` → iframe calls `window.print()` → browser print dialog at correct `@page` size. |

- Remove `html2pdf.js` CDN reference from `index.html`.
- Add tooltip on PDF export button: *"Save as PDF from the browser's print dialog."*

**Validation:** HTML export opens in a browser and paginates. PDF flow opens print dialog at correct page size.

---

## Phase 2 — Doc/App Switch

### Milestone 2.1 — Top-Level Mode Architecture

**Files affected:** `public/app.js`, `public/index.html`, `public/styles.css`

Introduce a `surfaceMode` variable (`"doc"` | `"app"`) that sits above the existing `mode` variable:

surfaceMode: "doc" | "app"
└── mode: "edit" | "preview" | "read"

- Add `surfaceMode` variable, defaulting to `"doc"`.
- Add a persistent `surfaceMode` key to the IndexedDB `preferences` store.
- Write `setSurfaceMode(sm)` that: sets `surfaceMode`; adds/removes `surface-doc` / `surface-app` class on `<html>`; calls `renderPreview()`; triggers sidebar re-render.
- Add a two-segment pill toggle at the very top of the left sidebar rail: **Doc | App**.
- Gate all sidebar panels and toolbar sections with `.doc-only` / `.app-only` classes:
  ```css
  .surface-doc  .app-only  { display: none; }
  .surface-app  .doc-only  { display: none; }
  ```

**Validation:** Toggle changes `<html>` class, hides/shows correct panels, persists across page reloads.

---

### Milestone 2.2 — Restore Web App Frameworks (App Surface Only)

**Files affected:** `public/app.js`

Re-introduce the web app framework registry, scoped to `surface-app`. The two registries coexist:

```javascript
var DOC_ENGINES    = { pagedjs: {...}, vivliostyle: {...}, none: {...} };  // Doc surface
var APP_FRAMEWORKS = { spectre: {...}, poshui: {...}, pico: {...}, chota: {...}, milligram: {...} };  // App surface
```

> **Note:** Oat and Simple.css are intentionally excluded from `APP_FRAMEWORKS`. Oat is not designed for app layout; Simple.css is document/reading-oriented. The five retained frameworks all have usable grid or component systems.

- Restore `APP_FRAMEWORKS` with five entries and their CDN URLs.
- Restore `style(doc)` class-injection functions for each.
- Update `renderPreview()` to branch on `surfaceMode`: Doc → use `DOC_ENGINES`; App → use `APP_FRAMEWORKS` (no pagination engine).
- Add framework selector to toolbar `.app-only` section.

**Validation:** In App surface, framework switcher appears and applies classes. In Doc surface, engine selector appears instead.

---

### Milestone 2.3 — Restore Component Picker (App Surface Only)

**Files affected:** `public/app.js`, `public/index.html`, `public/styles.css`

- Restore `COMPONENTS` array (15 original entries) with `class="app-only"` on all containing UI.
- Restore `insertComponent()` function.
- Add five new layout-level components not previously present:

| ID | Purpose |
|---|---|
| `navbar` | Top navigation bar |
| `footer` | Page footer |
| `hero-wide` | Full-width hero with CTA |
| `two-col` | Two-column section wrapper |
| `three-col` | Three-column section wrapper |

**Validation:** Component picker hidden in Doc surface, visible in App surface. All components insert and render correctly.

---

### Milestone 2.4 — App Surface Layout Controls

**Files affected:** `public/app.js`, `public/styles.css`, `public/index.html`

Replace the Doc surface's `@page` controls with viewport/breakpoint controls in the sidebar's `.app-only` panel:

| Control | Function |
|---|---|
| Viewport preview | Resize preview iframe: Mobile (375px) / Tablet (768px) / Desktop (100%) |
| Framework selector | Segmented control: Spectre / PoshUI / Pico / Chota / Milligram |
| Typography | Font family + size step sliders (repurposed for web type) |
| Content width | `--canvas-max` token override |

- Add viewport control buttons to toolbar `.app-only` section.
- Write `setViewport(w)` that sets `max-width` on `.preview-wrap` and sends resize message to iframe.
- Restore font/size/weight/line typography sliders from v2, tagged `.app-only`.

**Validation:** Viewport toggle resizes preview iframe. Framework classes apply at each breakpoint.

---

### Milestone 2.5 — Export Pipeline Branching

**Files affected:** `public/app.js`

| Export | Doc surface | App surface |
|---|---|---|
| `.md` | Raw markdown (unchanged) | Raw markdown (unchanged) |
| `.html` | Self-contained HTML + engine script + `@page` CSS | Self-contained HTML + framework CSS + class-injected markup |
| PDF / Print | `window.print()` via iframe (Paged.js / Vivliostyle) | `window.print()` for screen capture; tooltip suggests HTML export for sharing |

- Add `if (surfaceMode === 'doc') { ... } else { ... }` branch in `exportHTML()`.
- For App surface, restore the `html2pdf.js`-compatible bundle export that inlines framework CSS.
- Update PDF export button tooltip text per active surface.

**Validation:** Both export paths produce correct, self-contained output for their respective surfaces.

---

### Milestone 2.6 — Shared State & Persistence

**Files affected:** `public/app.js`

- Markdown content (`editor.value`) is **shared** between surfaces — the same document can be previewed as a paginated print document or as a styled web page. This is intentional.
- The `preferences` IndexedDB store gains: `surfaceMode`, `appFramework` (separate from `docEngine`), so each surface remembers its last-used engine/framework independently.
- On `setSurfaceMode()`, load the saved preference for the newly active surface without re-loading markdown content.
- Update `saveToIDB()` to always persist `surfaceMode`, `docEngine`, and `appFramework`.

**Validation:** Switching surfaces preserves editor content. Each surface restores its last-used engine/framework independently on reload.

---

### Milestone 2.7 — Share Pipeline Branching

**Files affected:** `public/app.js`, `api/` (server-side share handler)

The existing Dustebin-compatible share backend stores raw markdown and returns a short URL. With two surfaces, the share payload must also encode surface context so a recipient opens the document in the correct mode.

- Extend the share payload from bare markdown to a JSON envelope:
  ```json
  {
    "content": "# My document...",
    "surfaceMode": "doc",
    "docEngine": "pagedjs",
    "appFramework": null,
    "pageSize": "A4",
    "margins": "normal"
  }
  ```
- Update `handleShare()` in `index.js` (server): accept the JSON envelope, stringify it, and pass it as the `content` field to the Dustebin API (no server-side logic change required; the envelope is opaque to the paste backend).
- Update the client-side share fetch call to POST the JSON envelope instead of raw markdown.
- Update the URL-load path (`?s=<key>`): when fetching a shared document, detect whether the stored content is a JSON envelope or legacy raw markdown (use `try { JSON.parse(...) }`) and handle both:
  - **JSON envelope:** restore `surfaceMode`, `docEngine`/`appFramework`, and layout preferences before rendering.
  - **Legacy markdown string:** default to `surfaceMode: "doc"`, engine `pagedjs` — safe forward-compatible fallback.
- Add a "Copy share link" button to both surfaces in the toolbar (`.share-btn`), which triggers the share flow and copies the resulting URL to clipboard.
- The share URL itself remains a simple short key (e.g., `flatwrite.md/?s=abc123`) — no surface state is encoded in the URL. All context travels in the paste payload.

**Validation:** Sharing a Doc-surface document with Paged.js selected opens correctly for the recipient in Doc mode with Paged.js active. Sharing an App-surface document opens in App mode with the correct framework. Legacy share URLs from v2 load cleanly in Doc mode.

---

## Milestone Summary

| # | Milestone | Phase | Files Touched | Key Output |
|---|---|---|---|---|
| 1.1 | Audit & Strip Frameworks | 1 | `app.js`, `index.html`, `styles.css` | Clean codebase, no web-app framework references |
| 1.2 | Integrate Paged.js | 1 | `app.js`, `index.html` | Paginated A4 preview, print-dialog PDF |
| 1.3 | Integrate Vivliostyle | 1 | `app.js`, `index.html` | `DOC_ENGINES` registry, engine selector UI |
| 1.4 | Document Controls UI | 1 | `app.js`, `index.html`, `styles.css` | `@page` controls, `buildPageCSS()` |
| 1.5 | Export Pipeline Update | 1 | `app.js` | Paginated HTML export, `html2pdf.js` removed |
| 2.1 | Top-Level Mode Architecture | 2 | `app.js`, `index.html`, `styles.css` | `surfaceMode` variable, Doc/App pill toggle, `.doc-only`/`.app-only` CSS gates |
| 2.2 | Restore Web App Frameworks | 2 | `app.js` | `APP_FRAMEWORKS` registry, `renderPreview()` branching |
| 2.3 | Restore Component Picker | 2 | `app.js`, `index.html`, `styles.css` | 15 original + 5 new layout components, `.app-only` scoped |
| 2.4 | App Surface Layout Controls | 2 | `app.js`, `index.html`, `styles.css` | Viewport toggle, framework selector, typography sliders restored |
| 2.5 | Export Pipeline Branching | 2 | `app.js` | Dual export paths per surface mode |
| 2.6 | Shared State & Persistence | 2 | `app.js` | `appFramework` + `docEngine` persisted independently per surface |
| 2.7 | Share Pipeline Branching | 2 | `app.js`, `index.js` | JSON share envelope, legacy fallback, clipboard share button |

**Five Architectural Constraints:**

1. **The Iframe Boundary Is Inviolable** — Paged.js and Vivliostyle must only ever run inside the sandboxed preview iframe, never in the shell document. Communication goes through the existing `postMessage` channel exclusively.

2. **`surfaceMode` Is Above `mode` — Never Conflate Them** — `surfaceMode` (`"doc"` | `"app"`) and `mode` (`"edit"` | `"preview"` | `"read"`) are orthogonal axes. `setSurfaceMode()` must never call `setMode()` as a side effect, and vice versa. Surface gating uses CSS classes, not `mode` conditionals.

3. **Markdown Content Is Surface-Agnostic** — The same `editor.value` string renders in both surfaces. No separate stores, no separate editor instances per surface. One document, two rendering pipelines.

4. **Legacy Share URLs Must Always Load** — The v2 raw-markdown share format must always be handled as a fallback after the JSON envelope format is introduced in 2.7. This fallback must never be removed.

5. **No Build Step** — The zero-toolchain constraint (no bundler, no transpiler, plain ES5 JS) must be maintained across all milestones. CDN script tags are fine; npm frontend build dependencies are not.
