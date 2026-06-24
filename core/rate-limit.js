// core/rate-limit.js
'use strict';

/**
 * Sliding-window rate limiter (in-memory).
 *
 * Works in Node.js and CF Workers. Not persistent across cold starts —
 * acceptable because the HMAC auth already limits who can call the endpoint.
 * This prevents a compromised key from being used for DoS.
 *
 * @param {object} opts
 * @param {number} opts.windowMs  - sliding window size (default 60 000 = 1 min)
 * @param {number} opts.max       - max requests per window (default 60)
 */
function createRateLimiter(opts) {
  const windowMs = opts.windowMs || 60_000;
  const max      = opts.max      || 60;

  // Map<key, number[]> — key is caller identifier, value is array of timestamps (ms)
  const hits = new Map();

  // Periodic cleanup: evict keys whose newest hit is older than windowMs
  const cleanup = () => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      // timestamps are sorted ascending; check the last element
      if (timestamps[timestamps.length - 1] < cutoff) {
        hits.delete(key);
      }
    }
  };

  // Run cleanup every 2× window
  const cleanupInterval = setInterval(cleanup, windowMs * 2);
  // Allow Node.js to exit even if cleanup is pending
  if (cleanupInterval.unref) cleanupInterval.unref();

  /**
   * Check whether a request from `key` is allowed.
   * @param {string} key - caller identifier (e.g. IP address)
   * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
   */
  function check(key) {
    const now = Date.now();
    const cutoff = now - windowMs;

    if (!hits.has(key)) hits.set(key, []);

    const timestamps = hits.get(key);

    // Drop timestamps outside the window
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    const remaining = Math.max(0, max - timestamps.length);
    const oldest    = timestamps[0] || now;
    const resetMs   = oldest + windowMs - now;

    if (timestamps.length >= max) {
      return { allowed: false, remaining: 0, resetMs };
    }

    timestamps.push(now);
    return { allowed: true, remaining: remaining - 1, resetMs };
  }

  /** Expose for tests: clear all state */
  function reset() { hits.clear(); }

  return { check, reset, _size: () => hits.size };
}

module.exports = { createRateLimiter };
