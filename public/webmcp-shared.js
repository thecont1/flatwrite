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
 * Hosts from which the consolidated render_markdown tool may fetch raw markdown.
 */
export const ALLOWED_MARKDOWN_HOSTS = [
    'raw.githubusercontent.com',
    'raw.gitlab.com',
    'bitbucket.org',
];
/**
 * UI frameworks offered by the editor's "App surface" mode. Mirrors
 * the APP_FRAMEWORKS registry in public/app.js. When you add or
 * remove a framework there, mirror it here so the tool schema stays
 * accurate — callers see a hard validation error for unknown values
 * instead of a silent fallback.
 */
export const ALLOWED_APP_FRAMEWORKS = [
    'spectre',
    'poshui',
    'pico',
    'milligram',
    'chota',
];
/**
 * Document engines. Mirrors the DOC_ENGINES registry in public/app.js
 * (none / pagedjs / vivliostyle). The Worker / MCP layer historically
 * collapsed pagedjs+vivliostyle into a single "paged" bucket; today
 * callers can pick any of the three explicitly.
 */
export const ALLOWED_DOC_ENGINES = ['none', 'pagedjs', 'vivliostyle'];
/**
 * Surface modes. Today the render pipeline is identical between doc
 * and app; the difference is which downstream tooling consumes the
 * output. The "app" surfaceMode unlocks the appFramework picker.
 */
export const ALLOWED_SURFACE_MODES = ['doc', 'app'];
/**
 * Page sizes exposed by the editor's Page Size selector. Some of
 * these (A0/A1/A2) are rendered as letterboxed canvases in the
 * editor preview but still emit valid CSS @page rules.
 */
export const ALLOWED_PAGE_SIZES = [
    'A0',
    'A1',
    'A2',
    'A3',
    'A4',
    'A5',
    'Letter',
    'Legal',
];
/** Page orientations. */
export const ALLOWED_ORIENTATIONS = ['portrait', 'landscape'];
/** Page-margin presets. Mirrors the MARGIN_MAP in core/doc-engines.js. */
export const ALLOWED_MARGINS = ['narrow', 'normal', 'wide'];
/**
 * Shared error envelope. Every tool that can fail returns this shape
 * with `ok: false` instead of a success payload. Agents and graders
 * can branch on `ok` to determine whether to read `error` or the
 * tool-specific success fields.
 */
export const ERROR_SCHEMA = {
    type: 'object',
    title: 'ToolError',
    description: 'Typed error response returned when a tool fails.',
    required: ['ok', 'error'],
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', enum: [false], description: 'Always false for error responses.' },
        error: {
            type: 'object',
            description: 'Structured error details.',
            required: ['code', 'message'],
            additionalProperties: false,
            properties: {
                code: { type: 'string', description: 'Machine-readable error code (e.g. INVALID_MARKDOWN, DISALLOWED_HOST).' },
                message: { type: 'string', description: 'Human-readable error message.' },
                retryable: { type: 'boolean', description: 'Whether the agent should retry the call.' },
            },
        },
    },
};
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
 * Pre-flight check for markdownUrl values used by the consolidated
 * render_markdown tool. Only allowlisted hosts and http(s) schemes are accepted.
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
 *
 * Enum/range hints mirror the runtime allowlists (see the
 * ALLOWED_* constants above) so callers see a structured validation
 * error before round-tripping to the server. Keep these in sync with
 * public/app.js and core/* when those registries change.
 */
