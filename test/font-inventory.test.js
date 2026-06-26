/**
 * Regression test: every font listed as selectable in the user-facing
 * picker must have a corresponding woff2 file registered in
 * core/font-loader.js's FONT_FILES inventory.
 *
 * Otherwise the renderer silently falls back to system-ui when the
 * caller picks a "supported" font that has no embedded face — which
 * is exactly the bug that Comfortaa exposed.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FONT_LOADER = resolve(REPO_ROOT, "core/font-loader.js");
const FONT_DIR = resolve(REPO_ROOT, "public/fonts");
const DOCUMENT_CSS = resolve(REPO_ROOT, "core/document-css.js");

// Load the source as text and extract the two registries. We parse the
// object literals with `eval`-style dynamic Function construction, but
// keep each evaluation isolated to a fresh Function scope.
function extractObject(src, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`);
  const m = src.match(re);
  if (!m) throw new Error(`Could not find ${name} in source`);
  const start = m.index;
  let depth = 0;
  let openIdx = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      if (openIdx === -1) openIdx = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const objSrc = src.slice(openIdx, i + 1);
        // Eval only the object literal in a sandboxed function.
        const fn = new Function("return (" + objSrc + ");");
        return fn();
      }
    }
  }
  throw new Error(`Unbalanced braces for ${name}`);
}

describe("font picker inventory matches bundled woff2s", () => {
  test("every entry in COMFORT_FONTS has a corresponding FONT_FILES entry", () => {
    const comfort = extractObject(readFileSync(DOCUMENT_CSS, "utf-8"), "COMFORT_FONTS");
    const inventory = extractObject(readFileSync(FONT_LOADER, "utf-8"), "FONT_FILES");
    const pickerFonts = Object.keys(comfort);
    expect(pickerFonts.length).toBeGreaterThan(0);

    const missing = pickerFonts.filter((name) => !(name in inventory));
    expect(missing).toEqual([]);
  });

  test("every woff2 file referenced in FONT_FILES actually exists on disk", () => {
    const inventory = extractObject(readFileSync(FONT_LOADER, "utf-8"), "FONT_FILES");
    const missing = [];
    for (const [name, faces] of Object.entries(inventory)) {
      for (const face of faces) {
        const path = resolve(FONT_DIR, face.file);
        if (!existsSync(path)) {
          missing.push(`${name} → ${face.file}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("every bundled woff2 starts with the wOF2 magic", () => {
    const inventory = extractObject(readFileSync(FONT_LOADER, "utf-8"), "FONT_FILES");
    for (const [, faces] of Object.entries(inventory)) {
      for (const face of faces) {
        const buf = readFileSync(resolve(FONT_DIR, face.file));
        const magic = buf.subarray(0, 4).toString("latin1");
        expect(magic).toBe("wOF2");
      }
    }
  });
});
