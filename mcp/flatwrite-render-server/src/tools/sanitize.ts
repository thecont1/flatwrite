/**
 * Error-detail sanitizer for the FlatWrite render MCP server.
 *
 * Upstream failures can surface strings that leak internal information:
 * file paths, stack frames, fetch error messages with hostnames/IPs, raw
 * HTML/JSON error pages with query tokens, exception messages from HTTP
 * libraries, etc. The MCP `tools/call` result is returned directly to the
 * LLM agent, so anything we forward ends up in the model's context.
 *
 * The sanitizer scrubs:
 *   - Bearer / Basic / ApiKey / Authorization-style tokens
 *   - Long hex / base64-looking blobs (likely keys or signatures)
 *   - URLs with query strings or fragments (often contain tokens/ids)
 *   - Stack-frame lines (`at <fn> (file:line:col)` and `Error: msg`)
 *   - Bare IP addresses (IPv4 dotted quads)
 *   - Local filesystem path segments
 *
 * It preserves:
 *   - The high-level reason (`fetch failed`, `ECONNREFUSED`, `404`)
 *   - A short human-readable summary capped at MAX_DETAIL_CHARS
 *   - Identifiable HTTP status codes
 */

const MAX_DETAIL_CHARS = 160;

const REDACTED = '[redacted]';

/** Run a single regex replacement and return the result. */
function redact(input: string, re: RegExp, replacement: string): string {
  return input.replace(re, replacement);
}

/**
 * Scrub a string so it can safely be returned to an MCP client.
 * Returns a sanitized summary; never throws.
 */
export function sanitizeDetail(input: unknown): string {
  if (input == null) return '';
  const raw = typeof input === 'string' ? input : String(input);
  if (!raw) return '';

  let s = raw;

  // 1. Authorization-style headers and inline secrets.
  s = redact(
    s,
    /\b(Bearer|Basic|ApiKey|X-Api-Key|Authorization|Token)\s+[A-Za-z0-9._\-+/=]+/gi,
    `$1 ${REDACTED}`,
  );

  // 2. Long hex blobs (≥32 hex chars) — covers API keys, HMAC sigs, IDs.
  s = redact(s, /\b[0-9a-f]{32,}\b/gi, REDACTED);

  // 3. Long base64-looking blobs (≥40 chars of base64 alphabet).
  s = redact(s, /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED);

  // 4. URLs with query strings or fragments — often carry tokens/ids.
  s = redact(s, /\bhttps?:\/\/[^\s)>'"]+[?#][^\s)>'"]+/gi, '[url]');

  // 5. Bare IPv4 addresses.
  s = redact(
    s,
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    '[ip]',
  );

  // 6. Node-style stack frames: "at fn (file:line:col)" or "at file:line:col".
  s = redact(s, /\s+at\s+[^\n]+:\d+:\d+/g, '');
  s = redact(s, /\s+at\s+[^\n]+\.(?:js|ts|mjs|cjs):\d+:\d+/g, '');

  // 7. "Error:" prefix lines — keep the message but drop the prefix noise.
  s = redact(s, /^[A-Za-z_][A-Za-z0-9_]*Error:\s*/gm, '');

  // 8. Local filesystem path segments (absolute /Users/, /home/, C:\, etc.).
  s = redact(s, /(?:\/Users\/|\/home\/|C:\\)[^\s'")\]]+/g, '[path]');
  s = redact(s, /(?:\.\/|\.\.\/)[^\s'")\]]+\.(?:js|ts|mjs|cjs|json)\b/g, '[path]');

  // 9. Collapse whitespace introduced by removals.
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // 10. Cap the final length.
  if (s.length > MAX_DETAIL_CHARS) {
    s = s.slice(0, MAX_DETAIL_CHARS).trimEnd() + '…';
  }

  return s;
}

/**
 * Sanitize a JSON error payload coming back from the upstream renderer.
 * Preserves `error`, `code`, and `retryAfter` (the public contract) but
 * scrubs `detail` (which can carry upstream noise).
 */
export function sanitizeRenderErrorPayload<T extends object>(
  payload: T,
): T {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const rawDetail = (payload as { detail: unknown }).detail;
    const cleanDetail = sanitizeDetail(rawDetail);
    return { ...payload, detail: cleanDetail || undefined };
  }
  return payload;
}