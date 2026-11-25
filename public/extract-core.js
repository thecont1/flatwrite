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
 * extract-core.js — pure document-conversion routing shared by browser and
 * server-side extraction. This module deliberately has no DOM, fetch, or WASM
 * imports: callers inject initialized engine objects so it can run in a Web
 * Worker, in Node tests, or in a Cloudflare Worker.
 */

export const EXTENSIONS = Object.freeze({
  // PDF
  '.pdf': Object.freeze({ fileType: 'pdf', extractionType: 'pdf-body' }),
  // Word / Word-like
  '.doc': Object.freeze({ fileType: 'word', extractionType: 'word-body' }),
  '.docx': Object.freeze({ fileType: 'word', extractionType: 'word-body' }),
  '.docm': Object.freeze({ fileType: 'word', extractionType: 'word-body' }),
  '.odt': Object.freeze({ fileType: 'word', extractionType: 'word-body' }),
  '.rtf': Object.freeze({ fileType: 'word', extractionType: 'word-body' }),
  // PowerPoint / presentation-like
  '.ppt': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.pps': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.pot': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.pptx': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.pptm': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.ppsx': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.ppsm': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  '.odp': Object.freeze({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' }),
  // Excel / spreadsheet-like
  '.xls': Object.freeze({ fileType: 'excel', extractionType: 'excel-tables' }),
  '.xlsx': Object.freeze({ fileType: 'excel', extractionType: 'excel-tables' }),
  '.xlsm': Object.freeze({ fileType: 'excel', extractionType: 'excel-tables' }),
  '.xlsb': Object.freeze({ fileType: 'excel', extractionType: 'excel-tables' }),
  '.ods': Object.freeze({ fileType: 'excel', extractionType: 'excel-tables' }),
  '.csv': Object.freeze({ fileType: 'csv', extractionType: 'structured-data' }),
  // Other document formats
  '.epub': Object.freeze({ fileType: 'epub', extractionType: 'epub-body' }),
  // Images are converted through OCR; empty OCR output becomes a metadata stub.
  '.png': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.jpg': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.jpeg': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.gif': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.webp': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.tiff': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.tif': Object.freeze({ fileType: 'image', extractionType: 'image-ocr' }),
  '.mp3': Object.freeze({ fileType: 'audio', extractionType: 'audio-metadata' }),
  '.wav': Object.freeze({ fileType: 'audio', extractionType: 'audio-metadata' }),
  '.m4a': Object.freeze({ fileType: 'audio', extractionType: 'audio-metadata' }),
  '.ogg': Object.freeze({ fileType: 'audio', extractionType: 'audio-metadata' }),
  '.flac': Object.freeze({ fileType: 'audio', extractionType: 'audio-metadata' }),
});

export const MAX_BYTES = 25 * 1024 * 1024;

function filenameParts(filename) {
  const base = String(filename || '').split('/').pop().split('\\').pop();
  if (!base.includes('.')) return { base, ext: null };
  return { base, ext: `.${base.split('.').pop().toLowerCase()}` };
}

/**
 * Map a filename to its canonical type tokens. Mirrors validators.infer_type:
 * basename after either slash direction, last dot, lowercase, leading dot.
 * Throws Error for an empty filename, no dot, or an unsupported extension.
 */
export function inferType(filename) {
  if (!filename) throw new Error('filename is empty');
  const { ext } = filenameParts(filename);
  if (ext === null) throw new Error(`no extension in filename '${filename}'`);
  const info = EXTENSIONS[ext];
  if (!info) throw new Error(`unsupported extension '${ext}'`);
  return { fileType: info.fileType, extractionType: info.extractionType };
}

/** Byte-for-byte port of rules.py's empty-OCR image metadata stub. */
export function imageMetadataStub(filename, sizeBytes) {
  return `## Image metadata\n\n` +
    `- **Filename:** \`${filename}\`\n` +
    `- **Size:** ${sizeBytes} bytes\n` +
    `\n_No text was detected in this image (OCR found no readable text)._\n`;
}

/** Byte-for-byte port of rules.py's audio metadata stub. */
export function audioMetadataStub(filename, sizeBytes) {
  return `## Audio metadata\n\n` +
    `- **Filename:** \`${filename}\`\n` +
    `- **Size:** ${sizeBytes} bytes\n` +
    `\n_AnyDoc does not transcribe audio (transcription is not enabled in v1)._\n`;
}

// Python's \w is Unicode-aware; these explicit Unicode-class patterns keep
// the JS port faithful for non-ASCII text instead of using JS's ASCII-only \w.
const BULLET_RE = /^[·•●▪◦]\s*/;

function fixSpaces(text) {
  // "EditorialCoder" → "Editorial Coder" (lowercase→Capital+lower).
  // [A-Z][a-z] intentionally avoids splitting ALLCAPS like "YOUR".
  text = text.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');
  // "Location:Delhi" → "Location: Delhi".
  text = text.replace(/([:;,!?])([A-Za-z0-9])/g, '$1 $2');
  // "Coder&Data" → "Coder & Data". The two directions are separate in the
  // Python implementation and remain separate here.
  text = text.replace(/([\p{L}\p{N}_])&([A-Z])/gu, '$1 & $2');
  text = text.replace(/([a-z])&([\p{L}\p{N}_])/gu, '$1 & $2');
  // "3-6Years" → "3-6 Years" (but not "D3.js").
  text = text.replace(/(\d)([A-Z][a-z])/g, '$1 $2');
  // "SUBMITYoUR" → "SUBMIT YoUR".
  text = text.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  // Rejoin the common OCR case-confusion result.
  text = text.replace(/YoUR/g, 'YOUR');
  // Collapse multiple spaces.
  text = text.replace(/\s{2,}/g, ' ');
  return text.trim();
}

/**
 * Convert OCR line rows [{x, y, w, h, text, conf}] into structured Markdown.
 * This is a line-for-line port of ocr.py's _lines_to_markdown after the
 * RapidOCR box coordinates have been flattened into x/y/w/h rows.
 */
export function ocrLinesToMarkdown(lines) {
  if (!lines || lines.length === 0) return '';

  const items = lines.map((line) => ({
    y: line.y,
    x: line.x,
    h: line.h,
    w: line.w,
    text: String(line.text ?? ''),
    conf: line.conf,
  }));

  // Reading order: top-to-bottom, left-to-right. JS Array#sort is stable.
  items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const heights = items.map((item) => item.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];

  // Group lines into blocks: one heading, paragraph, or bullet (with its
  // continuation lines). The thresholds and ordering exactly mirror ocr.py.
  const blocks = [];
  for (const item of items) {
    if (blocks.length === 0) {
      blocks.push([item]);
      continue;
    }

    const current = blocks[blocks.length - 1];
    const last = current[current.length - 1];
    const first = current[0];
    const gap = item.y - (last.y + last.h);

    // Bullet character → always a new block.
    if (BULLET_RE.test(item.text)) {
      blocks.push([item]);
      continue;
    }

    // Multi-column: very different x at similar y → new block.
    const xDiff = Math.abs(item.x - last.x);
    const yOverlap = Math.abs(item.y - last.y);
    if (xDiff > medianH * 3 && yOverlap < medianH * 1.5) {
      blocks.push([item]);
      continue;
    }

    // Vertical gap > 0.8 × median height → paragraph break.
    if (gap > medianH * 0.8) {
      blocks.push([item]);
      continue;
    }

    // Indentation-aware splitting. For bullet blocks, a line at the bullet's
    // x is a new item whose bullet glyph OCR missed; a more-indented line is
    // a continuation. For other blocks, a less-indented line starts a block.
    const isBulletBlock = BULLET_RE.test(first.text);
    if (isBulletBlock) {
      if (Math.abs(item.x - first.x) <= 12) {
        blocks.push([item]);
        continue;
      }
    } else if (item.x < first.x - 12) {
      blocks.push([item]);
      continue;
    }

    current.push(item);
  }

  const markdownParts = [];
  for (const block of blocks) {
    const rawText = block.map((item) => item.text).join(' ');
    let text = fixSpaces(rawText);

    if (BULLET_RE.test(block[0].text)) {
      text = fixSpaces(rawText.replace(BULLET_RE, ''));
      markdownParts.push(`- ${text}`);
      continue;
    }

    const maxH = Math.max(...block.map((item) => item.h));
    if (maxH >= medianH * 3.0) {
      markdownParts.push(`# ${text}`);
      continue;
    }
    if (maxH >= medianH * 1.8) {
      markdownParts.push(`## ${text}`);
      continue;
    }

    if (block.length === 1 && text.endsWith(':')) {
      markdownParts.push(`### ${text.replace(/:+$/, '')}`);
      continue;
    }

    markdownParts.push(text);
  }

  return `${markdownParts.join('\n\n')}\n`;
}

/**
 * Conservative YAML-frontmatter parser. Only handles flat `key: value` pairs,
 * matching the implementation that used to live in api/import-url.js.
 */
export function parseFrontmatter(markdown) {
  if (typeof markdown !== 'string') return { frontmatter: null, body: markdown };
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: markdown };

  const raw = match[1];
  const body = markdown.slice(match[0].length);
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const matchLine = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!matchLine) continue;
    let value = matchLine[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[matchLine[1].trim().toLowerCase()] = value;
  }
  return { frontmatter, body };
}

