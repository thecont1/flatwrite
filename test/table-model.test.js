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

await import("../public/table-model.js");

const TM = globalThis.FlatwriteTableModel;
const SRC = readFileSync(resolve(import.meta.dir, "..", "public", "app.js"), "utf-8");
const INDEX = readFileSync(resolve(import.meta.dir, "..", "public", "index.html"), "utf-8");
const CSS = readFileSync(resolve(import.meta.dir, "..", "core/document-css.js"), "utf-8");

const TABLE = [
  "| name | qty | price |",
  "| --- | ---: | ---: |",
  "| apples | 3 | 1.20 |",
  "| pears | 12 | 0.80 |",
  "| kiwi | 1 | 2.00 |",
].join("\n");

describe("parse / serialize", () => {
  test("parses headers, alignments, and rows", () => {
    const t = TM.parseFirstTable(TABLE);
    expect(t.headers).toEqual(["name", "qty", "price"]);
    expect(t.alignments).toEqual(["left", "right", "right"]);
    expect(t.rows).toEqual([
      ["apples", "3", "1.20"],
      ["pears", "12", "0.80"],
      ["kiwi", "1", "2.00"],
    ]);
  });

  test("round-trips a table and keeps alignments", () => {
    const t = TM.parseFirstTable(TABLE);
    const md = TM.serializeTable(t);
    const again = TM.parseFirstTable(md);
    expect(again.headers).toEqual(t.headers);
    expect(again.alignments).toEqual(t.alignments);
    expect(again.rows).toEqual(t.rows);
    expect(md).toContain("| ---:");
  });

  test("escapes pipes inside cells", () => {
    const t = TM.parseFirstTable("| a |\n| --- |\n| x \\| y |\n");
    expect(t.rows[0][0]).toBe("x | y");
    expect(TM.serializeTable(t)).toContain("x \\| y");
  });

  test("finds a table after a preamble and replaces only that span", () => {
    const md = "# Sales\n\n" + TABLE + "\n\nDone.";
    const found = TM.findTables(md);
    expect(found).toHaveLength(1);
    expect(md.slice(found[0].start, found[0].end)).toBe(TABLE);
    const next = TM.replaceTable(md, found[0], TM.setCell(found[0].table, 0, 0, "oranges"));
    expect(next.startsWith("# Sales\n\n")).toBe(true);
    expect(next.endsWith("\n\nDone.")).toBe(true);
    expect(next).toContain("oranges");
    expect(next).not.toContain("apples");
  });

  test("serializeTable respects rowMask and only emits matching rows", () => {
    const t = TM.parseFirstTable(TABLE);
    const mask = TM.rowMask(t, "pear");
    const md = TM.serializeTable(t, { rowMask: mask });
    expect(md).toContain("pears");
    expect(md).not.toContain("apples");
    expect(md).not.toContain("kiwi");
  });
});

describe("mutations", () => {
  test("sorts numbers and keeps empties last in both directions", () => {
    const t = TM.parseFirstTable(TABLE);
    const withEmpty = { ...t, rows: [...t.rows, ["banana", "", "0.50"]] };
    const desc = TM.sortBy(withEmpty, 1, "desc");
    expect(desc.rows.map((r) => r[1])).toEqual(["12", "3", "1", ""]);
    const asc = TM.sortBy(withEmpty, 1, "asc");
    expect(asc.rows.map((r) => r[1])).toEqual(["1", "3", "12", ""]);
  });

  test("hides a column from serialize without dropping it from the model", () => {
    const hidden = TM.setHidden(TM.parseFirstTable(TABLE), 1, true);
    expect(hidden.hidden[1]).toBe(true);
    const md = TM.serializeTable(hidden);
    expect(md).not.toContain("qty");
    expect(TM.parseFirstTable(md).headers).toEqual(["name", "price"]);
  });

  test("moves, inserts, and deletes columns", () => {
    let t = TM.parseFirstTable(TABLE);
    t = TM.moveColumn(t, 0, 2);
    expect(t.headers[2]).toBe("name");
    t = TM.insertColumn(t, 0, "id");
    expect(t.headers[0]).toBe("id");
    expect(t.rows[0][0]).toBe("");
    t = TM.deleteColumn(t, 0);
    expect(t.headers[0]).not.toBe("id");
  });

  test("filter mask matches case-insensitively", () => {
    const t = TM.parseFirstTable(TABLE);
    expect(TM.rowMask(t, "PEAR")).toEqual([false, true, false]);
    expect(TM.rowMask(t, "")).toEqual([true, true, true]);
  });
});

describe("csv parse", () => {
  test("converts a simple CSV to a markdown table", () => {
    const md = TM.csvToMarkdown("name,qty,price\napples,3,1.20\npears,12,0.80\n");
    const t = TM.parseFirstTable(md);
    expect(t.headers).toEqual(["name", "qty", "price"]);
    expect(t.rows[0]).toEqual(["apples", "3", "1.20"]);
    expect(t.rows[1][0]).toBe("pears");
  });

  test("respects quoted commas and doubled quotes", () => {
    const t = TM.parseCsv('city,note\n"New York, NY","He said ""hi"""\n');
    expect(t.headers).toEqual(["city", "note"]);
    expect(t.rows[0]).toEqual(["New York, NY", 'He said "hi"']);
  });

  test("detects tab-separated values", () => {
    expect(TM.detectCsvDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    const t = TM.parseCsv("a\tb\tc\n1\t2\t3\n");
    expect(t.headers).toEqual(["a", "b", "c"]);
    expect(t.rows[0]).toEqual(["1", "2", "3"]);
  });

  test("preserves newlines inside quoted CSV fields", () => {
    const t = TM.parseCsv('note\n"Line one\nLine two","second cell"\n');
    expect(t.rows[0]).toEqual(["Line one\nLine two", "second cell"]);
  });

  test("returns empty markdown for blank input", () => {
    expect(TM.csvToMarkdown("")).toBe("");
    expect(TM.csvToMarkdown("   \n")).toBe("");
  });
});

describe("app wiring", () => {
  test("CSV drop opens the workshop before print", () => {
    expect(SRC).toContain("openTableWorkshopIfNeeded");
    expect(SRC).toContain("bindTableWorkshop");
    expect(SRC).toContain("Load");
  });

  test("index loads the model before app.js and ships the workshop dialog", () => {
    expect(INDEX).toContain("table-model.js?v=3");
    expect(INDEX).toContain("table-workshop");
    expect(INDEX.indexOf("table-model.js?v=3")).toBeLessThan(INDEX.indexOf("app.js?v=141"));
  });

  test("preview CSS repeats thead on every printed page", () => {
    expect(SRC).toContain("thead { display: table-header-group; }");
    expect(CSS).toContain("thead { display: table-header-group; }");
    expect(CSS).toContain("tr { break-inside: avoid; page-break-inside: avoid; }");
  });
});
