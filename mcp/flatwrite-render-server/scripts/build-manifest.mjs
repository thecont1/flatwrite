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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DIST_SHARED = resolve(__dirname, "../dist/shared/mcpShared.js");
const DIST_RENDER_OUTPUT = resolve(__dirname, "../dist/shared/renderOutputSchema.js");
const PUBLIC_WELL_KNOWN = resolve(REPO_ROOT, "public/.well-known");

// ---------------------------------------------------------------------------
// Load the compiled shared module. Same artefact that gets copied to
// public/webmcp-shared.js — keeping the load path identical to the
// runtime consumer ensures the manifest and the runtime agree on
// schema, allowlists, and tool descriptions.
// ---------------------------------------------------------------------------

if (!existsSync(DIST_SHARED)) {
  console.error(
    `build-manifest: ${DIST_SHARED} not found.\n` +
      "Run `bun run build` (which runs `tsc` first) before this script.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the compiled Zod RenderOutputSchema and derive a JSON-Schema object
// from it. This is the single source of truth for the render tool output —
// the server-side MCP tools import the Zod schema directly, and the
// manifest gets the derived JSON-Schema injected at build time.
// ---------------------------------------------------------------------------
const { RenderOutputSchema } = await import(DIST_RENDER_OUTPUT);
const renderOutputJsonSchema = z.toJSONSchema(RenderOutputSchema);

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
  `${stripped}\n;captured.RENDER_TOOLS_DOCS=RENDER_TOOLS_DOCS;captured.RENDER_TOOLS_APPS=RENDER_TOOLS_APPS;captured.HANDLER_DOCS=HANDLER_DOCS;captured.HANDLER_DOCS_MCP=HANDLER_DOCS_MCP;captured.HANDLER_APPS=HANDLER_APPS;captured.REGISTERED_SURFACES=REGISTERED_SURFACES;captured.generateManifest=generateManifest;`,
)(captured);

const {
  RENDER_TOOLS_DOCS,
  RENDER_TOOLS_APPS,
  HANDLER_DOCS,
  HANDLER_DOCS_MCP,
  HANDLER_APPS,
  REGISTERED_SURFACES,
  generateManifest,
} = captured;

if (!RENDER_TOOLS_DOCS || !RENDER_TOOLS_APPS || !REGISTERED_SURFACES || !generateManifest) {
  console.error(
    "build-manifest: shared module did not export expected symbols. " +
      "Did the export-strip regex miss something?",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inject the derived JSON-Schema into render tool specs marked with the
// INJECT_RENDER_OUTPUT sentinel. We create shallow copies of the tools
// arrays with the outputSchema replaced so the originals are not mutated.
// ---------------------------------------------------------------------------
function injectRenderOutputSchema(tools) {
  return tools.map((t) =>
    typeof t.outputSchema === "symbol" && t.name.startsWith("render_")
      ? { ...t, outputSchema: renderOutputJsonSchema }
      : t,
  );
}

const TOOLS_BY_SURFACE = {
  doc: injectRenderOutputSchema(RENDER_TOOLS_DOCS),
  app: injectRenderOutputSchema(RENDER_TOOLS_APPS),
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

mkdirSync(PUBLIC_WELL_KNOWN, { recursive: true });

let written = 0;
const runtimeToolsBySurface = {};

for (const surface of REGISTERED_SURFACES) {
  const tools = TOOLS_BY_SURFACE[surface.id] ?? [];
  const handlers = HANDLERS_BY_SURFACE[surface.id];
  if (!handlers || handlers.length === 0) {
    console.error(
      `build-manifest: no handlers registered for surface "${surface.id}". ` +
        `Add at least one HANDLER_${surface.id.toUpperCase()}* to mcpShared.ts.`,
    );
    process.exit(1);
  }
  const manifest = generateManifest(surface.id, tools, handlers, {
    status: surface.status,
  });
  // manifestFile is `.well-known/model-context.<surface>.json`; strip
  // the leading `.well-known/` to get the path under PUBLIC_WELL_KNOWN.
  const relativePath = surface.manifestFile.replace(/^\.well-known\//, "");
  const outPath = resolve(PUBLIC_WELL_KNOWN, relativePath);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(
    `  wrote ${relative(REPO_ROOT, outPath)} (${tools.length} tool${
      tools.length === 1 ? "" : "s"
    }, status=${surface.status})`,
  );
  written++;

  // Collect the manifest's tool definitions (without execute handlers)
  // for the runtime module. webmcp.js imports this and binds execute
  // handlers to each tool by name.
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
writeFileSync(RUNTIME_TOOLS_PATH, runtimeModule, "utf-8");
console.log(
  `  wrote ${relative(REPO_ROOT, RUNTIME_TOOLS_PATH)} (runtime tool definitions, @version ${BUILD_ID})`,
);

// ---------------------------------------------------------------------------
// Emit public/version.json — informational build ID for cache-bust
// tooling. The ?v= strings in index.html remain the source of truth
// for client-side cache busting; this file is for build verification.
// ---------------------------------------------------------------------------
const VERSION_PATH = resolve(REPO_ROOT, "public/version.json");
writeFileSync(
  VERSION_PATH,
  JSON.stringify({ "webmcp-tools": BUILD_ID }, null, 2) + "\n",
  "utf-8",
);
console.log(`  wrote ${relative(REPO_ROOT, VERSION_PATH)}`);

// ---------------------------------------------------------------------------
// Post-build validation: verify every render tool has a non-empty
// outputSchema in both generated manifests.
// ---------------------------------------------------------------------------
function validateRenderOutputSchemas(manifestPath, surfaceName) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const renderTools = manifest.tools.filter((t) => t.name.startsWith("render_"));
  const missing = renderTools.filter(
    (t) => !t.outputSchema || Object.keys(t.outputSchema).length === 0,
  );
  if (missing.length > 0) {
    const names = missing.map((t) => t.name).join(", ");
    throw new Error(
      `Missing outputSchema on ${names} in ${surfaceName} manifest (${relative(REPO_ROOT, manifestPath)})`,
    );
  }
}

validateRenderOutputSchemas(
  resolve(PUBLIC_WELL_KNOWN, "model-context.docs.json"),
  "docs",
);
validateRenderOutputSchemas(
  resolve(PUBLIC_WELL_KNOWN, "model-context.apps.json"),
  "apps",
);
console.log("\u2713 All render tools have outputSchema (docs + apps)");

console.log(
  `build-manifest: ${written} manifest file${written === 1 ? "" : "s"} written + 1 runtime module.`,
);