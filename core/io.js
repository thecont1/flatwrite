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
