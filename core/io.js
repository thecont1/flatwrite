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
 * Read the full request body as a string, enforcing a byte limit.
 * Destroys the stream on overflow to stop buffering.
 *
 * @param {IncomingMessage} req
 * @param {number} [maxBytes] - max bytes to buffer (default: Infinity)
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes) {
  const limit = maxBytes || Infinity;
  return new Promise((resolve, reject) => {
    let data = '';
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { readBody };
