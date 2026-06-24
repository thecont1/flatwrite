// core/auth.js
'use strict';
const crypto = require('crypto');

const MAX_AGE_SECONDS = 300; // 5-minute replay window

/**
 * Compute HMAC-SHA256 signature for a request.
 * Payload: timestamp.method.path
 * @param {string} secret - shared secret key
 * @param {number} timestamp - unix seconds
 * @param {string} method - HTTP method (POST, GET, etc.)
 * @param {string} path - request path (/api/render)
 * @returns {string} hex-encoded HMAC signature
 */
function sign(secret, timestamp, method, path) {
  const payload = timestamp + '.' + method + '.' + path;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify a request signature with constant-time comparison.
 * @param {string} secret - shared secret key
 * @param {string} method - HTTP method
 * @param {string} path - request path
 * @param {string} timestampHeader - X-Render-Timestamp header value
 * @param {string} signatureHeader - X-Render-Signature header value
 * @returns {{ ok: boolean, error?: string }}
 */
function verify(secret, method, path, timestampHeader, signatureHeader) {
  if (!timestampHeader || !signatureHeader) {
    return { ok: false, error: 'Missing signature headers' };
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: 'Invalid timestamp' };
  }

  // Replay protection: reject requests older than MAX_AGE_SECONDS
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_AGE_SECONDS) {
    return { ok: false, error: 'Request expired' };
  }

  // Recompute expected signature
  const expected = sign(secret, timestamp, method, path);

  // Constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHeader, 'hex');
    if (a.length !== b.length) return { ok: false, error: 'Invalid signature' };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, error: 'Invalid signature' };
  } catch {
    return { ok: false, error: 'Invalid signature' };
  }

  return { ok: true };
}

module.exports = { sign, verify, MAX_AGE_SECONDS };
