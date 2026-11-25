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
 * local-extract.js — classic-script facade for browser-local extraction.
 * Office documents and PDFs run in extract-worker.js; images run through
 * Tesseract.js here on the main thread (Tesseract internally owns its own
 * worker) and then through the shared OCR layout port in extract-core.js.
 */
(function () {
  'use strict';

  var currentScript = document.currentScript;
  var scriptBaseUrl = currentScript && currentScript.src
    ? new URL('.', currentScript.src).href
    : new URL('.', window.location.href).href;
  var WORKER_TIMEOUT_MS = 120000;

  var extractCorePromise = null;
  var manifestPromise = null;
  var tesseractScriptPromise = null;
  var tesseractWorkerPromise = null;

  var worker = null;
  var workerQueue = Promise.resolve();
  var nextMessageId = 1;
  var pendingMessages = new Map();

  function assetUrl(relativePath) {
    return new URL(relativePath, scriptBaseUrl).href;
  }

  function makeError(status, code, message) {
    var error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  function conversionFailedError() {
    return makeError(500, 'CONVERT_FAILED', 'Conversion failed');
  }

  function loadExtractCore() {
    if (!extractCorePromise) {
      extractCorePromise = import(assetUrl('extract-core.js'));
    }
    return extractCorePromise;
  }

  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = fetch(assetUrl('vendor/extract-manifest.json'))
        .then(function (response) {
          if (!response.ok) throw new Error('manifest HTTP ' + response.status);
          return response.json();
        });
      manifestPromise.catch(function () { manifestPromise = null; });
    }
    return manifestPromise;
  }

  function loadTesseractScript() {
    if (!tesseractScriptPromise) {
      tesseractScriptPromise = loadManifest().then(function (manifest) {
        return new Promise(function (resolve, reject) {
          if (window.Tesseract && typeof window.Tesseract.createWorker === 'function') {
            resolve(window.Tesseract);
            return;
          }
          var script = document.createElement('script');
          script.src = assetUrl(manifest.tesseract.script);
          script.async = true;
          script.onload = function () {
            if (window.Tesseract && typeof window.Tesseract.createWorker === 'function') {
              resolve(window.Tesseract);
            } else {
              reject(new Error('Tesseract global missing'));
            }
          };
          script.onerror = function () { reject(new Error('Tesseract script failed to load')); };
          document.head.appendChild(script);
        });
      });
      tesseractScriptPromise.catch(function () { tesseractScriptPromise = null; });
    }
    return tesseractScriptPromise;
  }

  function loadTesseractWorker() {
    if (!tesseractWorkerPromise) {
      tesseractWorkerPromise = Promise.all([loadTesseractScript(), loadManifest()])
        .then(function (loaded) {
          var Tesseract = loaded[0];
          var manifest = loaded[1];
          // v7 otherwise defaults to jsdelivr for worker/core/lang. Every URL
          // below is same-origin and versioned; cacheMethod write only uses
          // IndexedDB after the vendored traineddata has been fetched once.
          return Tesseract.createWorker('eng', 1, {
            workerPath: assetUrl(manifest.tesseract.worker),
            corePath: assetUrl(manifest.tesseract.corePath),
            langPath: assetUrl(manifest.tesseract.langPath),
            cacheMethod: 'write',
            workerBlobURL: true,
            gzip: true,
          });
        });
      tesseractWorkerPromise.catch(function () { tesseractWorkerPromise = null; });
    }
    return tesseractWorkerPromise;
  }

  function flattenOcrLines(page) {
    var rows = [];
    var blocks = page && Array.isArray(page.blocks) ? page.blocks : [];
    blocks.forEach(function (block) {
      (block.paragraphs || []).forEach(function (paragraph) {
        (paragraph.lines || []).forEach(function (line) {
          var text = typeof line.text === 'string' ? line.text.trim() : '';
          var confidence = typeof line.confidence === 'number' ? line.confidence : 0;
          var bbox = line.bbox || {};
          if (!text || confidence < 40) return;
          rows.push({
            x: bbox.x0 || 0,
            y: bbox.y0 || 0,
            w: (bbox.x1 || 0) - (bbox.x0 || 0),
            h: (bbox.y1 || 0) - (bbox.y0 || 0),
            text: text,
            conf: confidence,
          });
        });
      });
    });
    return rows;
  }

  async function extractImage(blob, filename, extractCore) {
    await loadTesseractWorker();
    var bytes = await blob.arrayBuffer();
    var result = await extractCore.convert({
      bytes: bytes,
      filename: filename,
      engines: {
        ocr: async function () {
          var ocrWorker = await loadTesseractWorker();
          // Empirical v7 probe: omitting tessedit_pageseg_mode can drop a
          // large top heading from block output on this corpus image, while
          // explicit AUTO ('3') retains it. blocks:true yields the documented
          // blocks → paragraphs → lines shape with bbox/confidence rows.
          var recognized = await ocrWorker.recognize(
            blob,
            { tessedit_pageseg_mode: '3' },
            { text: false, blocks: true },
          );
          return flattenOcrLines(recognized && recognized.data);
        },
      },
    });
    return result;
  }

  function rejectAllPending(error) {
    pendingMessages.forEach(function (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    pendingMessages.clear();
  }

  function terminateWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  function getWorker() {
    if (!worker) {
      worker = new Worker(assetUrl('extract-worker.js'), { type: 'module' });
      worker.onmessage = function (event) {
        var message = event.data || {};
        var pending = pendingMessages.get(message.id);
        if (!pending) return;
        pendingMessages.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.ok) {
          pending.resolve({ markdown: message.markdown, metadata: message.metadata });
        } else {
          pending.reject(makeError(
            message.status || 500,
            message.code || 'CONVERT_FAILED',
            message.error || 'Conversion failed',
          ));
        }
      };
      worker.onerror = function () {
        terminateWorker();
        rejectAllPending(conversionFailedError());
      };
    }
    return worker;
  }

  function runWorkerConversion(blob, filename) {
    return blob.arrayBuffer().then(function (bytes) {
      return new Promise(function (resolve, reject) {
        var id = nextMessageId;
        nextMessageId += 1;
        var activeWorker = getWorker();
        var timeout = setTimeout(function () {
          pendingMessages.delete(id);
          terminateWorker();
          reject(conversionFailedError());
        }, WORKER_TIMEOUT_MS);
        pendingMessages.set(id, { resolve: resolve, reject: reject, timeout: timeout });
        activeWorker.postMessage({ id: id, filename: filename, bytes: bytes }, [bytes]);
      });
    });
  }

  function extractWithWorker(blob, filename) {
    // Serialize conversions: WASM conversion is synchronous inside the worker,
    // and the timeout/terminate recovery path is much safer when only one job
    // can be in flight.
    var operation = workerQueue.then(function () {
      return runWorkerConversion(blob, filename);
    });
    workerQueue = operation.catch(function () {});
    return operation;
  }

  async function extract(blob, filename) {
    var extractCore = await loadExtractCore();
    var typeInfo;
    try {
      typeInfo = extractCore.inferType(filename);
    } catch (_) {
      throw makeError(415, 'UNSUPPORTED_FILE_TYPE', 'unsupported file type');
    }
    if (typeInfo.fileType === 'image') {
      return extractImage(blob, filename, extractCore);
    }
    return extractWithWorker(blob, filename);
  }

  window.FlatwriteLocalExtract = {
    extract: extract,
  };
}());
