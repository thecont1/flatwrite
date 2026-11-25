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
 * engines.js — WASM engine initialization for the extract Worker.
 *
 * Both conversion engines are initialized once per isolate at module scope:
 *
 *   - `@firecrawl/anydoc-wasm`         — office/epub/csv conversion + PDF fallback
 *   - `@firecrawl/pdf-inspector-wasm`  — primary PDF conversion
 *
 * Environment note (why this module looks odd):
 *   In workerd, wrangler bundles `*.wasm` imports as compiled WebAssembly
 *   modules, so the default export of each `.wasm` import IS a
 *   `WebAssembly.Module` and `initSync({ module })` can instantiate it
 *   directly — this is the production path.
 *   In Bun tests, the same static import resolves to the wasm file's
 *   absolute path as a plain string (Bun does not implement the workerd
 *   module type). We detect that shape and read the bytes from disk via
 *   `Bun.file`, then compile with `new WebAssembly.Module(bytes)` — which
 *   workerd forbids at runtime, but that branch never executes there
 *   because the import is already a Module. This keeps one source file
 *   working in both environments without test-time module mocking.
 *
 * Startup failure handling:
 *   initSync errors are caught rather than propagated: a thrown exception
 *   at module scope would crash the isolate and turn every request into a
 *   generic 1101 error page. Instead we log the cause server-side and let
 *   conversions fail cleanly with a 500 CONVERT_FAILED response.
 */

import * as anydoc from '@firecrawl/anydoc-wasm';
import * as pdfInspector from '@firecrawl/pdf-inspector-wasm';
import anydocWasm from '@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm';
import pdfInspectorWasm from '@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm';

async function asWasmModule(imported, label) {
  // Production (workerd): the bundled import is already a compiled module.
  if (imported instanceof WebAssembly.Module) return imported;
  // Bun tests: the import is the absolute file path of the .wasm file.
  if (typeof imported === 'string' && typeof Bun !== 'undefined') {
    const bytes = await Bun.file(imported).arrayBuffer();
    return new WebAssembly.Module(bytes);
  }
  throw new Error(`unexpected WASM import shape for ${label}`);
}

async function initEngines() {
  const [anydocModule, pdfModule] = await Promise.all([
    asWasmModule(anydocWasm, 'anydoc'),
    asWasmModule(pdfInspectorWasm, 'pdf-inspector'),
  ]);
  anydoc.initSync({ module: anydocModule });
  pdfInspector.initSync({ module: pdfModule });
  return { anydoc, pdf: pdfInspector };
}

// Kicked off at module scope. In workerd both wasm imports are already
// WebAssembly.Module instances, so initialization settles within microtasks
// of module evaluation — before any request can be handled, since
// handleExtract awaits this same promise. On failure the promise resolves
// to `null` (after logging) instead of rejecting, so no isolate crash and
// no unhandled rejection.
export const enginesReady = initEngines().catch((error) => {
  console.error(
    'flatwrite-extract: WASM engine initialization failed — conversions will return 500 CONVERT_FAILED:',
    error,
  );
  return null;
});