/**
 * Best-effort title extraction: frontmatter title, first H1, source hostname,
 * then the source URL itself.
 */
export function extractTitle(markdown, frontmatter, sourceUrl) {
  if (frontmatter && frontmatter.title) return frontmatter.title;

  const bodyForH1 = typeof markdown === 'string' ? markdown : '';
  const h1 = bodyForH1.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1 && h1[1]) return h1[1].trim();

  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

export class ExtractError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ExtractError';
    this.status = status;
    this.code = code;
  }
}

function emptyFileError() {
  return new ExtractError(400, 'EMPTY_FILE', 'file is empty');
}

function payloadTooLargeError() {
  return new ExtractError(413, 'PAYLOAD_TOO_LARGE', `file exceeds ${MAX_BYTES} bytes`);
}

function unsupportedFileTypeError() {
  return new ExtractError(415, 'UNSUPPORTED_FILE_TYPE', 'unsupported file type');
}

function conversionFailedError() {
  return new ExtractError(500, 'CONVERT_FAILED', 'Conversion failed');
}

function normalizeBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input || []);
}

function isEngineError(error, code) {
  return Boolean(error) && typeof error === 'object' && error.code === code;
}

function mapConversionError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'encrypted') {
    return new ExtractError(422, 'ENCRYPTED', 'file is encrypted or password-protected');
  }
  if (code === 'needsOcr') {
    return new ExtractError(422, 'NEEDS_OCR', 'PDF contains scanned pages that require OCR');
  }
  // malformed, missingPart, resourceLimit, unsupported, unknown, and engine
  // exceptions are deliberately collapsed into a safe public 500.
  return conversionFailedError();
}

