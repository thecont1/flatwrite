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
 * Single source of truth for the render tool output schema.
 *
 * Defined as Zod so the server-side MCP tools (renderMarkdown.ts,
 * renderMarkdownFromUrl.ts) get runtime validation and TypeScript types.
 * The build-manifest.mjs script derives a JSON-Schema object from this
 * at build time and injects it into the WebMCP manifest tool specs,
 * so the manifest and the server stay in sync without hand-mirroring.
 */

import { z } from 'zod';

export const RenderOutputSchema = z
  .object({
    ok: z.boolean().describe('True on successful render.'),
    kind: z.enum(['html']).describe('Result modality — always "html".'),
    document: z
      .object({
        title: z.string().optional().describe('Best-effort title from first H1 or filename.'),
        wordCount: z.number().optional().describe('Approximate word count of source markdown.'),
        charCount: z.number().optional().describe('Character count of source markdown.'),
      })
      .optional(),
    artifacts: z.object({
      head: z.string().describe('Self-contained <head> fragment.'),
      body: z.string().describe('Self-contained <body> fragment.'),
    }),
    warnings: z.array(z.string()).optional().describe('Non-fatal warnings.'),
  })
  .describe('Rendered markdown as self-contained HTML fragments with document metadata.');
