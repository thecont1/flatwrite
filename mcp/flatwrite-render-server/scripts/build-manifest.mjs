#!/usr/bin/env node
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

/**
 * Generate `.well-known/model-context.<surface>.json` manifests from
 * the canonical schema source in src/shared/mcpShared.ts.
 *
 * This runs after `tsc` (which compiles mcpShared.ts to
 * dist/shared/mcpShared.js) and emits one manifest file per registered
 * surface. The MCP server's build script also copies the compiled
 * shared module to public/webmcp-shared.js so the browser/Worker
 * scripts can import it.
 *
 * Adding a new surface or tool requires editing mcpShared.ts only —
 * this script does not need to change.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Atomic file write: write the payload to `<path>.tmp`, then rename
 * it over the destination. A crash mid-write leaves the previous
 * destination untouched (or no file if none existed) rather than a
 * half-written JSON blob. Best-effort cleanup of the temp file on
 * rename failure.
 */
function writeAtomic(path, contents) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, contents, "utf-8");
  try {
    renameSync(tmpPath, path);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DIST_SHARED = resolve(__dirname, "../dist/shared/mcpShared.js");
const DIST_RENDER_OUTPUT = resolve(__dirname, "../dist/shared/renderOutputSchema.js");
const PUBLIC_WELL_KNOWN = resolve(REPO_ROOT, "public/.well-known");

// ---------------------------------------------------------------------------
// Wrap the entire script body in a try/catch so any thrown error
// produces a single, consistent `build-manifest: <message>` line and
// a non-zero exit. Avoids ad-hoc `console.error + process.exit(1)`
// sprinkled through the script.
// ---------------------------------------------------------------------------
try {
  // -------------------------------------------------------------------------
  // Load the compiled shared module. Same artefact that gets copied to
  // public/webmcp-shared.js — keeping the load path identical to the
  // runtime consumer ensures the manifest and the runtime agree on
  // schema, allowlists, and tool descriptions.
  // -------------------------------------------------------------------------
  if (!existsSync(DIST_SHARED)) {
    throw new Error(
      `${DIST_SHARED} not found.\n` +
        "Run `bun run build` (which runs `tsc` first) before this script.\n" +
        "Missing module: mcpShared (the central tool/schema source).",
    );
  }

  // -------------------------------------------------------------------------
  // Load all the Zod output schemas and derive a JSON-Schema object for
  // each. Each schema is the single source of truth for its tool's
  // output — the server-side MCP tools import the Zod schema directly,
  // and the manifest gets the derived JSON-Schema injected at build
  // time.
  //
  // Each path is existence-checked before the dynamic import so a
  // missing dist file (e.g. an interrupted `bun run build`) produces
  // a clear "Run `bun run build` first" message that names which
  // schema is affected, instead of an opaque ERR_MODULE_NOT_FOUND.
  // -------------------------------------------------------------------------
  const SCHEMA_DIST_PATHS = {
    RenderOutputSchema: resolve(__dirname, "../dist/shared/renderOutputSchema.js"),
    RenderOptionsOutputSchema: resolve(__dirname, "../dist/shared/renderOptionsOutputSchema.js"),
    RenderPreviewOutputSchema: resolve(__dirname, "../dist/shared/renderPreviewOutputSchema.js"),
    ExportHtmlOutputSchema: resolve(__dirname, "../dist/shared/exportHtmlOutputSchema.js"),
    ExportPdfOutputSchema: resolve(__dirname, "../dist/shared/exportPdfOutputSchema.js"),
    ShareLinkOutputSchema: resolve(__dirname, "../dist/shared/shareLinkOutputSchema.js"),
  };
  for (const [name, path] of Object.entries(SCHEMA_DIST_PATHS)) {
    if (!existsSync(path)) {
      throw new Error(
        `${path} not found.\n` +
        "Run `bun run build` (which runs `tsc` first) before this script.\n" +
        `Missing schema: ${name}.`,
      );
    }
  }
  const { RenderOutputSchema } = await import(SCHEMA_DIST_PATHS.RenderOutputSchema);
  const { RenderOptionsOutputSchema } = await import(SCHEMA_DIST_PATHS.RenderOptionsOutputSchema);
  const { RenderPreviewOutputSchema } = await import(SCHEMA_DIST_PATHS.RenderPreviewOutputSchema);
  const { ExportHtmlOutputSchema } = await import(SCHEMA_DIST_PATHS.ExportHtmlOutputSchema);
  const { ExportPdfOutputSchema } = await import(SCHEMA_DIST_PATHS.ExportPdfOutputSchema);
  const { ShareLinkOutputSchema } = await import(SCHEMA_DIST_PATHS.ShareLinkOutputSchema);

  const sharedSrc = readFileSync(DIST_SHARED, "utf-8");

  // Strip ESM `export` keywords so we can evaluate the file as a script
  // and read its bindings via a captured object. Same trick the
  // webmcp.test.js bundler uses.
  const stripped = sharedSrc
    .replace(/export\s+const\s+/g, "const ")
    .replace(/export\s+async\s+function\s+/g, "async function ")
    .replace(/export\s+function\s+/g, "function ")
    .replace(/export\s+type\s+/g, "type ")
    .replace(/export\s+interface\s+/g, "interface ");

  const captured = {};
  // eslint-disable-next-line no-new-func
  new Function(
    "captured",
    `${stripped}\n;captured.SENTINEL_BY_TOOL_NAME=SENTINEL_BY_TOOL_NAME;captured.RENDER_TOOLS_DOCS=RENDER_TOOLS_DOCS;captured.RENDER_TOOLS_APPS=RENDER_TOOLS_APPS;captured.HANDLER_DOCS=HANDLER_DOCS;captured.HANDLER_DOCS_MCP=HANDLER_DOCS_MCP;captured.HANDLER_APPS=HANDLER_APPS;captured.REGISTERED_SURFACES=REGISTERED_SURFACES;captured.generateManifest=generateManifest;`,
  )(captured);

  const {
    SENTINEL_BY_TOOL_NAME,
    RENDER_TOOLS_DOCS,
    RENDER_TOOLS_APPS,
    HANDLER_DOCS,
    HANDLER_DOCS_MCP,
    HANDLER_APPS,
    REGISTERED_SURFACES,
    generateManifest,
  } = captured;

  if (!RENDER_TOOLS_DOCS || !RENDER_TOOLS_APPS || !REGISTERED_SURFACES || !generateManifest) {
    throw new Error(
      "shared module did not export expected symbols. " +
        "Did the export-strip regex miss something?",
    );
  }

  // -------------------------------------------------------------------------
  // Single source of truth for the tool-name → Zod-schema mapping.
  // Adding a new sentinel-migrated tool means one new entry here AND
  // a matching entry in mcpShared.ts's SENTINEL_BY_TOOL_NAME. The
  // post-loop assertion below catches drift at build time.
  // -------------------------------------------------------------------------
  const SCHEMAS_BY_TOOL_NAME = {
    render_markdown: RenderOutputSchema,
    list_render_options: RenderOptionsOutputSchema,
    render_markdown_preview: RenderPreviewOutputSchema,
    export_document_html: ExportHtmlOutputSchema,
    export_document_pdf: ExportPdfOutputSchema,
    create_share_link: ShareLinkOutputSchema,
  };

  const JSON_SCHEMA_BY_TOOL_NAME = Object.fromEntries(
    Object.entries(SCHEMAS_BY_TOOL_NAME).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema),
    ]),
  );

  // Inverse lookup: sentinel Symbol → JSON-Schema object. Built from
  // SENTINEL_BY_TOOL_NAME (the declared source of truth in mcpShared.ts)
  // so a missing entry fails here, at the lookup site, with a useful
  // message — rather than as a downstream sentinel-not-injected throw.
  const SENTINEL_TO_SCHEMA = new Map();
  for (const [toolName, sentinel] of Object.entries(SENTINEL_BY_TOOL_NAME)) {
    const jsonSchema = JSON_SCHEMA_BY_TOOL_NAME[toolName];
    if (jsonSchema === undefined) {
      throw new Error(
        `no Zod schema registered for tool "${toolName}" in SENTINEL_BY_TOOL_NAME. ` +
        `Add an entry to SCHEMAS_BY_TOOL_NAME in build-manifest.mjs.`,
      );
    }
    SENTINEL_TO_SCHEMA.set(sentinel, jsonSchema);
  }

  // Catch the reverse drift: an entry in SCHEMAS_BY_TOOL_NAME that no
  // tool declares (would silently never be injected).
  for (const toolName of Object.keys(JSON_SCHEMA_BY_TOOL_NAME)) {
    if (!(toolName in SENTINEL_BY_TOOL_NAME)) {
      throw new Error(
        `tool "${toolName}" is in SCHEMAS_BY_TOOL_NAME but missing from ` +
        `mcpShared.ts's SENTINEL_BY_TOOL_NAME. Either add the tool to ` +
        `RENDER_TOOLS_DOCS/RENDER_TOOLS_APPS or remove its schema.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Inject the derived JSON-Schema into tool specs marked with a
  // BuildTimeSentinel. We create shallow copies of the tools arrays
  // with the outputSchema replaced so the originals are not mutated.
  // -------------------------------------------------------------------------
  function injectSentinelSchemas(tools) {
    return tools.map((t) =>
      typeof t.outputSchema === "symbol"
        ? { ...t, outputSchema: SENTINEL_TO_SCHEMA.get(t.outputSchema) ?? undefined }
        : t,
    );
  }

  const TOOLS_BY_SURFACE = {
    doc: injectSentinelSchemas(RENDER_TOOLS_DOCS),
    app: injectSentinelSchemas(RENDER_TOOLS_APPS),
  };

  /**
   * Handlers per surface, in preferred-first order. The first entry
   * becomes the manifest's "default" handler; consumers should iterate
   * the array to discover alternatives. Adding a new transport for an
   * existing surface is a one-line edit here.
   */
  const HANDLERS_BY_SURFACE = {
    doc: [HANDLER_DOCS_MCP, HANDLER_DOCS].filter(Boolean),
    app: [HANDLER_APPS].filter(Boolean),
  };

  // -------------------------------------------------------------------------
  // Build every manifest in memory, validate in place, THEN write. A
  // drift regression (e.g. a sentinel that didn't resolve, or a tool
  // with an empty outputSchema) now leaves public/ untouched instead
  // of writing broken JSON files that the validator then rejects.
  //
  // The runtime-tools / version.json payload is derived from the same
  // already-validated manifests, so no separate runtime-module shape
  // check is needed.
  // -------------------------------------------------------------------------
  const builtManifests = [];
  const runtimeToolsBySurface = {};

  for (const surface of REGISTERED_SURFACES) {
    const tools = TOOLS_BY_SURFACE[surface.id] ?? [];
    const handlers = HANDLERS_BY_SURFACE[surface.id];
    if (!handlers || handlers.length === 0) {
      throw new Error(
        `no handlers registered for surface "${surface.id}". ` +
          `Add at least one HANDLER_${surface.id.toUpperCase()}* to mcpShared.ts.`,
      );
    }
    const manifest = generateManifest(surface.id, tools, handlers, {
      status: surface.status,
    });
    const missing = manifest.tools.filter(
      (t) => !t.outputSchema || Object.keys(t.outputSchema).length === 0,
    );
    if (missing.length > 0) {
      const names = missing.map((t) => t.name).join(", ");
      throw new Error(
        `Missing outputSchema on ${names} in ${surface.id} manifest (in-memory)`,
      );
    }
    builtManifests.push({ surface, manifest, relativePath: surface.manifestFile.replace(/^\.well-known\//, "") });
    runtimeToolsBySurface[surface.id] = manifest.tools;
  }

  // ---------------------------------------------------------------------------
  // Emit the runtime tool definitions module (public/webmcp-tools.js).
  // This is the single source of truth for tool metadata at runtime —
  // webmcp.js imports DOC_TOOLS and APP_TOOLS from here and only adds
  // execute handlers. Eliminates hand-sync between manifests and the
  // page-side registerTool() calls.
  //
  // A // @version header is written so maintainers can verify freshness
  // at a glance. public/version.json carries the same ID for tooling.
  // ---------------------------------------------------------------------------
  const BUILD_ID = process.env.BUILD_ID || String(Math.floor(Date.now() / 1000));
  const RUNTIME_TOOLS_PATH = resolve(REPO_ROOT, "public/webmcp-tools.js");
  const LICENSE_HEADER = `/**
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
`;

  const runtimeModule = `${LICENSE_HEADER}// Auto-generated from mcpShared.ts by build-manifest.mjs — do not edit.
// @version ${BUILD_ID}
// Tool definitions for WebMCP registerTool() calls. webmcp.js imports
// these and binds execute handlers to each tool by name.

export const DOC_TOOLS = ${JSON.stringify(runtimeToolsBySurface.doc ?? [], null, 2)};

export const APP_TOOLS = ${JSON.stringify(runtimeToolsBySurface.app ?? [], null, 2)};
`;

  // ---------------------------------------------------------------------------
  // Emit public/version.json — informational build ID for cache-bust
  // tooling. The ?v= strings in index.html remain the source of truth
  // for client-side cache busting; this file is for build verification.
  // ---------------------------------------------------------------------------
  const VERSION_PATH = resolve(REPO_ROOT, "public/version.json");
  const versionJson = JSON.stringify({ "webmcp-tools": BUILD_ID }, null, 2) + "\n";

  // -------------------------------------------------------------------------
  // All payloads are now valid in memory. mkdir + write atomically (per
  // file: write to *.tmp, then rename) so a mid-write crash leaves the
  // previous successful artifacts in place rather than half-written
  // JSON. mkdirSync(..., { recursive: true }) is a no-op if the
  // directory already exists.
  // -------------------------------------------------------------------------
  mkdirSync(PUBLIC_WELL_KNOWN, { recursive: true });
  for (const { surface, manifest, relativePath } of builtManifests) {
    const outPath = resolve(PUBLIC_WELL_KNOWN, relativePath);
    writeAtomic(outPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      `  wrote ${relative(REPO_ROOT, outPath)} (${manifest.tools.length} tool${
        manifest.tools.length === 1 ? "" : "s"
      }, status=${surface.status})`,
    );
  }
  writeAtomic(RUNTIME_TOOLS_PATH, runtimeModule);
  console.log(
    `  wrote ${relative(REPO_ROOT, RUNTIME_TOOLS_PATH)} (runtime tool definitions, @version ${BUILD_ID})`,
  );
  writeAtomic(VERSION_PATH, versionJson);
  console.log(`  wrote ${relative(REPO_ROOT, VERSION_PATH)}`);

  console.log(
    `\u2713 All tools have outputSchema (${builtManifests.length} surface${
      builtManifests.length === 1 ? "" : "s"
    } validated before write)`,
  );

  console.log(
    `build-manifest: ${builtManifests.length} manifest file${
      builtManifests.length === 1 ? "" : "s"
    } written + 1 runtime module.`,
  );
} catch (e) {
  console.error(`build-manifest: ${e.message}`);
  process.exit(1);
}