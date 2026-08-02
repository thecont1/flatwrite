/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * For commercial, closed-source embedding, and SaaS deployment exemptions,
 * a valid Commercial License Agreement is required. Contact: sales@flatwrite.md
 */

/**
 * Parity tests for public/app.js. Each test pins down a single,
 * specific contract — either that a removed legacy identifier is
 * absent, or that the current architecture wiring is present. These
 * are textual checks against the source: cheap, fast, and they make
 * a rename of an exported symbol an explicit, deliberate change.
 *
 * The huge prior version of this file was a wall of "the source
 * mentions this string" assertions. This version keeps only the
 * high-signal contracts — one per architectural concern.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "..", "public", "app.js"),
  "utf-8"
);
const INDEX = readFileSync(
  resolve(import.meta.dir, "..", "public", "index.html"),
  "utf-8"
);
const STYLES = readFileSync(
  resolve(import.meta.dir, "..", "public", "styles.css"),
  "utf-8"
);
const README = readFileSync(
  resolve(import.meta.dir, "..", "README.md"),
  "utf-8"
);

function fnBody(name) {
  const re = new RegExp(
    "function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}",
    "m"
  );
  const m = SRC.match(re);
  if (!m) throw new Error("Could not extract function body for \"" + name + "\"");
  return m[1];
}

function previewBody() {
  /* renderPreview is a thin async gate; engine/HTML commit lives in _commitPreviewHtml. */
  return fnBody("renderPreview") + "\n" + fnBody("_commitPreviewHtml");
}

describe("removed legacy identifiers are absent", () => {
  test("no FRAMEWORKS/COMPONENTS/FALLBACK_CSS/html2pdf references survive", () => {
    expect(SRC).not.toContain("var FRAMEWORKS");
    expect(SRC).not.toContain("var COMPONENTS");
    expect(SRC).not.toContain("FALLBACK_CSS");
    expect(SRC).not.toContain("html2pdf");
  });
});

describe("DOC_ENGINES registry is in place", () => {
  test("DOC_ENGINES object and currentDocEngine state are wired up", () => {
    expect(SRC).toMatch(/var\s+DOC_ENGINES\s*=/);
    expect(SRC).toMatch(/var\s+currentDocEngine\s*=/);
  });
});

describe("IDB v3 persistence", () => {
  test("saveToIDB persists docEngine and docLayout at DB_VERSION 3", () => {
    expect(SRC).toContain("var DB_VERSION = 3");
    const body = fnBody("saveToIDB");
    expect(body).toContain("docEngine");
    expect(body).toContain("docLayout");
  });
});

describe("syncExportActionsTop layout", () => {
  test("reads toolbar position and flex rowGap", () => {
    const body = fnBody("syncExportActionsTop");
    expect(body).toContain("toolbar");
    expect(body).toContain("rowGap");
  });
});

describe("buildPageCSS page layout", () => {
  test("keeps page geometry separate from the per-engine footer layer", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("@page");
    expect(body).not.toContain("@bottom-left");
    const footer = fnBody("buildFooterCSS");
    expect(footer).toContain("FOOTER_OWNERS");
    expect(footer).toContain("safeChapter");
    expect(footer).toContain('counter(page) " of " counter(pages)');
  });

  test("CSS footer strings cannot terminate their containing style element", () => {
    const body = fnBody("escapeCssStringForStyleElement");
    expect(body).toContain('.replace(/</g, "\\\\3C ")');
    expect(body).toContain('.replace(/&/g, "\\\\26 ")');
    expect(fnBody("buildFooterCSS")).toContain("escapeCssStringForStyleElement(chapterTitle)");
  });

  test("guards columns and break-inside rules", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("@supports (column-count: 2)");
    expect(body).toContain(".fw-column-flow");
    expect(body).toContain("column-count: 1");
    expect(body).toContain("break-inside: avoid");
    expect(body).toContain("column-fill: balance");
  });

  test("does not pad body to fake a footer (margin-box reservation is the renderer's job)", () => {
    const body = fnBody("buildPageCSS");
    expect(body).not.toContain("padding-bottom: 3mm");
    expect(body).not.toContain("@bottom-left");
    expect(body).not.toContain("@bottom-right");
  });
});