export const RENDER_INPUT_FIELDS = [
    {
        name: 'font',
        type: 'string',
        description: 'Font family — must be a bundled family.',
        enum: ALLOWED_FONT_FAMILIES,
    },
    {
        name: 'appFramework',
        type: 'string',
        description: 'UI framework applied when surfaceMode="app".',
        enum: ALLOWED_APP_FRAMEWORKS,
    },
    {
        name: 'size',
        type: 'string',
        description: 'Font size as a scale token (e.g. "-1", "0", "1").',
        oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
            { type: 'number', description: 'Absolute pixel value (8..72)' },
        ],
        minimum: 8,
        maximum: 72,
    },
    {
        name: 'weight',
        type: 'string',
        description: 'Font weight as a scale token (e.g. "-1", "0").',
        oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0")' },
            { type: 'number', description: 'Absolute weight (100..900, multiples of 100)' },
        ],
        minimum: 100,
        maximum: 900,
    },
    {
        name: 'line',
        type: 'string',
        description: 'Line height as a scale token (e.g. "-1", "0", "1").',
        oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
            { type: 'number', description: 'Absolute multiplier (0.8..4.0)' },
        ],
        minimum: 0.8,
        maximum: 4.0,
    },
    {
        name: 'uiZoom',
        type: 'number',
        description: 'UI zoom level (1.0 = default; >1 zooms in, <1 zooms out).',
        minimum: 0.25,
        maximum: 4.0,
    },
    {
        name: 'pageSize',
        type: 'string',
        description: 'Page size for paged output. Only effective when docEngine is pagedjs or vivliostyle.',
        enum: ALLOWED_PAGE_SIZES,
    },
    {
        name: 'orientation',
        type: 'string',
        description: 'Page orientation.',
        enum: ALLOWED_ORIENTATIONS,
    },
    {
        name: 'marginsLR',
        type: 'string',
        description: 'Left/right page margin preset. Only effective when docEngine is pagedjs or vivliostyle.',
        enum: ALLOWED_MARGINS,
    },
    {
        name: 'marginsTB',
        type: 'string',
        description: 'Top/bottom page margin preset. Only effective when docEngine is pagedjs or vivliostyle.',
        enum: ALLOWED_MARGINS,
    },
    {
        name: 'footer',
        type: 'boolean',
        description: 'Include a page-number footer in paged output.',
    },
    {
        name: 'width',
        type: 'number',
        description: 'Content width in pixels (400..1400). Only effective when docEngine="none".',
        minimum: 400,
        maximum: 1400,
    },
    {
        name: 'docEngine',
        type: 'string',
        description: 'Document engine — "none" emits plain CSS; "pagedjs"/"vivliostyle" wrap the output in @page rules.',
        enum: ALLOWED_DOC_ENGINES,
    },
    {
        name: 'surfaceMode',
        type: 'string',
        description: 'Surface mode hint. "app" unlocks the appFramework picker; otherwise this is metadata only.',
        enum: ALLOWED_SURFACE_MODES,
    },
    {
        name: 'theme',
        type: 'string',
        description: 'Theme identifier rendered as body[data-theme="..."] so consumer CSS can theme via attribute selectors. ' +
            'Free-form (alphanumeric, dash, underscore) — common values are "light" and "dark".',
    },
];
/**
 * Sentinel values for tools whose `outputSchema` will be injected by
 * `build-manifest.mjs` from a Zod schema at build time. Each sentinel
 * maps to one schema; the build script maintains a `SENTINEL → schema`
 * lookup table.
 *
 * Using typed markers instead of `undefined` makes the build-time
 * injection contract explicit and catches accidental omission at
 * TypeScript compile time.
 *
 * Symbols are primitives, so a single sentinel instance survives
 * `new Function()` eval boundaries — the build script captures the
 * same Symbol from the compiled module via export-stripping.
 */
export const INJECT_RENDER_OUTPUT = Symbol('INJECT_RENDER_OUTPUT');
export const INJECT_RENDER_OPTIONS_OUTPUT = Symbol('INJECT_RENDER_OPTIONS_OUTPUT');
export const INJECT_RENDER_PREVIEW_OUTPUT = Symbol('INJECT_RENDER_PREVIEW_OUTPUT');
export const INJECT_EXPORT_HTML_OUTPUT = Symbol('INJECT_EXPORT_HTML_OUTPUT');
export const INJECT_EXPORT_PDF_OUTPUT = Symbol('INJECT_EXPORT_PDF_OUTPUT');
export const INJECT_SHARE_LINK_OUTPUT = Symbol('INJECT_SHARE_LINK_OUTPUT');
/**
 * Per-tool lookup from canonical tool name to its outputSchema
 * sentinel. The build-manifest.mjs script mirrors this map (via the
 * compiled module) to resolve `t.outputSchema` sentinels to the
 * derived JSON-Schema objects.
 */
