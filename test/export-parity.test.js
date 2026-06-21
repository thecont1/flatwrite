import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = readFileSync(resolve(import.meta.dir, "..", "public", "app.js"), "utf-8");

/* --- helpers --- */

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

/* --- tests --- */

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

  test("MODAL_COMPONENTS does not exist", () => {
    expect(SRC).not.toContain("MODAL_COMPONENTS");
  });

  test("fwCssCache does not exist", () => {
    expect(SRC).not.toContain("fwCssCache");
  });


  test("No html2pdf reference", () => {
    expect(SRC).not.toContain("html2pdf");
  });
});

describe("v3 architecture: DOC_ENGINES registry", () => {
  test("DOC_ENGINES object exists", () => {
    expect(SRC).toContain("var DOC_ENGINES");
  });

  test("DOC_ENGINES includes pagedjs", () => {
    expect(SRC).toContain("pagedjs");
  });

  test("DOC_ENGINES includes vivliostyle", () => {
    expect(SRC).toContain("vivliostyle");
  });

  test("currentDocEngine state variable exists", () => {
    expect(SRC).toContain("var currentDocEngine");
  });
});

describe("IDB persistence v3", () => {
  test("DB_VERSION is 2", () => {
    expect(SRC).toContain("var DB_VERSION = 2");
  });

  test("saveToIDB persists docEngine", () => {
    const body = fnBody("saveToIDB");
    expect(body).toContain("docEngine");
    expect(body).not.toContain("framework:");
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
    expect(body).toContain("mainInner");
  });

  test("reads the flex rowGap from .main-inner", () => {
    expect(body).toContain("getComputedStyle");
    expect(body).toContain("rowGap");
  });

  test("clears top on mobile viewports", () => {
    expect(body).toContain("innerWidth < 760");
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

  test("references PAGE_SIZES for page dimensions", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("PAGE_SIZES");
    expect(body).toContain("size:");
  });

  test("references MARGIN_MAP for margins", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("MARGIN_MAP");
    expect(body).toContain("margin:");
  });

  test("supports columns", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("column-count");
  });

  test("supports page numbers", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("counter(page)");
  });

  test("supports running headers", () => {
    const body = fnBody("buildPageCSS");
    expect(body).toContain("string(chapter)");
  });
});

describe("renderPreview — Paged.js integration", () => {
  const body = fnBody("renderPreview");

  test("looks up engine from DOC_ENGINES", () => {
    expect(body).toContain("DOC_ENGINES[currentDocEngine]");
  });

  test("injects engine script tag when available", () => {
    expect(body).toContain("engineScript");
    expect(body).toContain("engine.script");
  });

  test("delegates @page rules to buildPageCSS()", () => {
    expect(body).toContain("buildPageCSS()");
  });

  test("includes crop mark styles", () => {
    expect(body).toContain("pagedjs_page");
    expect(body).toContain("pagedjs_sheet");
  });

  test("uses PagedPolyfill.on afterRenderation for scroll restore", () => {
    expect(body).toContain("PagedPolyfill");
    expect(body).toContain("afterRenderation");
  });

  test("has fallback for non-paged layout", () => {
    expect(body).toContain("body:not(.pagedjs)");
  });

  test("still renders markdown via marked.parse", () => {
    expect(body).toContain("marked.parse");
  });

  test("still sanitizes HTML", () => {
    expect(body).toContain("sanitizeHTML");
  });

  test("has basic typography CSS", () => {
    expect(body).toContain("font-size");
    expect(body).toContain("font-weight");
    expect(body).toContain("line-height");
  });
});

describe("exportHTML — Paged.js integration", () => {
  const body = fnBody("exportHTML");

  test("looks up engine from DOC_ENGINES", () => {
    expect(body).toContain("DOC_ENGINES[currentDocEngine]");
  });

  test("injects engine script tag", () => {
    expect(body).toContain("engineScript");
    expect(body).toContain("engine.script");
  });

  test("delegates @page rules to buildPageCSS()", () => {
    expect(body).toContain("buildPageCSS()");
  });

  test("has fallback for non-paged layout", () => {
    expect(body).toContain("body:not(.pagedjs)");
  });


  test("has typography CSS properties", () => {
    expect(body).toContain("font-size");
    expect(body).toContain("font-weight");
    expect(body).toContain("line-height");
  });

  test("headings use headWeight", () => {
    expect(body).toContain("headWeight");
    expect(body).toContain("Math.min(weight + 200, 900)");
  });

  test("heading sizes proportional to base scale", () => {
    expect(body).toContain("15 * scale * 2");
    expect(body).toContain("15 * scale * 1.5");
    expect(body).toContain("15 * scale * 1.25");
    expect(body).toContain("15 * scale * 1.1");
  });

  test("code blocks use JetBrains Mono", () => {
    expect(body).toContain("JetBrains Mono");
  });

  test("includes base target=_blank for links", () => {
    expect(body).toContain('target="_blank"');
  });

  for (const prop of ["table-layout", "border-left", "list-style-position",
                       "overflow-wrap", "white-space", "overflow-x"]) {
    test("includes " + prop, () => {
      expect(bodyContainsCSSProp(body, prop)).toBe(true);
    });
  }
});

describe("exportPDF — uses window.print()", () => {
  test("exportPDF function exists", () => {
    expect(SRC).toContain("function exportPDF");
  });

  test("uses window.print() for PDF generation", () => {
    const body = fnBody("exportPDF");
    expect(body).toContain("window.print");
  });

  test("does not use html2pdf", () => {
    const body = fnBody("exportPDF");
    expect(body).not.toContain("html2pdf");
  });
});

describe("share pipeline", () => {
  test("buildShareYaml includes docEngine", () => {
    const body = fnBody("buildShareYaml");
    expect(body).toContain("docEngine");
    expect(body).not.toContain("framework:");
  });
});
