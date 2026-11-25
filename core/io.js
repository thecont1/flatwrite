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

// core/io.js — shared I/O helpers (no DOM deps)
'use strict';

/**
 * Read the full request body as a string, enforcing a byte limit on the
 * raw bytes before decoding.
 *
 * Bytes are accumulated and decoded once at end: decoding per chunk
 * corrupts multibyte UTF-8 sequences split across chunk boundaries on
 * native Node streams. String chunks (the Worker shim decodes statefully
 * upstream) are re-encoded — a lossless round-trip for valid UTF-8.
 *
 * On overflow we stop buffering and reject WITHOUT destroying the
 * request: destroying a native Node request tears down the socket
 * before the handler can send its JSON 413. The response closes the
 * connection instead; the remainder of the body is never buffered.
 *
 * @param {IncomingMessage} req
 * @param {number} [maxBytes] - max bytes to buffer (default: Infinity)
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes) {
  const limit = maxBytes || Infinity;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflowed = false;
    req.on('data', (chunk) => {
      if (overflowed) return;
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      total += bytes.length;
      if (total > limit) {
        overflowed = true;
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      const all = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
      }
      resolve(decoder.decode(all));
    });
    req.on('error', reject);
  });
}

module.exports = { readBody };
