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

function fnBody(name) {
  const re = new RegExp(
    "function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}",
    "m"
  );
  const m = SRC.match(re);
  if (!m) throw new Error("Could not extract function body for \"" + name + "\"");
  return m[1];
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
  test("emits @page rule and Page n of N footer marker", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("@page");
    expect(body).toContain(
      '"Page " counter(page) " of " counter(pages)'
    );
  });

  test("guards columns and clears disabled footers", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("@supports (column-count: 2)");
    expect(body).toContain("column-count: 1");
    expect(body).toContain("break-inside: avoid");
    expect(body).toContain("@bottom-left { content: none; }");
    expect(body).toContain("@bottom-right { content: none; }");
  });

  test("reserves page margin boxes without pushing them into body content", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("@bottom-left");
    expect(body).toContain("@bottom-right");
    expect(body).not.toContain("padding-bottom: 3mm");
  });
});

describe("paged preview lifecycle", () => {
  test("starts Paged.js deterministically before committing its staging frame", () => {
    const body = fnBody("renderPreview");
    expect(body).toContain('window.PagedConfig = { auto: false }');
    expect(body).toContain('PagedPolyfill.on("afterPreview", _commitPagedPreview)');
    expect(body).toContain("window.PagedPolyfill.preview().then(_commitPagedPreview)");
    expect(body).toContain(".catch(function()");
    expect(body).not.toContain('window.addEventListener("load", function()');
    expect(body).not.toContain("setTimeout(_vivlNotify, 3000)");
  });

  test("only commits a Paged.js frame after real page boxes exist", () => {
    const body = fnBody("renderPreview");
    expect(body).toContain('!document.querySelector(".pagedjs_page")');
    expect(body).toContain('parent.postMessage({type:"paged-ready"');
  });

  test("does not mutate page geometry while Paged.js is still paginating", () => {
    const body = fnBody("renderPreview");
    expect(body).not.toContain("new MutationObserver");
    expect(body).not.toContain('if (document.querySelector(".pagedjs_page")) { _fitPage();');
  });

  test("does not rely on an early animation-frame race to commit Paged.js", () => {
    const body = fnBody("renderPreview");
    expect(body).not.toContain("requestAnimationFrame(_commitPagedPreview)");
  });

  test("does not use blind load/timeouts as successful pagination signals", () => {
    const body = fnBody("renderPreview");
    expect(body).not.toContain('window.addEventListener("load", function()');
    expect(body).not.toContain("setTimeout(_vivlNotify, 3000)");
  });

  test("preview scaling preserves page-flow geometry", () => {
    const body = fnBody("renderPreview");
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

describe("paged canvas extent", () => {
  test("both engines derive the scroll height from the scaled page flow", () => {
    const body = fnBody("renderPreview");
    expect(body).toContain("_setPagedCanvasExtent");
    expect(body).toContain("_setVivlCanvasExtent");
    expect(SRC).toContain("document.body.style.height = Math.ceil(flowH * s) + \"px\"");
    expect(body).toContain('outerZoom.style.setProperty("height", scaledH + "px", "important")');
  });
});

describe("Read mode logo position", () => {
  test("adds five pixels to the settled toolbar destination", () => {
    expect(fnBody("animateLogoToCenter")).toContain("toolbarRect.left + 5");
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

  test("validates settings, shares CSS, and waits for fonts", () => {
    const body = fnBody("exportPDF");
    expect(body).toContain("syncDocumentSettingsFromControls()");
    expect(body).toContain("buildDocumentCSS(currentDocEngine)");
    expect(body).toContain("document.fonts.ready");
  });
});

describe("preview/export fidelity", () => {
  test("both preview engines wait for fonts and share document CSS", () => {
    const body = fnBody("renderPreview");
    expect(body).toContain("buildDocumentCSS(renderEngineKey)");
    expect(body).toContain("document.fonts.ready");
    expect(body).toContain("viewer.loadDocument(docUrl)");
    expect(body).toContain("ready.then(_initFit)");
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