function resultPayload(markdown, typeInfo, filename, sizeBytes) {
  return {
    markdown,
    metadata: {
      extractionType: typeInfo.extractionType,
      filename,
      fileType: typeInfo.fileType,
      sizeBytes,
    },
  };
}

/**
 * Convert document bytes to Markdown using injected engines:
 *
 *   engines.anydoc: { formatFromExtension, toMarkdownBytes }
 *   engines.pdf:    { processPdf }
 *   engines.ocr:    async (bytes) => [{x,y,w,h,text,conf}]
 *
 * allowTypes, when present, is an array of canonical fileType values. It lets
 * non-browser API callers reject image/audio without changing the shared core.
 */
export async function convert({ bytes: inputBytes, filename, engines = {}, allowTypes }) {
  const bytes = normalizeBytes(inputBytes);
  if (bytes.byteLength <= 0) throw emptyFileError();
  if (bytes.byteLength > MAX_BYTES) throw payloadTooLargeError();

  let typeInfo;
  try {
    typeInfo = inferType(filename);
  } catch {
    throw unsupportedFileTypeError();
  }

  if (Array.isArray(allowTypes) && !allowTypes.includes(typeInfo.fileType)) {
    throw unsupportedFileTypeError();
  }

  const sizeBytes = bytes.byteLength;

  if (typeInfo.fileType === 'audio') {
    return resultPayload(audioMetadataStub(filename, sizeBytes), typeInfo, filename, sizeBytes);
  }

  if (typeInfo.fileType === 'image') {
    if (typeof engines.ocr !== 'function') throw unsupportedFileTypeError();
    let rows = [];
    try {
      rows = await engines.ocr(bytes);
    } catch {
      // Like the Python service, OCR failure falls back to the metadata stub
      // instead of surfacing OCR-engine internals.
      rows = [];
    }
    const markdown = ocrLinesToMarkdown(rows || []);
    const finalMarkdown = markdown && markdown.trim()
      ? markdown
      : imageMetadataStub(filename, sizeBytes);
    return resultPayload(finalMarkdown, typeInfo, filename, sizeBytes);
  }

  const anydoc = engines.anydoc;
  if (!anydoc || typeof anydoc.toMarkdownBytes !== 'function') {
    throw conversionFailedError();
  }

  try {
    if (typeInfo.fileType === 'pdf') {
      if (engines.pdf && typeof engines.pdf.processPdf === 'function') {
        try {
          const result = await engines.pdf.processPdf(bytes);
          // NOTE: pagesNeedingOcr is deliberately NOT enforced as a hard
          // rejection here. The detector flags scanned pages even in
          // documents the legacy service converted fine (corpus pdf-text.pdf
          // is Mixed with page 2 flagged, yet golden-locked as a full-200
          // conversion), so rejecting on any flagged page would regress
          // golden parity. Fully scanned/image-only PDFs yield no usable
          // markdown here and reach NEEDS_OCR through the AnyDoc fallback.
          if (result && typeof result.markdown === 'string' && result.markdown.trim()) {
            return resultPayload(result.markdown, typeInfo, filename, sizeBytes);
          }
        } catch {
          // pdf-inspector failure falls back to anydoc, as converter.py does.
        }
      }
      const markdown = await anydoc.toMarkdownBytes(bytes, 'pdf');
      return resultPayload(markdown, typeInfo, filename, sizeBytes);
    }

    if (typeof anydoc.formatFromExtension !== 'function') {
      throw conversionFailedError();
    }
    const { ext } = filenameParts(filename);
    const format = await anydoc.formatFromExtension(ext);
    if (format === null || typeof format === 'undefined') {
      throw unsupportedFileTypeError();
    }
    const markdown = await anydoc.toMarkdownBytes(bytes, format);
    return resultPayload(markdown, typeInfo, filename, sizeBytes);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    if (isEngineError(error, 'encrypted') || isEngineError(error, 'needsOcr')) {
      throw mapConversionError(error);
    }
    throw conversionFailedError();
  }
}