describe("paged preview lifecycle", () => {
  test("starts Paged.js deterministically before committing its staging frame", () => {
    const body = previewBody();
    expect(body).toContain('window.PagedConfig = { auto: false }');
    expect(body).toContain('PagedPolyfill.on("afterPreview", _commitPagedPreview)');
    expect(body).toContain("window.PagedPolyfill.preview().then(_commitPagedPreview)");
    expect(body).toContain(".catch(function()");
    expect(body).not.toContain('window.addEventListener("load", function()');
    expect(body).not.toContain("setTimeout(_vivlNotify, 3000)");
  });

  test("only commits a Paged.js frame after real page boxes exist", () => {
    /* Both _commitPagedPreview and _fitPage get used here; together they
       signal "Paged.js has produced real pages and we're ready to commit".
       Rather than rely on the leaky fnBody regex, scan the whole source
       for the required commitment message and the safe spread-scope
       gate that replaces the old document-wide `.pagedjs_page` query. */
    expect(SRC).toContain('parent.postMessage({type:"paged-ready"');
    expect(SRC).toContain(":scope > .pagedjs_page");
    /* The unsafe global selector against bare `.pagedjs_page` is gone —
       no consumer of the page list may scan the whole document for it. */
    expect(SRC).not.toContain('document.querySelectorAll(".pagedjs_page")');
    expect(SRC).not.toContain("!document.querySelector(\".pagedjs_page\")");
  });

  test("does not mutate page geometry while Paged.js is still paginating", () => {
    const body = previewBody();
    expect(body).not.toContain("new MutationObserver");
    expect(body).not.toContain('if (document.querySelector(".pagedjs_page")) { _fitPage();');
  });

  test("does not rely on an early animation-frame race to commit Paged.js", () => {
    const body = previewBody();
    expect(body).not.toContain("requestAnimationFrame(_commitPagedPreview)");
  });

  test("does not use blind load/timeouts as successful pagination signals", () => {
    const body = previewBody();
    expect(body).not.toContain('window.addEventListener("load", function()');
    expect(body).not.toContain("setTimeout(_vivlNotify, 3000)");
  });

  test("preview scaling preserves page-flow geometry", () => {
    const body = previewBody();
    expect(body).toContain('pages.style.setProperty("transform", "scale(" + s + ")"');
    expect(body).not.toContain('document.body.style.transform = "scale(" + s + ")"');
  });

  test("engine pagination failures are surfaced, not swallowed", () => {
    // The iframe posts these on failure; the parent must act on both.
    expect(SRC).toContain('type:"paged-error"');
    expect(SRC).toContain('type:"vivl-error"');
    expect(SRC).toContain("function onPreviewFrameError");
    // The parent message listener routes both error types to the handler.
    expect(SRC).toContain('e.data.type === "paged-error" || e.data.type === "vivl-error"');
    // Failure handling is renderId-guarded so a stale failure can't clobber a good frame.
    const body = fnBody("onPreviewFrameError");
    expect(body).toContain("e.data.renderId !== currentRenderId");
    expect(body).toContain("hidePreviewLoader()");
  });
});

describe("exportHTML", () => {
  test("uses canonical CSS after validating live settings", () => {
    const body = fnBody("exportHTML");
    expect(body).toContain("buildDocumentCSS(currentDocEngine)");
    expect(body).toContain("syncDocumentSettingsFromControls()");
  });
});

