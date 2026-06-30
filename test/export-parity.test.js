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

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = readFileSync(resolve(import.meta.dir, "..", "public", "app.js"), "utf-8");

function fnBody(name) {
  const re = new RegExp(
    "function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}",
    "m"
  );
  const m = SRC.match(re);
  if (!m) throw new Error("Could not extract function body for \"" + name + "\"");
  return m[1];
}

function bodyContainsCSSProp(body, prop) {
  const re = new RegExp(prop + "\\s*:", "i");
  return re.test(body);
}

describe("v3 architecture: no web-app framework references", () => {
  test("FRAMEWORKS object does not exist", () => {
    expect(SRC).not.toContain("var FRAMEWORKS");
  });
  test("COMPONENTS array does not exist", () => {
    expect(SRC).not.toContain("var COMPONENTS");
  });
  test("FALLBACK_CSS does not exist", () => {
    expect(SRC).not.toContain("FALLBACK_CSS");
  });
  test("No html2pdf reference", () => {
    expect(SRC).not.toContain("html2pdf");
  });
});

describe("v3 architecture: DOC_ENGINES registry", () => {
  test("DOC_ENGINES object exists", () => {
    expect(SRC).toContain("var DOC_ENGINES");
  });
  test("currentDocEngine state variable exists", () => {
    expect(SRC).toContain("var currentDocEngine");
  });
});

describe("IDB persistence v3", () => {
  test("DB_VERSION is 3", () => {
    expect(SRC).toContain("var DB_VERSION = 3");
  });
  test("saveToIDB persists docEngine", () => {
    const body = fnBody("saveToIDB");
    expect(body).toContain("docEngine");
  });
  test("saveToIDB persists docLayout", () => {
    const body = fnBody("saveToIDB");
    expect(body).toContain("docLayout");
  });
});

describe("syncExportActionsTop", () => {
  const body = fnBody("syncExportActionsTop");
  test("computes position from the toolbar", () => {
    expect(body).toContain("toolbar");
  });
  test("reads the flex rowGap", () => {
    expect(body).toContain("rowGap");
  });
});

describe("buildPageCSS", () => {
  test("function exists in source", () => {
    expect(SRC).toContain("function buildPageCSS");
  });
  test("contains @page rule", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("@page");
  });
  test("calls getPageCSS() for page dimensions", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("getPageCSS()");
  });
  test("supports columns", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("column-count");
  });
  test("supports page numbers", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("counter(page)");
  });
  test("supports running footers", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("string(chapter");
  });
  test("footer prints page n of N", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain('"Page " counter(page) " of " counter(pages)');
  });
});

describe("Page sizes and orientation", () => {
  test("PAGE_SIZES includes A0-A5", () => {
    expect(SRC).toContain("A0:");
    expect(SRC).toContain("A1:");
    expect(SRC).toContain("A2:");
    expect(SRC).toContain("A3:");
    expect(SRC).toContain("A4:");
    expect(SRC).toContain("A5:");
  });
  test("PAGE_SIZES includes Letter and Legal", () => {
    expect(SRC).toContain("Letter:");
    expect(SRC).toContain("Legal:");
  });
  test("orientation state variable exists", () => {
    expect(SRC).toContain('var orientation');
  });
  test("getPageCSS handles orientation", () => {
    const body = fnBody("getPageCSS");
    expect(body).toContain("landscape");
  });
  test("getPageWidthPx exists", () => {
    expect(SRC).toContain("function getPageWidthPx");
  });
});

describe("renderPreview — Paged.js integration", () => {
  const body = fnBody("renderPreview");
  test("looks up engine from DOC_ENGINES", () => {
    expect(body).toContain("DOC_ENGINES[renderEngineKey]");
  });
  test("injects engine script tag", () => {
    expect(body).toContain("engineScript");
  });
  test("delegates @page rules to buildPageCSS()", () => {
    expect(body).toContain("buildPageCSS()");
  });
  test("includes crop mark styles", () => {
    expect(body).toContain("pagedjs_page");
  });
  test("uses PagedPolyfill for scroll restore", () => {
    expect(body).toContain("PagedPolyfill");
  });
  test("has fallback for non-paged layout", () => {
    expect(body).toContain("body.engine-none");
  });
  test("still renders markdown", () => {
    expect(body).toContain("renderToFragment");
  });
});

describe("exportHTML", () => {
  const body = fnBody("exportHTML");
  test("delegates @page to buildPageCSS()", () => {
    expect(body).toContain("buildPageCSS()");
  });
  test("has typography CSS", () => {
    expect(body).toContain("font-size");
    expect(body).toContain("headWeight");
  });
});

describe("exportPDF", () => {
  test("function exists", () => {
    expect(SRC).toContain("function exportPDF");
  });
  test("branches on surfaceMode", () => {
    const body = fnBody("exportPDF");
    expect(body).toContain("surfaceMode");
  });
});

describe("share pipeline", () => {
  test("buildShareYaml includes docEngine", () => {
    const body = fnBody("buildShareYaml");
    expect(body).toContain("docEngine");
  });
  test("buildShareYaml includes pageSize", () => {
    const body = fnBody("buildShareYaml");
    expect(body).toContain("pageSize");
  });
  test("buildShareYaml includes orientation", () => {
    const body = fnBody("buildShareYaml");
    expect(body).toContain("orientation");
  });
});
