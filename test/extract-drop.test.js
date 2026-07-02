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
 * Tests for the drop-handler routing in `public/extract-drop.js`.
 *
 * We import the file (no module wrapper needed — it self-attaches to
 * globalThis.FlatwriteExtractDrop) and exercise:
 *   - routing: .md / .markdown / .txt → 'plain', everything else → 'extract'
 *   - form data construction: field name "file" with the right filename
 *   - error path: empty / non-string filename defaults to 'extract'
 */

import { describe, test, expect, beforeEach } from "bun:test";

// Importing the browser file works in Bun because it's a plain script
// that attaches to globalThis. We side-effect import it here.
await import("../public/extract-drop.js");

const drop = globalThis.FlatwriteExtractDrop;

describe("routeDroppedFile", () => {
  test("routes .md to the plain-text path", () => {
    expect(drop.routeDroppedFile("notes.md")).toBe("plain");
  });

  test("routes .markdown to the plain-text path", () => {
    expect(drop.routeDroppedFile("essay.markdown")).toBe("plain");
  });

  test("routes .txt to the plain-text path", () => {
    expect(drop.routeDroppedFile("readme.txt")).toBe("plain");
  });

  test("is case-insensitive on the extension", () => {
    expect(drop.routeDroppedFile("NOTES.MD")).toBe("plain");
    expect(drop.routeDroppedFile("Notes.TxT")).toBe("plain");
  });

  test("routes .pdf to the extract path", () => {
    expect(drop.routeDroppedFile("whitepaper.pdf")).toBe("extract");
  });

  test("routes .pptx to the extract path", () => {
    expect(drop.routeDroppedFile("deck.pptx")).toBe("extract");
  });

  test("routes .docx to the extract path", () => {
    expect(drop.routeDroppedFile("report.docx")).toBe("extract");
  });

  test("routes .xlsx to the extract path", () => {
    expect(drop.routeDroppedFile("data.xlsx")).toBe("extract");
  });

  test("routes .csv to the extract path", () => {
    expect(drop.routeDroppedFile("data.csv")).toBe("extract");
  });

  test("routes .json to the extract path", () => {
    expect(drop.routeDroppedFile("data.json")).toBe("extract");
  });

  test("routes image files to the extract path (metadata-only in v1)", () => {
    expect(drop.routeDroppedFile("pic.png")).toBe("extract");
    expect(drop.routeDroppedFile("vacation.JPG")).toBe("extract");
  });

  test("routes audio files to the extract path (metadata-only in v1)", () => {
    expect(drop.routeDroppedFile("song.mp3")).toBe("extract");
  });

  test("routes unknown extensions to the extract path (which 415s upstream)", () => {
    expect(drop.routeDroppedFile("archive.tar")).toBe("extract");
  });

  test("routes files without an extension to the extract path", () => {
    expect(drop.routeDroppedFile("Makefile")).toBe("extract");
  });

  test("routes empty string to the extract path (defensive default)", () => {
    expect(drop.routeDroppedFile("")).toBe("extract");
  });

  test("routes non-string to the extract path (defensive default)", () => {
    expect(drop.routeDroppedFile(null)).toBe("extract");
    expect(drop.routeDroppedFile(undefined)).toBe("extract");
    expect(drop.routeDroppedFile(42)).toBe("extract");
  });

  test("only matches the *last* extension (so 'data.csv.md' → plain)", () => {
    expect(drop.routeDroppedFile("data.csv.md")).toBe("plain");
  });

  test("handles a path prefix (Windows or POSIX)", () => {
    expect(drop.routeDroppedFile("C:\\Users\\me\\notes.md")).toBe("plain");
    expect(drop.routeDroppedFile("/home/me/notes.txt")).toBe("plain");
    expect(drop.routeDroppedFile("/home/me/photo.png")).toBe("extract");
  });
});

describe("buildExtractFormData", () => {
  test("appends the file under the 'file' field name", () => {
    // Use a File (not a plain Blob) so we can check the .name property
    // the server will see.
    const file = new File(["hello"], "data.csv", { type: "text/csv" });
    const fd = drop.buildExtractFormData(file, "data.csv");
    const entries = [...fd.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("file");
    // Bun re-serializes the Blob inside FormData so identity doesn't
    // survive, but the data does. Check by content, not reference.
    const value = entries[0][1];
    expect(value).toBeInstanceOf(Blob);
    expect(value.name).toBe("data.csv");
    expect(value.size).toBe(5);
  });
});

describe("PLAIN_TEXT_EXTS", () => {
  test("contains exactly the three plain-text extensions", () => {
    // If you add an extension here, the test reminds you to also update
    // the comment in extract-drop.js and the README.
    // We sort() with explicit default ordering — `Set` preserves insertion
    // order, not lexical.
    expect([...drop.PLAIN_TEXT_EXTS].sort()).toEqual([".md", ".markdown", ".txt"].sort());
  });
});
