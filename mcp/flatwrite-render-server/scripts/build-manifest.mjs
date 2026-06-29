#!/usr/bin/env node
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DIST_SHARED = resolve(__dirname, "../dist/shared/mcpShared.js");
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
      "Run `npm run build` (which runs `tsc` first) before this script.",
  );
  process.exit(1);
}

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
  `${stripped}\n;captured.RENDER_TOOLS_DOCS=RENDER_TOOLS_DOCS;captured.HANDLER_DOCS=HANDLER_DOCS;captured.HANDLER_DOCS_MCP=HANDLER_DOCS_MCP;captured.HANDLER_APPS=HANDLER_APPS;captured.REGISTERED_SURFACES=REGISTERED_SURFACES;captured.generateManifest=generateManifest;`,
)(captured);

const {
  RENDER_TOOLS_DOCS,
  HANDLER_DOCS,
  HANDLER_DOCS_MCP,
  HANDLER_APPS,
  REGISTERED_SURFACES,
  generateManifest,
} = captured;

if (!RENDER_TOOLS_DOCS || !REGISTERED_SURFACES || !generateManifest) {
  console.error(
    "build-manifest: shared module did not export expected symbols. " +
      "Did the export-strip regex miss something?",
  );
  process.exit(1);
}

const TOOLS_BY_SURFACE = {
  doc: RENDER_TOOLS_DOCS,
  // Apps surface has no tools yet. When Apps ships, add `app: RENDER_TOOLS_APPS`.
  app: [],
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
}

console.log(
  `build-manifest: ${written} manifest file${written === 1 ? "" : "s"} written.`,
);