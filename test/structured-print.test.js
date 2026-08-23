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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

await import("../public/structured-print.js");

const SP = globalThis.FlatwriteStructuredPrint;
const SRC = readFileSync(resolve(import.meta.dir, "..", "public", "app.js"), "utf-8");
const INDEX = readFileSync(resolve(import.meta.dir, "..", "public", "index.html"), "utf-8");

const TABLE_MD = [
  "| name | qty | price |",
  "| --- | ---: | ---: |",
  "| apples | 3 | 1.20 |",
  "| pears | 2 | 0.80 |",
].join("\n");

describe("shouldAutoPrint", () => {
  test("treats csv and excel metadata as structured sources", () => {
    expect(SP.shouldAutoPrint("", { fileType: "csv" })).toBe(true);
    expect(SP.shouldAutoPrint("", { fileType: "excel" })).toBe(true);
    expect(SP.shouldAutoPrint("", { fileType: "CSV" })).toBe(true);
  });

  test("does not auto-print ordinary documents", () => {
    expect(SP.shouldAutoPrint("# Hello\n\nA paragraph.", { fileType: "word" })).toBe(false);
    expect(SP.shouldAutoPrint("# Hello\n\nA paragraph.", { fileType: "pdf" })).toBe(false);
    expect(SP.shouldAutoPrint("# Hello\n\nA paragraph.")).toBe(false);
  });

  test("falls back to markdown-table detection when metadata is missing", () => {
    expect(SP.shouldAutoPrint(TABLE_MD)).toBe(true);
  });
});

describe("looksLikeMarkdownTable", () => {
  test("requires a header row and a separator", () => {
    expect(SP.looksLikeMarkdownTable(TABLE_MD)).toBe(true);
    expect(SP.looksLikeMarkdownTable("| just a pipe")).toBe(false);
    expect(SP.looksLikeMarkdownTable("")).toBe(false);
    expect(SP.looksLikeMarkdownTable(null)).toBe(false);
  });
});

describe("countMarkdownTableColumns", () => {
  test("counts the widest data/header row, ignoring the separator", () => {
    expect(SP.countMarkdownTableColumns(TABLE_MD)).toBe(3);
  });

  test("uses the widest of several tables", () => {
    var md = TABLE_MD + "\n\n| a | b | c | d | e |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |\n";
    expect(SP.countMarkdownTableColumns(md)).toBe(5);
  });

  test("returns 0 for non-tables", () => {
    expect(SP.countMarkdownTableColumns("no table here")).toBe(0);
    expect(SP.countMarkdownTableColumns("")).toBe(0);
  });
});

describe("chooseLandscapePageSize", () => {
  test("steps up ISO sizes as column count grows", () => {
    expect(SP.chooseLandscapePageSize(1)).toBe("A4");
    expect(SP.chooseLandscapePageSize(5)).toBe("A4");
    expect(SP.chooseLandscapePageSize(6)).toBe("A3");
    expect(SP.chooseLandscapePageSize(8)).toBe("A3");
    expect(SP.chooseLandscapePageSize(9)).toBe("A2");
    expect(SP.chooseLandscapePageSize(13)).toBe("A1");
    expect(SP.chooseLandscapePageSize(20)).toBe("A0");
  });
});

describe("nextLargerPageSize", () => {
  test("walks A4 → A0 and stops at A0", () => {
    expect(SP.nextLargerPageSize("A4")).toBe("A3");
    expect(SP.nextLargerPageSize("A3")).toBe("A2");
    expect(SP.nextLargerPageSize("A2")).toBe("A1");
    expect(SP.nextLargerPageSize("A1")).toBe("A0");
    expect(SP.nextLargerPageSize("A0")).toBe("A0");
    expect(SP.nextLargerPageSize("Letter")).toBe("A3");
  });
});

describe("buildStructuredPrintSettings", () => {
  test("applies the print-ready table preset", () => {
    expect(SP.buildStructuredPrintSettings(7)).toEqual({
      engine: "vivliostyle",
      orientation: "landscape",
      pageSize: "A3",
      marginsLR: "narrow",
      marginsTB: "narrow",
      font: "JetBrains Mono",
      sizeStep: -2,
      columns: 1,
    });
  });
});

describe("app wiring", () => {
  test("handleExtractDrop starts the structured-print pipeline", () => {
    expect(SRC).toContain("beginStructuredPrintIfNeeded");
    expect(SRC).toContain("continueStructuredPrintOnReady");
    expect(SRC).toContain("cancelStructuredPrintJob");
    expect(SRC).toContain("FlatwriteStructuredPrint");
  });

  test("index loads the helper before app.js", () => {
    expect(INDEX).toContain("structured-print.js?v=2");
    var helperAt = INDEX.indexOf("structured-print.js?v=2");
    var appAt = INDEX.indexOf("app.js?v=142");
    expect(helperAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(helperAt);
  });
});
