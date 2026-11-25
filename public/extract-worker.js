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
 */

/**
 * extract-worker.js — module Web Worker for browser-local office/PDF conversion.
 * Images intentionally do not run here: Tesseract already owns a worker and is
 * orchestrated on the main thread by local-extract.js.
 */
import { convert, ExtractError } from './extract-core.js';

let manifestPromise = null;
let anydocPromise = null;
let pdfPromise = null;

function assetUrl(relativePath) {
  return new URL(relativePath, self.location.href).href;
}

async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const response = await fetch(assetUrl('vendor/extract-manifest.json'));
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      return response.json();
    })();
    manifestPromise.catch(() => { manifestPromise = null; });
  }
  return manifestPromise;
}

async function fetchWasm(relativePath) {
  const response = await fetch(assetUrl(relativePath));
  if (!response.ok) throw new Error(`wasm HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function loadAnydoc() {
  if (!anydocPromise) {
    anydocPromise = (async () => {
      const manifest = await loadManifest();
      const [glue, module] = await Promise.all([
        import(assetUrl(manifest.anydoc.script)),
        fetchWasm(manifest.anydoc.wasm),
      ]);
      glue.initSync({ module });
      return glue;
    })();
    anydocPromise.catch(() => { anydocPromise = null; });
  }
  return anydocPromise;
}

async function loadPdfInspector() {
  if (!pdfPromise) {
    pdfPromise = (async () => {
      const manifest = await loadManifest();
      const [glue, module] = await Promise.all([
        import(assetUrl(manifest.pdfInspector.script)),
        fetchWasm(manifest.pdfInspector.wasm),
      ]);
      glue.initSync({ module });
      return glue;
    })();
    pdfPromise.catch(() => { pdfPromise = null; });
  }
  return pdfPromise;
}

// Lazy engine adapters. extract-core awaits engine results, so the first actual
// use initializes only the needed WASM module; a PDF that pdf-inspector handles
// never downloads/initializes anydoc.
const engines = {
  anydoc: {
    async formatFromExtension(extension) {
      return (await loadAnydoc()).formatFromExtension(extension);
    },
    async toMarkdownBytes(bytes, format) {
      return (await loadAnydoc()).toMarkdownBytes(bytes, format);
    },
  },
  pdf: {
    async processPdf(bytes) {
      return (await loadPdfInspector()).processPdf(bytes);
    },
  },
};

function serializeError(error) {
  if (error instanceof ExtractError) {
    return { status: error.status, code: error.code, error: error.message };
  }
  return { status: 500, code: 'CONVERT_FAILED', error: 'Conversion failed' };
}

self.onmessage = async (event) => {
  const { id, filename, bytes } = event.data || {};
  try {
    const result = await convert({ bytes, filename, engines });
    self.postMessage({
      id,
      ok: true,
      markdown: result.markdown,
      metadata: result.metadata,
    });
  } catch (error) {
    self.postMessage({ id, ok: false, ...serializeError(error) });
  }
};
