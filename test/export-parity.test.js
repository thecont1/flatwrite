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

  test("No framework CDN URLs remain", () => {
    expect(SRC).not.toContain("spectre.css");
    expect(SRC).not.toContain("poshui-components.netlify.app");
    expect(SRC).not.toContain("oat.min.css");
    expect(SRC).not.toContain("picocss/pico");
    expect(SRC).not.toContain("milligram");
    expect(SRC).not.toContain("chota");
    expect(SRC).not.toContain("simpledotcss");
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

  test("saveToIDB persists docEngine (not framework)", () => {
    const body = fnBody("saveToIDB");
    expect(body).toContain("docEngine");
    expect(body).not.toContain("framework:");
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

describe("renderPreview — no framework injection", () => {
  const body = fnBody("renderPreview");

  test("does not serialize framework style functions", () => {
    expect(body).not.toContain("styleFnStr");
    expect(body).not.toContain("styleFn(document)");
  });

  test("does not load framework CSS or JS", () => {
    expect(body).not.toContain("fw.css");
    expect(body).not.toContain("fw.js");
  });

  test("still renders markdown via marked.parse", () => {
    expect(body).toContain("marked.parse");
  });

  test("still sanitizes HTML", () => {
    expect(body).toContain("sanitizeHTML");
  });

  test("has basic typography CSS in iframe", () => {
    expect(body).toContain("font-size");
    expect(body).toContain("font-weight");
    expect(body).toContain("line-height");
  });
});

describe("exportHTML — no framework injection", () => {
  const body = fnBody("exportHTML");

  test("does not serialize framework style functions", () => {
    expect(body).not.toContain("styleFnStr");
    expect(body).not.toContain("styleFn(document)");
  });

  test("does not load framework CSS or JS", () => {
    expect(body).not.toContain("fw.css");
    expect(body).not.toContain("fw.js");
  });

  test("does not reference FALLBACK_CSS", () => {
    expect(body).not.toContain("FALLBACK_CSS");
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