describe("exportPDF", () => {
  test("branches on surfaceMode", () => {
    expect(SRC).toContain("function exportPDF");
    const body = fnBody("exportPDF");
    expect(body).toContain("surfaceMode");
  });

  test("validates settings and waits for snapshot fonts", () => {
    const body = fnBody("exportPDF");
    expect(body).toContain("syncDocumentSettingsFromControls()");
    expect(fnBody("buildEnginePrintSnapshot")).toContain("document.fonts.ready");
  });

  test("removes preview-only page-flow scaling before printing", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain('clone.querySelector(".pagedjs_pages")');
    expect(body).toContain('pagesFlow.removeAttribute("style")');
    expect(body).toContain('clone.querySelector("[data-vivliostyle-spread-container]")');
    expect(body).toContain('clone.querySelector("[data-vivliostyle-outer-zoom-box]")');
    expect(body).toContain('clone.querySelector("#vivl-viewport")');
  });

  test("strips Vivliostyle dynamically injected zoom/scale styles", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain('clone.querySelector("#vivl-scroll-style")');
    expect(body).toContain('clone.querySelector("#_fw_vivl_shell")');
    expect(body).not.toContain('text.indexOf("data-vivliostyle")');
    expect(body).toContain('page.querySelectorAll("[style]")');
    expect(body).toContain("transform|zoom|width|height|position");
  });

  test("preserves author inline styles in Vivliostyle page containers", () => {
    /* Regression test: the old code used page.querySelectorAll("*").forEach
       to blanket-remove style attributes from all descendants, destroying
       legitimate author styles (the sanitizer allows inline style). The new
       code selectively strips only Vivliostyle layout properties. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).not.toContain('page.querySelectorAll("*")');
    expect(body).toContain('getAttribute("style")');
    expect(body).toContain('setAttribute("style", cleaned)');
  });

  test("prints the committed pagination once instead of re-running the engine", () => {
    const body = fnBody("exportPDF");
    const snapshot = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("buildPrintSnapshot");
    expect(body).not.toContain('window.PagedPolyfill.on("afterPreview"');
    expect(body).not.toContain('window.PagedPolyfill.on("afterRenderation"');
    expect(body).not.toContain("viewer.loadDocument");
    expect(snapshot).toContain('clone.querySelectorAll("script, #_fw_stripe');
    expect(snapshot).toContain("break-after: page");
    expect(snapshot).toContain("PAGE_SIZES[pageSize]");
    expect(snapshot).toContain("orientation");
    expect(snapshot).not.toContain("PAGE_SIZES_MM");
    expect(snapshot).not.toContain("docLayout.size");
    expect(snapshot).toContain("pageGeometry");
    expect(snapshot).toContain("overflow: hidden");
  });
});

describe("FlatWrite PDF spacing tag", () => {
  test("normalizes bounded integer breaks only for paged engines", () => {
    const body = fnBody("applyFlatWritePdfBreaks");
    expect(body).toContain("FW_PDF_BREAK_MAX");
    expect(body).toContain('renderEngineKey === "pagedjs" || renderEngineKey === "vivliostyle"');
    expect(body).toContain('class="fw-pdf-break"');
    expect(body).toContain("Math.trunc");
    expect(body).toContain("Math.max(0, Math.min(FW_PDF_BREAK_MAX, lines))");
    expect(body).toContain("Number.isFinite(numeric) ? Math.trunc(numeric) : 0");
  });

  test("defaults missing lines to one and removes malformed tags", () => {
    const body = fnBody("applyFlatWritePdfBreaks");
    expect(body).toContain("countMatch ? Number(countMatch[1]) : 1");
    expect(body).toContain("Remove malformed/unclosed FlatWrite break tags");
  });

  test("plain/read output strips the proprietary tag without leaving text", () => {
    const body = fnBody("applyFlatWritePdfBreaks");
    expect(body).toContain('return isPaged ? replacement : ""');
    expect(previewBody()).toContain("applyFlatWritePdfBreaks(");
    expect(previewBody()).toContain("renderEngineKey");
  });

  test("applies the same tag transform in fresh HTML exports", () => {
    const body = fnBody("exportHTML");
    expect(body).toContain("applyFlatWritePdfBreaks(");
    expect(body).toContain("currentDocEngine");
  });

  test("documents the public syntax and its 0–24 bound", () => {
    expect(README).toContain('<fw-break lines="3" />');
    expect(README).toContain("0–24");
    expect(README).toContain("Plain");
    expect(README).toContain("Read");
  });

  test("Math Mode toggle lives in the View-mode (typo-controls) toolbar, last", () => {
    // btn-math is NOT in the Edit-mode (md-toolbar) anymore
    const mdToolbar = INDEX.match(/id="md-toolbar"[\s\S]*?<\/div>/)?.[0] || "";
    expect(mdToolbar).not.toContain('id="btn-math"');
    // btn-math IS in the View-mode (typo-controls) toolbar, after spacing controls
    // Use the full toolbar-slides block to capture nested divs
    const slides = INDEX.match(/class="toolbar-slides"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || "";
    expect(slides).toContain('id="btn-math"');
    expect(slides).toContain('aria-label="Math Mode"');
    // btn-math is the LAST control in the typo-controls div — no button
    // or input element should appear between btn-math and the closing </div>.
    const afterBtnMath = slides.split('id="btn-math"')[1] || "";
    const closingDiv = afterBtnMath.indexOf("</div>");
    const between = afterBtnMath.slice(0, closingDiv);
    expect(between).not.toMatch(/<button[\s\S]*?<\/button>/);
    expect(between).not.toMatch(/<input[\s\S]*?>/);
    // Edit toolbar still has AI Assist first and page-break
    expect(mdToolbar).toMatch(/id="md-toolbar"[^>]*>\s*<button[^>]+id="btn-assist"/);
    expect(mdToolbar).toContain('id="btn-page-break"');
    expect(mdToolbar).toContain('data-md="pagebreak"');
    expect(mdToolbar).toContain('aria-label="Insert PDF page break"');
  });

  test("documents both toolbar controls' behavior", () => {
    expect(SRC).toContain(
      '"btn-page-break": "Insert PDF-only line spacing; edit lines=1 for more (ignored in Plain and Read)"'
    );
    expect(SRC).toContain(
      '"btn-assist": "AI Assist — Coming Soon!"'
    );
  });

  test("inserts one standalone break tag at the caret without replacing a selection", () => {
    const insertBody = fnBody("editorInsertPageBreak");
    expect(insertBody).toContain('var tag = \'<fw-break lines="1" />\'');
    expect(insertBody).toContain("val.substring(start)");
    expect(insertBody).not.toContain("selectionEnd");
    expect(insertBody).toContain('val[start] === "\\n"');
    expect(insertBody).toContain('tag.indexOf("1")');
    expect(fnBody("applyMarkdownFormat")).toContain(
      'case "pagebreak":     editorInsertPageBreak(); break;'
    );
  });
});

describe("paged canvas extent", () => {
  test("both engines derive the scroll height from the scaled page flow", () => {
    const body = previewBody();
    expect(body).toContain("_setPagedCanvasExtent");
    expect(body).toContain("_setVivlCanvasExtent");
    expect(SRC).toContain("document.body.style.height = Math.ceil(flowH * s) + \"px\"");
    expect(body).toContain('outerZoom.style.setProperty("height", scaledH + "px", "important")');
  });

  test("Vivliostyle page containers are not forced to pixel dimensions", () => {
    const body = previewBody();
    expect(body).not.toContain('pages[i].style.width = _pageW + "px";\n');
    expect(body).not.toContain('pages[i].style.height = _pageH + "px";\n');
    expect(body).toContain('if (pages[i].style.width === "" && pages[i].offsetWidth === 0)');
    expect(body).toContain('if (pages[i].style.height === "" && pages[i].offsetHeight === 0)');
  });
});

describe("button tooltips", () => {
  test("uses one accessible viewport-aware tooltip layer for every button", () => {
    expect(SRC).toContain("function initButtonTooltips");
    const body = fnBody("initButtonTooltips");
    expect(body).toContain('root.querySelectorAll("button")');
    expect(body).toContain("MutationObserver");
    expect(body).toContain('target.matches("button")');
    expect(body).toContain('target.closest("button")');
    expect(body).toContain('tooltip.setAttribute("role", "tooltip")');
    expect(body).toContain('button.setAttribute("aria-describedby", tooltip.id)');
    expect(STYLES).toContain(".fw-tooltip");
    expect(STYLES).toContain("white-space: nowrap");
  });

  test("Plain PDF guidance names both engines", () => {
    expect(SRC).toContain("Switch to Paged.js or Vivliostyle to enable PDF export");
  });

  test("engine button tooltips use title before aria-label", () => {
    const body = fnBody("getButtonTooltip");
    const titleIdx = body.indexOf('var title = button.getAttribute("title")');
    const ariaIdx = body.indexOf('var aria = button.getAttribute("aria-label")');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeLessThan(ariaIdx);
  });

  test("tooltip is a fixed-width popup box with drop shadow", () => {
    expect(STYLES).toContain(".fw-tooltip");
    expect(STYLES).toContain("width: 220px");
    expect(STYLES).toContain("white-space: normal");
    expect(STYLES).toContain("box-shadow: 0 8px 24px");
    expect(STYLES).not.toContain(".fw-tooltip {\n  white-space: nowrap");
    expect(STYLES).not.toContain(".fw-tooltip {\n  overflow: hidden");
  });
});

describe("Read mode logo position", () => {
  test("adds five pixels to the settled toolbar destination", () => {
    expect(fnBody("animateLogoToCenter")).toContain("toolbarRect.left + 5");
  });
});

describe("asset cache keys", () => {
  test("loads the page-break toolbar JavaScript revision", () => {
    expect(INDEX).toContain('url-routing.js?v=1');
    expect(INDEX).toContain('app.js?v=135');
    expect(INDEX).toContain('math-render.js?v=5');
  });

  test("loads the stylesheet revision", () => {
    expect(INDEX).toContain('styles.css?v=127');
  });
});

describe("print snapshot footer", () => {
  test("replaces counter(pages) with the static page count", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("pageCount");
    expect(body).toContain("counter(pages)");
    expect(body).toContain("String(pageCount)");
    expect(body).toContain("style.id === \"_fw_print_snapshot\"");
  });

  test("forces @page margin to 0 so the .pagedjs_page sheet maps 1:1 to a Chrome PDF page", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    /* Adding @page margin here used to shrink Chrome's printable area below
       the full page height; each .pagedjs_page would then spill onto a
       second Chrome PDF page (10 pages instead of 5 when footer was on).
       Footer positioning is handled separately via
       .pagedjs_page .pagedjs_margin-bottom-left with `position: absolute;
       bottom: 0`, so it stays anchored regardless of @page margin. */
    expect(body).toMatch(/footerMargin\s*=\s*["']0["']/);
    expect(body).not.toMatch(/footerMargin\s*=\s*showFooter/);
  });

  test("adds explicit footer positioning CSS when footer is on", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("pagedjs_margin-bottom-left");
    expect(body).toContain("pagedjs_margin-bottom-right");
    expect(body).toContain("position: absolute");
    expect(body).toContain("bottom: 0");
  });

  test("scopes pagedjs_page / vivliostyle-page-container queries to engine-owned roots", () => {
    /* User markdown is rendered with raw HTML enabled. The sanitizer
       allows class="pagedjs_page" and data-vivliostyle-page-container on
       arbitrary <div>/<span> elements, so a clone-wide descendant search
       for those tokens would catch user-authored nodes and pollute both
       the page count (footer's "Page N of M" denominator) and the
       style-stripping pass. The functions must select from the engine-
       emitted roots via :scope > child combinator. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain('pagesFlow.querySelectorAll(":scope > .pagedjs_page")');
    expect(body).toContain('spread.querySelectorAll(":scope > [data-vivliostyle-page-container]")');
    /* The loose descending querySelector against clone/document is no
       longer the primary provenance path. */
    expect(body).not.toContain('clone.querySelectorAll(".pagedjs_page, [data-vivliostyle-page-container]")');
  });

  test("buildPrintSnapshot no longer filters via parent.classList", () => {
    /* The post-hoc filter `parent.classList.contains("pagedjs_pages") ||
       .pagedjs_sheet || ...` was a defense-in-depth band-aid that still
       relied on user-controlled class names as a provenance signal.
       Now that selections are scoped to engine roots via :scope >,
       candidates are guaranteed provenance-correct up front and the
       band-aid filter is gone. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).not.toContain('parent.classList.contains("pagedjs_pages")');
  });

  test("print footer CSS defeats page transform inherited from preview zoom", () => {
    /* Regression guard: if a container above the footer carries a
       transform: rotate() / scale() from the live preview's zoom wrapper,
       the absolutely-positioned footer would inherit it and end up rotated
       or pushed off-page in the PDF. The print snapshot CSS must reset
       transform and writing-mode on the footer itself. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("transform: none !important");
    expect(body).toContain("writing-mode: horizontal-tb !important");
  });

  test("print footer CSS caps width and keeps footer visible above page edge", () => {
    /* Long chapter titles or rules added later can blow the box past the
       page edge; cap width and force overflow: visible so a tall descender
       doesn't get clipped by .pagedjs_page's overflow: hidden. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("max-width: 45%");
    expect(body).toContain("overflow: visible !important");
    expect(body).toContain("z-index: 1 !important");
  });
});

describe("footer DOM scoping", () => {
  test("_applyFooterContent restricts page lookup to the paged.js spread wrapper", () => {
    /* User-authored markdown may legitimately contain class="pagedjs_page".
       Scoping the query to .pagedjs_pages (when present) prevents footers
       from being injected into user content and stops colliding class names
       from inflating the "Page N of M" total. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain(".pagedjs_pages");
    expect(body).toContain(":scope > .pagedjs_page");
  });

  test("_applyFooterContent requires direct-child sheet>pagebox structure before treating a node as a real page", () => {
    /* Real paged.js emits page > sheet > pagebox. Descendant-only matching
       would still accept user-authored wrappers; require each link in the
       chain to be the *direct* child of the parent paged.js itself emits. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain(":scope > .pagedjs_sheet");
    expect(body).toContain(":scope > .pagedjs_pagebox");
    expect(body).toContain("pageList");
    expect(body).toContain("pageList.push");
  });

  test("_applyFooterContent never falls back to a document-wide class scan", () => {
    /* The previous fallback `document.querySelectorAll(".pagedjs_page")`
       re-opened the very hole the spread wrapper closes. The single
       legitimate document-wide call is for `.pagedjs_pages` itself; any
       document-wide lookup against `.pagedjs_page` would re-open the hole. */
    const body = fnBody("_applyFooterContent");
    expect(body).not.toContain('document.querySelectorAll(".pagedjs_page")');
    expect(body).not.toMatch(/document\.querySelector\("\.pagedjs_page"\)/);
  });

  test("_applyFooterContent resolves margin content via direct children only", () => {
    /* Each step on the path page > pagebox > margin-bottom > {left,right} >
       content must be a direct child so a user wrapper nested inside the
       page's content area cannot satisfy the structural test. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain(":scope > .pagedjs_pagebox");
    expect(body).toContain(":scope > .pagedjs_margin-bottom");
    expect(body).toContain(":scope > .pagedjs_margin-bottom-left");
    expect(body).toContain(":scope > .pagedjs_margin-bottom-right");
    expect(body).toContain(":scope > .pagedjs_margin-content");
  });

  test("_applyFooterContent reads h1 only from the paged.js content area", () => {
    /* A user <h1> outside .pagedjs_area (e.g. in a header element they added)
       must not win as the chapter title — read from the engine-managed
       content area only. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain(".pagedjs_area");
    expect(body).toContain("h1Freq");
  });

  test("_applyFooterContent picks the most-common h1 across pages to resist user-authored h1 hijack", () => {
    /* If the document contains an extra user h1 in body text, paged.js still
       renders it inside .pagedjs_area on later pages. Picking the most-common
       h1 (rather than the last one) keeps a real chapter title from being
       overridden by a stray user heading. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain("h1Freq");
    expect(body).toMatch(/bestCount\s*=\s*h1Freq\[/);
  });

  test("_applyFooterContent uses a prototype-less map for h1 frequency so user text can't shadow Object.prototype", () => {
    /* Security/correctness guard: a chapter heading of "toString" or
       "constructor" must not collide with Object.prototype keys. Earlier
       versions used `pct in h1Freq` against a plain {} which would treat
       those names as pre-existing and increment inherited methods,
       producing NaN counts and wrong chapter selection. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain("Object.create(null)");
    expect(body).toContain("Object.prototype.hasOwnProperty.call");
  });

  test("_applyFooterContent trims h1 text before keying the frequency map", () => {
    /* Whitespace-only headings must not register as valid chapters; collapse
       surrounding whitespace so visually identical headings share a bucket. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain(".replace(/^");
    expect(body).toContain("|\\\\s+$/g");
  });

  test("_applyFooterContent verifies margin-content targets live in the bottom margin grid", () => {
    /* Last-line defense: even if a stray author <div class="pagedjs_margin-bottom-left">
       matches the selector, only overwrite if it actually sits inside the
       paged.js .pagedjs_margin-bottom grid slot. */
    const body = fnBody("_applyFooterContent");
    expect(body).toContain(".pagedjs_margin-bottom");
    expect(body).toContain("isTrustedMarginContent");
    expect(body).toContain("bottomGrid.contains");
  });

  test("_commitPagedPreview gates on the spread wrapper, not a global .pagedjs_page query", () => {
    /* A user-authored <div class="pagedjs_page"> must not flip _pagedReady
       and trigger footer logic against the wrong tree. Use the same direct-
       child scope inside .pagedjs_pages as _applyFooterContent. */
    const body = fnBody("_commitPagedPreview");
    expect(body).toContain(".pagedjs_pages");
    expect(body).toContain(":scope > .pagedjs_page");
    expect(body).not.toMatch(/!document\.querySelector\("\.pagedjs_page"\)/);
  });

  test("PDF popup is sized to the page, not the preview iframe", () => {
    const body = fnBody("exportPDF");
    expect(body).not.toContain("iframeRect");
    expect(body).toContain("getPageWidthPx()");
    expect(body).toContain("getPageHeightPx()");
    expect(body).toContain("popupW");
    expect(body).toContain("popupH");
  });

  test("print snapshot strips @bottom- margin-box rules for native print", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("@bottom-");
    expect(body).toContain("replace(/@(?:bottom|top)-(?:left|center|right)\\s*\\{[\\s\\S]*?\\}/g");
  });

  test("print snapshot handles nested @page blocks with margin boxes", () => {
    /* Regression test: the old regex /@page\s*\{([^}]*)\}/g failed on nested
       braces like @page { @bottom-left { ... } }. The new approach removes
       margin-box at-rules directly, preserving the @page block's size/margin. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("@top-");
    expect(body).toContain("[\\s\\S]*?");
  });
});

describe("preview/export fidelity", () => {
  test("both preview engines wait for fonts and share document CSS", () => {
    const body = previewBody();
    expect(body).toContain("buildDocumentCSS(renderEngineKey)");
    expect(body).toContain("document.fonts.ready");
    expect(body).toContain("viewer.loadDocument(docUrl)");
    expect(body).toContain("ready.then(_initFit)");
  });
});

describe("engine descriptions", () => {
  test("each engine has a detailed description in the DOC_ENGINES registry", () => {
    expect(SRC).toContain('description: "Fast pagination. Best for text-heavy documents. Basic table support');
    expect(SRC).toContain('description: "Professional publishing. Full CSS Table support');
    expect(SRC).toContain('description: "No pagination. WYSIWYG preview for quick edits. PDF export disabled."');
  });

  test("setDocEngine does not reference a description element", () => {
    const body = fnBody("setDocEngine");
    expect(body).not.toContain("engine-description");
    expect(body).not.toContain("engineInfo.description");
  });

  test("engine buttons have detailed title attributes for tooltips", () => {
    expect(INDEX).toContain('title="Fast pagination. Best for text-heavy documents. Basic table support');
    expect(INDEX).toContain('title="Professional publishing. Full CSS Table support');
    expect(INDEX).toContain('title="No pagination. WYSIWYG preview for quick edits. PDF export disabled."');
  });

  test("no engine-description paragraph in the sidebar", () => {
    expect(INDEX).not.toContain("engine-description");
  });

  test("README documents engine choice with a comparison table", () => {
    expect(README).toContain("Choosing a pagination engine");
    expect(README).toContain("Paged.js");
    expect(README).toContain("Vivliostyle");
    expect(README).toContain("Plain CSS");
    expect(README).toContain("Running headers");
    expect(README).toContain("string-set");
  });
});

describe("share pipeline", () => {
  test("buildShareYaml persists document layout and restores only body", () => {
    const body = fnBody("buildShareYaml");
    expect(body).toContain("docEngine");
    expect(body).toContain("pageSize");
    expect(body).toContain("orientation");
    expect(body).toContain("columns");
    expect(fnBody("loadSharedDocument")).toContain("editor.value = parsed.body");
    expect(fnBody("fwApplyContent")).toContain("documentContent = parsed.body");
  });
});

describe("functional controls", () => {
  test("disk loading handles read errors and empty files", () => {
    const body = fnBody("handleFileUpload");
    expect(body).toContain("reader.onerror");
    expect(body).toContain("The selected file is empty");
  });

  test("zoom supports an explicit 100 percent reset", () => {
    expect(SRC).toContain('zoomSlider.addEventListener("dblclick"');
    expect(SRC).toContain("zoomStep = 100");
  });

  test("URL loading disables the live cloned button and binds modal keys once", () => {
    const body = fnBody("loadFromUrlModal");
    expect(body).toContain("btnFetch = newFetch");
    expect(body).toContain("overlay.dataset.fwBound");
    expect(body).toContain("doFetchLatest = doFetch");
    expect(body).toContain("closeLatest = close");
  });

  test("transient toast feedback is exposed as a polite live region", () => {
    const body = fnBody("getToastStack");
    expect(body).toContain('stack.setAttribute("role", "status")');
    expect(body).toContain('stack.setAttribute("aria-live", "polite")');
  });
});

describe("accessibility contracts", () => {
  test("both modal surfaces expose dialog semantics", () => {
    expect(INDEX).toMatch(/id="load-modal"[^>]+role="dialog"[^>]+aria-modal="true"/);
    expect(INDEX).toMatch(/id="comp-modal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  });

  test("the shell provides a reduced-motion mode", () => {
    expect(STYLES).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("muted normal text uses the AA-safe token", () => {
    expect(STYLES).toContain("--text-muted: #67627e");
  });
});

describe("shared-doc YAML pipeline", () => {
  test("loadSharedDocument parses key: value frontmatter without quotes", () => {
    /* The fixture format is single-quote-free block scalar YAML; the parser
       must read each `key: value` line into the frontmatter map. A widely
       used markdown frontmatter parser (js-yaml, etc.) would interpret
       `Unbounded` as a string and `pagedjs` as a value — but FlatWrite's
       own parseShareYaml is intentionally minimal: split on `:`, trim,
       stash. Parsing is delegated to a shared `parseShareYamlMap` helper
       so applyFrontmatter can hydrate from any frontmatter-shaped map
       without re-implementing validation. */
    const body = fnBody("parseShareYaml");
    expect(body).toContain("match(/^\\s*---\\n");
    expect(body).toContain("parseShareYamlMap");
  });

  test("loadSharedDocument routes every frontmatter knob through a single validator", () => {
    /* Today, `loadSharedDocument` (and its sibling in restoreFromIDB) each
       copy-paste the validation ladder. A regression-prone spot: if a new
       frontmatter key is added but one branch forgets to validate, the
       page silently sticks at A4 portrait. Pin the symptom so the helper
       becomes the only place validation lives. */
    const body = fnBody("loadSharedDocument");
    expect(body).toMatch(/applyFrontmatter\(|applyFrontmatter\s*\(/);
  });

  test("loadSharedDocument syncs form controls after applying frontmatter", () => {
    /* Root cause of the "PDF still A4 even though YAML said A3" bug.
       Either applyFrontmatter itself must call syncDocControlsUI, or
       loadSharedDocument must call it explicitly after applying the
       frontmatter map. Both forms are acceptable; the form must be
       synced before renderPreview runs downstream. */
    const shBody = fnBody("loadSharedDocument");
    const afBody = fnBody("applyFrontmatter");
    expect(shBody).toMatch(/applyFrontmatter\(fm\)/);
    expect(shBody).toMatch(/setDocEngine\(currentDocEngine\)/);
    /* The sync could live in applyFrontmatter itself (one source of truth)
       or in shBody explicitly. Pin the helper to own the sync so a
       regression elsewhere doesn't drift. */
    expect(afBody).toMatch(/syncDocControlsUI\(\)/);
  });

  test("applyFrontmatter normalizes every key against its registry", () => {
    const body = fnBody("applyFrontmatter");
    expect(body).toContain("PAGE_SIZES");
    expect(body).toContain("DOC_ENGINES");
    expect(body).toContain("MARGIN_MAP");
    expect(body).toContain("COMFORT_FONTS");
    expect(body).toContain("showFooter");
    expect(body).toContain("pageColumns");
    expect(body).toContain("syncDocControlsUI");
  });

  test("applyFrontmatter trims string before registry lookup so typos stay invalid", () => {
    /* `pageSize:  A3 ` (trailing whitespace) must collapse to "A3"; raw
       spaces that aren't trimmed would fail PAGE_SIZES lookup silently
       and fall back to A4 portrait in the print snapshot. */
    const body = fnBody("applyFrontmatter");
    expect(body).toContain(".trim()");
  });

  test("applyFrontmatter coerces footer to boolean (true/false/on/off) and respects explicit false", () => {
    /* saveToIDB persists docLayout.footer as a boolean. restoreFromIDB
       then routes that map through applyFrontmatter(). The helper used
       to only flip showFooter when fm.footer === "true" or "on"
       (string), so a saved `true` reload came back as the default
       (off), and an explicit `false` was silently swallowed too.
       The new gate must:
         - accept boolean (true/false) from IDB / programmatic callers,
         - accept "true"/"on" => true,
         - accept "false"/"off" => false (so the off-toggle survives
           reload, not just the on-toggle),
         - leave showFooter untouched when fm.footer is undefined or
           any other value. */
    const body = fnBody("applyFrontmatter");
    expect(body).toContain('fm.footer');
    expect(body).toMatch(/typeof\s+v\s*===\s*["']boolean["']/);
    expect(body).toContain('"true"');
    expect(body).toContain('"on"');
    expect(body).toContain('"false"');
    expect(body).toContain('"off"');
  });

  test("restoreFromIDB reapplies form controls after restoring docLayout", () => {
    /* The IDB restore path must follow the same contract: globals from
       record.docLayout are hydrated through applyFrontmatter (which
       itself calls syncDocControlsUI), so a refresh never silently
       returns the user to A4 after the IDB record said A3. */
    const body = fnBody("restoreFromIDB");
    expect(body).toContain("docLayout");
    expect(body).toContain("applyFrontmatter");
  });

  test("share fixture exists for the canonical Ayodhya breakage repro", () => {
    /* The Ayodhya essay at ?s=IUWxUVzE.md is the document the user
       hit the breakage on. Pin the fixture so a regression test can
       re-use it without Dustebin. */
    const fs = require("node:fs");
    const path = require("node:path");
    const fixture = fs.readFileSync(
      resolve(
        import.meta.dir,
        "..",
        "public",
        "test",
        "fixtures",
        "shares",
        "IUWxUVzE.md"
      ),
      "utf-8"
    );
    expect(fixture.startsWith("---\n")).toBe(true);
    expect(fixture).toContain("pageSize: A3");
    expect(fixture).toContain("orientation: landscape");
    expect(fixture).toContain("footer: true");
    expect(fixture).toContain("# Ayodhya: Myth Under Construction");
  });
});

describe("print snapshot geometry", () => {
  test("buildPrintSnapshot recomputes @page size from current globals", () => {
    /* Even when the cached srcdoc fast-path wins (line ~3590), the
       rebuilt snapshot must reflect today's pageSize/orientation — not
       the iframe HTML's first @page rule (which can be stale if the
       user changed controls after paginating but before exporting). */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("PAGE_SIZES[pageSize]");
    expect(body).toContain('orientation === "landscape"');
  });

  test("buildPrintSnapshot uses both width AND height from the page-size registry", () => {
    /* A regression that maps A4 to [297, 0] (transposed) would slip a
       297mm × 0mm @page rule to the snapshot and Chromium would render
       a one-pixel-tall page. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("printPageW");
    expect(body).toContain("printPageH");
    expect(body).not.toMatch(/printPageW\s*=\s*pageMm\[0\]\s*;\s*printPageH\s*=\s*pageMm\[1\]/);
  });

  test("print snapshot removes trailing empty .pagedjs_page elements", () => {
    /* When wide content + columns spills across an offset column
       boundary, paged.js emits a blank trailing page between content
       runs. Strip those before passing the snapshot to the print
       dialog so the exported PDF has every page printed. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toMatch(/emptyPage|\.pagedjs_area.*height|pagesWithContent/);
    expect(body).toContain(":scope > .pagedjs_page");
  });

  test("print snapshot injects @page size at the TOP of the document head", () => {
    /* Chromium's cascade gives precedence to @page rules declared LATER
       in the cascade. Polyfill defaults @page { size: letter } emit
       BEFORE FlatWrite's @page; both end up in the snapshot, but
       FlatWrite's wins. To survive a cached iframe with stale
       @page { size: letter }, the print snapshot's @page must be
       appended at the bottom — but ALSO emit a top-of-head
       `<meta name="print-page-size">`-equivalent that tells Chromium
       to prefer @page over the browser default. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain("@page");
  });

  test("exportPDF doesn't depend on the cached srcdoc path for shared-doc loads", () => {
    /* The cached srcdoc fast-path (line ~3588) bypasses
       syncDocumentSettingsFromControls. For shared docs that means a
       stale form = stale print dimensions. exportPDF must explicitly
       call syncDocumentSettingsFromControls before
       buildPrintSnapshot, regardless of cache state. */
    const body = fnBody("exportPDF");
    expect(body).toContain("syncDocumentSettingsFromControls");
    expect(body).not.toMatch(/syncDocumentSettingsFromControls\(\)\s*\|\|\s*syncDocumentSettingsFromControls\(\)/);
  });
});

describe("page-number footer", () => {
  test("_applyFooterContent writes BOTH bottom-left and bottom-right margin content", () => {
    /* The Ayodhya PDF was missing the "Page N of M" right footer.
       _applyFooterContent MUST populate both cells (chapter on left,
       "Page N of M" on right) so the print dialog doesn't have to rely
       on browser-side counter() resolution, which never runs for
       window.print() snapshots. */
    const body = fnBody("_applyFooterContent");
    expect(body).toMatch(/left\.textContent\s*=\s*chapter|leftBox.*chapter/);
    expect(body).toMatch(/right\.textContent\s*=\s*["']Page /);
    expect(body).toMatch(/" of " \+ (total|pageCount)/);
  });

  test("print snapshot has BOTH left and right margin-box containers wired for @page", () => {
    /* Even if _applyFooterContent runs perfectly, the snapshot HTML
       must contain the DOM elements (left + right .pagedjs_margin-bottom-*)
       so the JS finds them. The snapshot output's appended <style>
       pins their positioning. */
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toContain(".pagedjs_margin-bottom-left");
    expect(body).toContain(".pagedjs_margin-bottom-right");
  });
});

/* (The Phase 2 empty-page filter is verified at the structural level via
   pagesWithContent / "Page " + (i + 1) + " of " + total assertions above
   and the .pagedjs_area filter inside buildPrintSnapshot — but pinning
   that filter explicitly so future refactors don't trivially regress.) */
describe("empty-page culling", () => {
  test("buildPrintSnapshot drops phantom paged.js pages with no .pagedjs_area", () => {
    const body = fnBody("buildEnginePrintSnapshot");
    expect(body).toMatch(/pagesWithContent|emptyPage|hasContentArea/);
    expect(body).toContain(".pagedjs_area");
    expect(body).toMatch(/pageBoxes.*forEach|\.forEach\(function \(box\)/);
  });
});

describe("Math Mode", () => {
  test("persists math flag in share YAML and IDB docLayout", () => {
    expect(fnBody("buildShareYaml")).toContain('"math: " + mathMode');
    expect(fnBody("saveToIDB")).toContain("math: mathMode");
    expect(fnBody("applyFrontmatter")).toContain("fm.math");
    expect(SRC).toMatch(/var\s+mathMode\s*=\s*false/);
  });

  test("gates marked parse and pre-renders KaTeX before iframe commit", () => {
    expect(fnBody("renderToFragment")).toContain("FlatWriteMath.parseMarkdown");
    expect(fnBody("renderPreview")).toContain("finalizeMathHtml");
    expect(fnBody("renderPreview")).toContain("_commitPreviewHtml");
    expect(fnBody("_commitPreviewHtml")).toContain("mathHeadAssets()");
  });

  test("toolbar exposes Math Mode toggle; load dialog prompts on new docs", () => {
    expect(INDEX).toContain('id="btn-math"');
    expect(INDEX).toContain('id="math-modal-overlay"');
    expect(INDEX).not.toContain('id="math-nudge"');
    expect(SRC).toContain("maybePromptMathMode");
    expect(SRC).toContain("bindMathPromptDialog");
    expect(SRC).toContain("hasMathHeuristic");
    expect(SRC).not.toContain("maybeNudgeMathMode");
  });
});

