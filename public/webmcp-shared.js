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
/**
 * Canonical input fields shared across Docs render tools. Order here
 * is the order the manifest will emit them in (some agents are
 * order-sensitive in their UI).
 */
export const RENDER_INPUT_FIELDS = [
    { name: 'font', type: 'string', description: 'Font family — must be a bundled family. See ALLOWED_FONT_FAMILIES.' },
    { name: 'appFramework', type: 'string', description: 'UI framework (spectre, pico, oat, poshui, simple).' },
    {
        name: 'size',
        type: 'string',
        description: 'Font size as a scale token (e.g. "-1", "0", "1").',
        oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
            { type: 'number', description: 'Absolute pixel value (8..72)' },
        ],
    },
    {
        name: 'weight',
        type: 'string',
        description: 'Font weight as a scale token (e.g. "-1", "0").',
        oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0")' },
            { type: 'number', description: 'Absolute weight (100..900)' },
        ],
    },
    {
        name: 'line',
        type: 'string',
        description: 'Line height as a scale token (e.g. "-1", "0", "1").',
        oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
            { type: 'number', description: 'Absolute multiplier (0.8..4.0)' },
        ],
    },
    { name: 'uiZoom', type: 'number', description: 'UI zoom level (1.0 = default; >1 zooms in, <1 zooms out).' },
    { name: 'pageSize', type: 'string', description: 'Page size for paged output (A4, A3, Letter, Legal).' },
    { name: 'orientation', type: 'string', description: 'Page orientation.', enum: ['portrait', 'landscape'] },
    { name: 'marginsLR', type: 'string', description: 'Left/right page margins (narrow, normal, wide).' },
    { name: 'marginsTB', type: 'string', description: 'Top/bottom page margins (narrow, normal, wide).' },
    { name: 'footer', type: 'boolean', description: 'Include a page-number footer in paged output.' },
    { name: 'width', type: 'number', description: 'Content width in pixels (400..1400).' },
    { name: 'docEngine', type: 'string', description: 'Document engine ("none" or "paged").' },
    { name: 'surfaceMode', type: 'string', description: 'Surface mode ("doc" or "app").' },
    { name: 'theme', type: 'string', description: 'Theme identifier (e.g. "light", "dark").' },
];
export const RENDER_TOOLS_DOCS = [
    {
        name: 'render_markdown',
        description: 'Render raw markdown into FlatWrite-styled HTML head and body fragments. ' +
            'Same render pipeline as the editor (flatwrite.md) and the flatwrite-render MCP server. ' +
            'Returns { head, body }: head is CSS to inject, body is the document fragment.',
        surfaceMode: 'doc',
        inputFields: [
            // Tool-local primary payload (not a style option).
            { name: 'markdown', type: 'string', description: 'Raw markdown content to render.' },
            // Shared style fields, referenced by canonical name.
            ...RENDER_INPUT_FIELDS.map((f) => f.name),
        ],
        requiredFields: ['markdown'],
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {
                font: 'fontFamily',
                appFramework: 'framework',
                size: 'fontSize',
                weight: 'fontWeight',
                line: 'lineHeight',
            },
            outputHints: { head: 'head', body: 'body' },
        },
    },
    {
        name: 'render_markdown_from_url',
        description: 'Fetch markdown from an allowlisted URL (raw.githubusercontent.com, raw.gitlab.com, ' +
            'bitbucket.org) and render it into FlatWrite-styled HTML head and body fragments. ' +
            'Same render pipeline as the editor and the flatwrite-render MCP server.',
        surfaceMode: 'doc',
        inputFields: [
            // Tool-local primary payload.
            {
                name: 'markdownUrl',
                type: 'string',
                description: 'URL pointing to raw markdown content. Must be on an allowlisted host ' +
                    '(raw.githubusercontent.com, raw.gitlab.com, bitbucket.org).',
            },
            ...RENDER_INPUT_FIELDS.map((f) => f.name),
        ],
        requiredFields: ['markdownUrl'],
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {
                font: 'fontFamily',
                appFramework: 'framework',
                size: 'fontSize',
                weight: 'fontWeight',
                line: 'lineHeight',
            },
            outputHints: { head: 'head', body: 'body' },
        },
    },
];
export const REGISTERED_SURFACES = [
    { id: 'doc', status: 'ready', manifestFile: '.well-known/model-context.docs.json' },
    // Apps surface is registered as "preview" so clients can render a
    // "coming soon" affordance before the actual tools ship. The id is
    // 'app' (singular) to match the canonical surfaceMode enum used by
    // toCanonicalStyle and the renderer; the filename uses the plural
    // product name for the well-known namespace.
    { id: 'app', status: 'preview', manifestFile: '.well-known/model-context.apps.json' },
];
export const HANDLER_DOCS = {
    url: 'https://render.flatwrite.md/render',
    transport: 'http',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': '<server-to-server key — clients mint X-Mcp-Token instead>',
    },
    authNote: 'Browser clients mint a short-lived X-Mcp-Token from ' +
        'https://render.flatwrite.md/mcp-token first. Server-to-server clients ' +
        'may use X-Api-Key directly.',
};
/**
 * Streamable HTTP MCP handler for the Docs surface. Exposed at
 * https://mcp.flatwrite.md/mcp and fronts the same render Worker
 * that the HTTP handler fronts, so a tool call here produces
 * byte-identical output to a call via the HTTP handler. Preferred
 * by MCP-aware clients (Claude, Hermes, MCP Inspector).
 */
