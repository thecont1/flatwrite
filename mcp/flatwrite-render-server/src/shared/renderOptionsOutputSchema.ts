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
 * Zod schema for the `list_render_options` tool's success envelope.
 * Mirrors the previously hand-written RENDER_OPTIONS_OUTPUT_SCHEMA so
 * the manifest and any server-side caller stay in sync.
 *
 * The build-manifest.mjs script derives a JSON-Schema object from
 * `RenderOptionsOutputSchema` and injects it into the manifest at
 * build time, replacing the inline object. Keeping the schema here
 * lets us add fields and runtime validation in one place.
 */

import { z } from 'zod';

export const RenderOptionsOutputSchema = z
  .object({
    ok: z.boolean().describe('Always true for successful options listing.'),
    options: z
      .object({
        fonts: z.array(z.string()).describe('Bundled font families that can be passed as fontFamily.'),
        frameworks: z.array(z.string()).describe('UI frameworks that can be passed as framework when surfaceMode is "app".'),
        docEngines: z.array(z.string()).describe('Document engines that can be passed as docEngine.'),
        pageSizes: z.array(z.string()).describe('Page size presets that can be passed as pageSize.'),
        orientations: z.array(z.string()).describe('Page orientations that can be passed as orientation.'),
        margins: z.array(z.string()).describe('Page margin presets that can be passed as marginsLR or marginsTB.'),
        surfaceModes: z.array(z.string()).describe('Surface mode hints that can be passed as surfaceMode.'),
      })
      .describe('Supported enum values for each render option category.'),
    defaults: z
      .object({
        font: z.string().optional().describe('Default font family.'),
        docEngine: z.string().optional().describe('Default document engine.'),
        surfaceMode: z.string().optional().describe('Default surface mode.'),
        pageSize: z.string().optional().describe('Default page size.'),
        orientation: z.string().optional().describe('Default orientation.'),
      })
      .optional()
      .describe('Default values used when an option is omitted.'),
  })
  .describe('Supported values for the render_markdown tool, wrapped in a typed envelope.');

export type RenderOptionsOutput = z.infer<typeof RenderOptionsOutputSchema>;