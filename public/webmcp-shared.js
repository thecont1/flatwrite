/// <reference lib="dom" />
/**
 * Shared MCP constants and helpers used by all FlatWrite render MCP
 * surfaces: the stdio/streamable HTTP server, the Cloudflare Worker,
 * and the WebMCP page-side script.
 *
 * Keeping a single source of truth for `toCanonicalStyle`, the font
 * allowlist, and the markdown URL allowlist prevents the browser-side
 * WebMCP tool and the server-side transports from drifting apart as
 * new options are added.
 */
/**
 * Font families that have bundled woff2 files. Mirrors
 * core/font-inventory.js. A build-time/regression test verifies this
 * stays in sync with the canonical font inventory.
 */
export const ALLOWED_FONT_FAMILIES = [
    'Inter',
    'JetBrains Mono',
    'Lato',
    'Lora',
    'Merriweather',
    'Playfair Display',
    'Comfortaa',
    'Unbounded',
];
/**
 * Hosts from which render_markdown_from_url may fetch raw markdown.
 */
export const ALLOWED_MARKDOWN_HOSTS = [
    'raw.githubusercontent.com',
    'raw.gitlab.com',
    'bitbucket.org',
];
/**
 * Translate the public RenderStyle (fontFamily / framework / fontSize / ...)
 * to the canonical FlatWrite render frontmatter (font / appFramework / size
 * / ...). Strings are scale tokens; numbers are absolute values.
 *
 * Mirrors the public-facing tool schemas in renderMarkdown.ts and
 * renderMarkdownFromUrl.ts, and the page-side WebMCP tool schema.
 */
export function toCanonicalStyle(publicStyle = {}) {
    const out = {};
    if (publicStyle == null)
        return out;
    if (publicStyle.fontFamily != null)
        out.font = String(publicStyle.fontFamily);
    if (publicStyle.framework != null)
        out.appFramework = String(publicStyle.framework);
    if (publicStyle.fontSize != null) {
        if (typeof publicStyle.fontSize === 'string')
            out.size = publicStyle.fontSize;
        else
            out.fontSize = publicStyle.fontSize;
    }
    if (publicStyle.fontWeight != null) {
        if (typeof publicStyle.fontWeight === 'string')
            out.weight = publicStyle.fontWeight;
        else
            out.fontWeight = publicStyle.fontWeight;
    }
    if (publicStyle.lineHeight != null) {
        if (typeof publicStyle.lineHeight === 'string')
            out.line = publicStyle.lineHeight;
        else
            out.lineHeight = publicStyle.lineHeight;
    }
    for (const k of [
        'docEngine', 'surfaceMode', 'pageSize', 'orientation',
        'marginsLR', 'marginsTB', 'footer', 'width', 'theme',
    ]) {
        if (publicStyle[k] != null)
            out[k] = publicStyle[k];
    }
    // uiZoom is editor-only for now; not forwarded.
    return out;
}
/**
 * Pre-flight check for render_markdown_from_url URLs. Only allowlisted
 * hosts and http(s) schemes are accepted.
 */
export function validateMarkdownUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        return { ok: false, code: 'INVALID_URL', message: 'url is not a valid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
            ok: false,
            code: 'UNSUPPORTED_SCHEME',
            message: `url must use http or https (got ${parsed.protocol})`,
        };
    }
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_MARKDOWN_HOSTS.includes(host)) {
        return {
            ok: false,
            code: 'DISALLOWED_HOST',
            message: `host '${host}' is not on the markdown URL allowlist`,
        };
    }
    return { ok: true, url: parsed.toString() };
}
/**
 * Pre-flight check for fontFamily. Only bundled fonts are accepted so the
 * caller gets an immediate structured error instead of a downstream render
 * that silently falls back to the system font.
 */
export function validateFontFamily(fontFamily) {
    if (fontFamily == null)
        return { ok: true };
    const name = String(fontFamily);
    if (ALLOWED_FONT_FAMILIES.includes(name))
        return { ok: true };
    return {
        ok: false,
        code: 'INVALID_FONT_FAMILY',
        message: `fontFamily '${name}' is not one of the bundled fonts (${ALLOWED_FONT_FAMILIES.join(', ')})`,
    };
}
/** Strip undefined fields so the wire payload stays clean. */
export function compact(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
        if (obj[k] !== undefined)
            out[k] = obj[k];
    }
    return out;
}
/**
 * Build the JSON body for a raw-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 */