export const SENTINEL_BY_TOOL_NAME = {
    render_markdown: INJECT_RENDER_OUTPUT,
    render_markdown_preview: INJECT_RENDER_PREVIEW_OUTPUT,
    list_render_options: INJECT_RENDER_OPTIONS_OUTPUT,
    export_document_html: INJECT_EXPORT_HTML_OUTPUT,
    export_document_pdf: INJECT_EXPORT_PDF_OUTPUT,
    create_share_link: INJECT_SHARE_LINK_OUTPUT,
};
/* ── Lifecycle / export / share output schemas ─────────────────────────── */
/**
 * Output schemas for the lifecycle / export / share tools. The 5
 * tools whose schemas previously lived as hand-written constants
 * (render_options, render_preview, export_html, export_pdf,
 * share_link) are now derived from Zod schemas at build time via
 * `SENTINEL_BY_TOOL_NAME` — see the corresponding files in
 * `src/shared/<name>OutputSchema.ts`.
 *
 * The schemas that remain hand-written below are tools that have
 * not yet been migrated to the sentinel pattern.
 */
export const DOCUMENT_STATE_OUTPUT_SCHEMA = {
    type: 'object',
    title: 'DocumentStateOutput',
    description: 'Current state of the active document in the FlatWrite editor.',
    required: ['ok', 'documentId', 'title', 'wordCount', 'unsavedChanges', 'url'],
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', description: 'Always true on success.' },
        documentId: { type: 'string', description: 'Stable identifier for the active document.' },
        title: { type: 'string', description: 'Best-effort title from the first H1 or document URL.' },
        wordCount: { type: 'number', description: 'Approximate word count of the current markdown.' },
        charCount: { type: 'number', description: 'Character count of the current markdown.' },
        unsavedChanges: { type: 'boolean', description: 'Whether the editor content differs from the last loaded/saved state.' },
        renderMode: { type: 'string', enum: ['edit', 'preview', 'read'], description: 'Current editor mode.' },
        docEngine: { type: 'string', enum: [...ALLOWED_DOC_ENGINES], description: 'Active document engine.' },
        surfaceMode: { type: 'string', enum: [...ALLOWED_SURFACE_MODES], description: 'Active surface mode.' },
        url: { type: 'string', description: 'Canonical URL of the current document (share URL or source URL, empty if new).' },
        availableExports: { type: 'array', items: { type: 'string', enum: ['html', 'pdf', 'markdown'] }, description: 'Export formats available for the current document.' },
        canShare: { type: 'boolean', description: 'Whether the document is small enough to share via URL.' },
    },
};
export const CREATE_DOCUMENT_OUTPUT_SCHEMA = {
    type: 'object',
    title: 'CreateDocumentOutput',
    description: 'Result of creating a new document.',
    required: ['ok', 'documentId', 'title', 'url'],
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', description: 'Always true on success.' },
        documentId: { type: 'string', description: 'Stable identifier for the new document.' },
        title: { type: 'string', description: 'Title of the new document.' },
        url: { type: 'string', description: 'URL of the new document (empty for a blank document).' },
        nextSuggestedTool: { type: 'string', description: 'Suggested next tool to call (e.g. update_document_content).' },
    },
};
export const OPEN_DOCUMENT_OUTPUT_SCHEMA = {
    type: 'object',
    title: 'OpenDocumentOutput',
    description: 'Result of opening an existing document.',
    required: ['ok', 'documentId', 'title', 'url', 'active'],
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', description: 'Always true on success.' },
        documentId: { type: 'string', description: 'Stable identifier for the opened document.' },
        title: { type: 'string', description: 'Title of the opened document.' },
        url: { type: 'string', description: 'URL of the opened document.' },
        active: { type: 'boolean', description: 'Whether the document is now the active document in the editor.' },
        nextSuggestedTool: { type: 'string', description: 'Suggested next tool to call (e.g. get_document_state).' },
    },
};
export const UPDATE_DOCUMENT_OUTPUT_SCHEMA = {
    type: 'object',
    title: 'UpdateDocumentOutput',
    description: 'Result of updating document content.',
    required: ['ok', 'documentId', 'updatedAt', 'stateVersion'],
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', description: 'Always true on success.' },
        documentId: { type: 'string', description: 'Stable identifier for the updated document.' },
        updatedAt: { type: 'string', description: 'ISO 8601 timestamp of the update.' },
        stateVersion: { type: 'number', description: 'Monotonic revision number for optimistic concurrency.' },
        nextSuggestedTool: { type: 'string', description: 'Suggested next tool to call (e.g. render_markdown_preview).' },
    },
};
export const LIST_RECENT_OUTPUT_SCHEMA = {
    type: 'object',
    title: 'ListRecentDocumentsOutput',
    description: 'List of recently opened documents.',
    required: ['ok', 'documents'],
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', description: 'Always true on success.' },
        documents: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    documentId: { type: 'string', description: 'Stable identifier for the document.' },
                    title: { type: 'string', description: 'Best-effort title.' },
                    url: { type: 'string', description: 'Source URL or share URL.' },
                    updatedAt: { type: 'string', description: 'ISO 8601 timestamp of last modification.' },
                },
            },
            description: 'Recent documents, most recent first.',
        },
    },
};
export const RENDER_TOOLS_DOCS = [
    {
        name: 'render_markdown',
        description: 'Render markdown into FlatWrite-styled HTML <head> and <body> fragments, with optional ' +
            'typography and page-layout controls. Provide either the raw markdown inline (`markdown`) ' +
            'or an allowlisted URL (`markdownUrl`) pointing to raw markdown content. Use this when you ' +
            'need the rendered HTML artifacts; use render_markdown_preview when you want to see the ' +
            'result in the editor preview pane.',
        surfaceMode: 'doc',
        category: 'render',
        inputFields: [
            { name: 'markdown', type: 'string', description: 'Raw markdown content to render.' },
            {
                name: 'markdownUrl',
                type: 'string',
                description: 'URL pointing to raw markdown content. Must be on an allowlisted host ' +
                    '(raw.githubusercontent.com, raw.gitlab.com, bitbucket.org), http(s) only, ' +
                    'and <=1 MB. Host validation is enforced server-side.',
            },
            ...RENDER_INPUT_FIELDS.map((f) => f.name),
        ],
        requiredFields: [],
        requiredOneOf: [['markdown'], ['markdownUrl']],
        // outputSchema is injected by build-manifest.mjs from the Zod
        // RenderOutputSchema at build time, keeping a single source of truth.
        outputSchema: INJECT_RENDER_OUTPUT,
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {
                font: 'fontFamily',
                appFramework: 'framework',
                size: 'fontSize',
                weight: 'fontWeight',
                line: 'lineHeight',
            },
        },
    },
    {
        name: 'list_render_options',
        description: 'Return the supported fonts, UI frameworks, document engines, page sizes, orientations, ' +
            'margins, and surface modes for the render_markdown tool. Call this before rendering if ' +
            'you need to know which enum values are valid; call render_markdown when you have the ' +
            'options and are ready to render.',
        surfaceMode: 'doc',
        category: 'discovery',
        inputFields: [],
        requiredFields: [],
        outputSchema: INJECT_RENDER_OPTIONS_OUTPUT,
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'get_document_state',
        description: 'Return the current state of the active document in the FlatWrite editor: title, word count, ' +
            'render mode, unsaved changes flag, and available export formats. Use this before export or ' +
            'share tools to check readiness; use update_document_content to change the content.',
        surfaceMode: 'doc',
        category: 'lifecycle',
        inputFields: [],
        requiredFields: [],
        outputSchema: DOCUMENT_STATE_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'create_document',
        description: 'Create a new blank document in the FlatWrite editor, optionally with initial markdown content. ' +
            'Use this to start a new document; use open_document to load an existing one from a URL or ' +
            'share link.',
        surfaceMode: 'doc',
        category: 'lifecycle',
        inputFields: [
            { name: 'markdown', type: 'string', description: 'Optional initial markdown content for the new document.' },
            { name: 'title', type: 'string', description: 'Optional title for the new document.' },
        ],
        requiredFields: [],
        outputSchema: CREATE_DOCUMENT_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'open_document',
        description: 'Open an existing document from a URL or share link in the FlatWrite editor. Use this to load ' +
            'a remote markdown file or a previously shared document; use create_document to start blank.',
        surfaceMode: 'doc',
        category: 'lifecycle',
        inputFields: [
            { name: 'url', type: 'string', description: 'URL of the markdown file or FlatWrite share link to open.' },
        ],
        requiredFields: ['url'],
        outputSchema: OPEN_DOCUMENT_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'update_document_content',
        description: 'Update the markdown content of the active document in the FlatWrite editor. Use this to ' +
            'edit the document programmatically; use get_document_state to inspect the result.',
        surfaceMode: 'doc',
        category: 'lifecycle',
        inputFields: [
            { name: 'markdown', type: 'string', description: 'New markdown content for the document.' },
        ],
        requiredFields: ['markdown'],
        outputSchema: UPDATE_DOCUMENT_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'list_recent_documents',
        description: 'Return a list of recently opened documents from the editor session. Use this to discover ' +
            'what the user has been working on; use open_document to load one.',
        surfaceMode: 'doc',
        category: 'lifecycle',
        inputFields: [],
        requiredFields: [],
        outputSchema: LIST_RECENT_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'render_markdown_preview',
        description: 'Render markdown into the FlatWrite editor preview pane using the editor\'s current ' +
            'style and layout settings. Use this to see the rendered output in the editor; use ' +
            'render_markdown when you need the HTML artifacts without the preview.',
        surfaceMode: 'doc',
        category: 'render',
        inputFields: [
            { name: 'markdown', type: 'string', description: 'Optional markdown to preview. If omitted, previews the current editor content.' },
        ],
        requiredFields: [],
        outputSchema: INJECT_RENDER_PREVIEW_OUTPUT,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'export_document_html',
        description: 'Export the active document as a self-contained HTML file. The export opens in ' +
            'a new browser tab for human users. Completes synchronously. Use export_document_pdf ' +
            'for print-ready output.',
        surfaceMode: 'doc',
        category: 'export',
        inputFields: [],
        requiredFields: [],
        outputSchema: INJECT_EXPORT_HTML_OUTPUT,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'export_document_pdf',
        description: 'Export the active document as a PDF by triggering the browser print dialog with the rendered ' +
            'preview. Completes synchronously. The print dialog opens for human users. Use ' +
            'export_document_html for a downloadable HTML file.',
        surfaceMode: 'doc',
        category: 'export',
        inputFields: [],
        requiredFields: [],
        outputSchema: INJECT_EXPORT_PDF_OUTPUT,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
    {
        name: 'create_share_link',
        description: 'Create a shareable URL for the active document and copy it to the clipboard. Use this to ' +
            'share the document; the link expires after 30 days. Use get_document_state to check canShare ' +
            'before calling.',
        surfaceMode: 'doc',
        category: 'share',
        inputFields: [],
        requiredFields: [],
        outputSchema: INJECT_SHARE_LINK_OUTPUT,
        annotations: { readOnlyHint: false },
        displayHints: {
            inputFieldAliases: {},
        },
    },
];
export const RENDER_TOOLS_APPS = [
    {
        name: 'render_markdown',
        description: 'Render markdown into FlatWrite-styled HTML <head> and <body> fragments for the app surface. ' +
            'Provide either the raw markdown inline (`markdown`) or an allowlisted URL (`markdownUrl`). ' +
            'Use this when you need the rendered HTML artifacts for the app surface.',
        surfaceMode: 'app',
        category: 'render',
        inputFields: [
            { name: 'markdown', type: 'string', description: 'Raw markdown content to render.' },
            {
                name: 'markdownUrl',
                type: 'string',
                description: 'URL pointing to raw markdown content. Must be on an allowlisted host ' +
                    '(raw.githubusercontent.com, raw.gitlab.com, bitbucket.org), http(s) only, ' +
                    'and <=1 MB. Host validation is enforced server-side.',
            },
            ...RENDER_INPUT_FIELDS.map((f) => f.name),
        ],
        requiredFields: [],
        requiredOneOf: [['markdown'], ['markdownUrl']],
        // outputSchema is injected by build-manifest.mjs from the Zod
        // RenderOutputSchema at build time, keeping a single source of truth.
        outputSchema: INJECT_RENDER_OUTPUT,
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {
                font: 'fontFamily',
                appFramework: 'framework',
                size: 'fontSize',
                weight: 'fontWeight',
                line: 'lineHeight',
            },
        },
    },
    {
        name: 'list_render_options',
        description: 'Return the supported fonts, UI frameworks, document engines, page sizes, orientations, ' +
            'margins, and surface modes for the render_markdown tool. Call this before rendering if ' +
            'you need to know which enum values are valid.',
        surfaceMode: 'app',
        category: 'discovery',
        inputFields: [],
        requiredFields: [],
        outputSchema: INJECT_RENDER_OPTIONS_OUTPUT,
        annotations: { readOnlyHint: true },
        displayHints: {
            inputFieldAliases: {},
        },
    },
];
export const REGISTERED_SURFACES = [
    { id: 'doc', status: 'ready', manifestFile: '.well-known/model-context.docs.json' },
    // Apps surface is now ready and exposes the same consolidated render
    // tool, broadening the registered page coverage beyond the Docs page.
    { id: 'app', status: 'ready', manifestFile: '.well-known/model-context.apps.json' },
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
    authNote: 'Browser clients mint a short-lived X-Mcp-Token from https://render.flatwrite.md/mcp-token first. Server-to-server clients may use X-Api-Key directly.',
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
    return out;
}
function fieldToJsonSchema(f) {
    if (f.oneOf) {
        const out = {
            oneOf: f.oneOf.map((v) => ({ type: v.type, description: v.description })),
            description: f.description,
        };
        if (f.minimum !== undefined)
            out.minimum = f.minimum;
        if (f.maximum !== undefined)
            out.maximum = f.maximum;
        return out;
    }
    const out = { type: f.type, description: f.description };
    if (f.enum)
        out.enum = f.enum;
    if (f.examples)
        out.examples = f.examples;
    if (f.minimum !== undefined)
        out.minimum = f.minimum;
    if (f.maximum !== undefined)
        out.maximum = f.maximum;
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
        if (t.requiredOneOf) {
            for (const group of t.requiredOneOf) {
                for (const req of group) {
                    if (!(req in properties)) {
                        throw new Error(`generateManifest: tool "${t.name}" requiredOneOf group references "${req}" but it's not in inputFields.`);
                    }
                }
            }
        }
        const inputSchema = {
            type: 'object',
            properties,
            required: t.requiredFields,
        };
        if (t.requiredOneOf) {
            inputSchema.oneOf = t.requiredOneOf.map((group) => ({ required: group }));
        }
        const outputSchema = t.outputSchema && typeof t.outputSchema !== 'symbol'
            ? t.outputSchema
            : (() => {
                throw new Error(`generateManifest: tool "${t.name}" has a build-time outputSchema marker ` +
                    `(${String(t.outputSchema)}) that wasn't injected. ` +
                    `Check that build-manifest.mjs's injectSentinelSchemas() ran on this ` +
                    `tools array before generateManifest() was called.`);
            })();
        return {
            name: t.name,
            description: t.description,
            category: t.category,
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
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