export const HANDLER_DOCS_MCP = {
    url: 'https://mcp.flatwrite.md/mcp',
    transport: 'streamable-http',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
    authNote: 'MCP Streamable HTTP transport. Server-to-server callers (no Origin ' +
        'header) can use X-Api-Key. Browser callers MUST mint a short-lived ' +
        'X-Mcp-Token from https://render.flatwrite.md/mcp-token first.',
};
export const HANDLER_APPS = {
    url: 'https://render.flatwrite.md/render?surface=app',
    transport: 'http',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    authNote: 'Apps surface not yet available. Reserved for future use.',
};
const MANIFEST_SCHEMA_URL = 'https://webmcp.org/schemas/model-context-v1.json';
const MANIFEST_VERSION = '1.0.0';
/** Look up an InputFieldSpec by canonical name. Throws on miss (catches typos at build time). */
function fieldByName(name) {
    const found = RENDER_INPUT_FIELDS.find((f) => f.name === name);
    if (!found) {
        throw new Error(`generateManifest: tool references unknown canonical field "${name}". ` +
            `Add it to RENDER_INPUT_FIELDS first.`);
    }
    return found;
}
/**
 * Build the JSON-Schema `properties` block for a tool. Each input
 * entry is either a canonical field name (looked up in
 * RENDER_INPUT_FIELDS) or an inline InputFieldSpec (tool-local). The
 * tool's explicitly-listed fields come first in order, then any
 * unlisted canonical fields are appended defensively so drift surfaces
 * in tests rather than silently dropping fields.
 */
function buildProperties(inputFields) {
    const out = {};
    const seen = new Set();
    for (const entry of inputFields) {
        const f = typeof entry === 'string' ? fieldByName(entry) : entry;
        out[f.name] = fieldToJsonSchema(f);
        seen.add(f.name);
    }
    for (const f of RENDER_INPUT_FIELDS) {
        if (!seen.has(f.name)) {
            out[f.name] = fieldToJsonSchema(f);
        }
    }
    return out;
}
function fieldToJsonSchema(f) {
    if (f.oneOf) {
        return {
            oneOf: f.oneOf.map((v) => ({ type: v.type, description: v.description })),
            description: f.description,
        };
    }
    const out = { type: f.type, description: f.description };
    if (f.enum)
        out.enum = f.enum;
    return out;
}
/**
 * Generate the manifest JSON for one surface. The output is a pure
 * data structure — the caller (build-manifest.mjs) writes it to disk.
 *
 * Throws if any tool references a canonical field that isn't in
 * RENDER_INPUT_FIELDS, or if a tool's requiredFields references a
 * field not in its inputFields. Both are build-time errors.
 *
 * `handlers` is an array; the first entry is treated as the
 * preferred/default by consumers. Pass at least one handler per
 * surface — empty handlers throws at build time.
 */
export function generateManifest(surface, tools, handlers, options = {}) {
    if (handlers.length === 0) {
        throw new Error(`generateManifest: surface "${surface}" has zero handlers. ` +
            `At minimum, register one HANDLER_<SURFACE> in mcpShared.ts.`);
    }
    const status = options.status ?? 'ready';
    const serverName = options.serverName ?? `FlatWrite Render — ${surface === 'doc' ? 'Docs' : 'Apps'}`;
    const manifestTools = tools.map((t) => {
        if (t.surfaceMode !== surface) {
            throw new Error(`generateManifest: tool "${t.name}" declares surfaceMode="${t.surfaceMode}" ` +
                `but is being included in the "${surface}" manifest. Fix the registration.`);
        }
        const properties = buildProperties(t.inputFields);
        for (const req of t.requiredFields) {
            if (!(req in properties)) {
                throw new Error(`generateManifest: tool "${t.name}" requires "${req}" but it's not in inputFields.`);
            }
        }
        return {
            name: t.name,
            description: t.description,
            inputSchema: {
                type: 'object',
                properties,
                required: t.requiredFields,
            },
            annotations: t.annotations,
            displayHints: t.displayHints,
        };
    });
    return {
        $schema: MANIFEST_SCHEMA_URL,
        name: serverName,
        version: MANIFEST_VERSION,
        surfaceMode: surface,
        status,
        handlers,
        tools: manifestTools,
    };
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