export function buildRawMarkdownBody(markdown, publicStyle = {}) {
    return compact({ markdown, ...toCanonicalStyle(publicStyle) });
}
/**
 * Build the JSON body for a remote-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 */
export function buildRemoteMarkdownBody(markdownUrl, publicStyle = {}) {
    return compact({ markdownUrl, ...toCanonicalStyle(publicStyle) });
}
const MAX_DETAIL_CHARS = 160;
const REDACTED = '[redacted]';
/** Run a single regex replacement and return the result. */
function redact(input, re, replacement) {
    return input.replace(re, replacement);
}
/**
 * Scrub a string so it can safely be returned to an MCP client.
 * Returns a sanitized summary; never throws.
 */
export function sanitizeDetail(input) {
    if (input == null)
        return '';
    const raw = typeof input === 'string' ? input : String(input);
    if (!raw)
        return '';
    let s = raw;
    // 1. Authorization-style headers and inline secrets.
    s = redact(s, /\b(Bearer|Basic|ApiKey|X-Api-Key|Authorization|Token)\s+[A-Za-z0-9._\-+/=]+/gi, `$1 ${REDACTED}`);
    // 2. Long hex blobs (>=32 hex chars) — covers API keys, HMAC sigs, IDs.
    s = redact(s, /\b[0-9a-f]{32,}\b/gi, REDACTED);
    // 3. Long base64-looking blobs (>=40 chars of base64 alphabet).
    s = redact(s, /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED);
    // 4. URLs with query strings or fragments — often carry tokens/ids.
    s = redact(s, /\bhttps?:\/\/[^\s)>'"]+[?#][^\s)>'"]+/gi, '[url]');
    // 5. Bare IPv4 addresses.
    s = redact(s, /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, '[ip]');
    // 6. Node-style stack frames.
    s = redact(s, /\s+at\s+[^\n]+:\d+:\d+/g, '');
    s = redact(s, /\s+at\s+[^\n]+\.(?:js|ts|mjs|cjs):\d+:\d+/g, '');
    // 7. "Error:" prefix lines.
    s = redact(s, /^[A-Za-z_][A-Za-z0-9_]*Error:\s*/gm, '');
    // 8. Local filesystem path segments.
    s = redact(s, /(?:\/Users\/|\/home\/|C:\\\\)[^\s'")\]]+/g, '[path]');
    s = redact(s, /(?:\.\/|\.\.\/)[^\s'"\)\]]+\.(?:js|ts|mjs|cjs|json)\b/g, '[path]');
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
export function sanitizeRenderErrorPayload(payload) {
    if (payload && typeof payload === 'object' && 'detail' in payload) {
        const rawDetail = payload.detail;
        const cleanDetail = sanitizeDetail(rawDetail);
        return { ...payload, detail: cleanDetail || undefined };
    }
    return payload;
}
/* ── Token helpers ─────────────────────────────────────────────────────── */
/**
 * Constant-time string comparison. Prevents timing attacks on signature
 * or secret comparisons by always scanning every byte.
 */
export function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
export async function sign(secret, payload) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64url(input) {
    const bytes = new TextEncoder().encode(input);
    let bin = '';
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/**
 * Mint a short-lived token: base64url(exp).base64url(sig) where
 *   exp  = unix seconds at which the token expires
 *   sig  = hex(HMAC-SHA256(secret, exp + '.' + scope))
 */
export async function mintToken(secret, ttlSeconds, scope) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = await sign(secret, exp + '.' + scope);
    const expB64 = b64url(exp.toString());
    const sigB64 = b64url(sig);
    return { token: expB64 + '.' + sigB64, exp };
}
/**
 * Verify a token minted by mintToken(). Recomputes the expected HMAC and
 * compares it with constantTimeEqual() to avoid timing attacks.
 */
export async function verifyToken(secret, token, scope) {
    if (!token || typeof token !== 'string')
        return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 2)
        return { ok: false, reason: 'malformed' };
    const [expB64, sigB64] = parts;
    let expStr;
    try {
        expStr = atob(expB64.replace(/-/g, '+').replace(/_/g, '/'));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp))
        return { ok: false, reason: 'malformed' };
    if (exp <= Math.floor(Date.now() / 1000))
        return { ok: false, reason: 'expired' };
    let expectedSig;
    try {
        expectedSig = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    const actualSig = await sign(secret, expStr + '.' + scope);
    if (!constantTimeEqual(expectedSig, actualSig))
        return { ok: false, reason: 'bad_signature' };
    return { ok: true, exp };
}
//# sourceMappingURL=mcpShared.js.map