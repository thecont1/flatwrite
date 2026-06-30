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
 * Zod schema and builder for the `render_markdown_preview` tool's
 * success envelope. Mirrors the previously hand-written
 * RENDER_PREVIEW_OUTPUT_SCHEMA.
 *
 * Note: `kind` is the literal `"preview"`, NOT `"html"` like the
 * main render_markdown tool — these are distinct modalities even
 * though both render markdown.
 */

import { z } from 'zod';

export const RenderPreviewOutputSchema = z
  .object({
    ok: z.boolean().describe('Always true on success.'),
    kind: z.enum(['preview']).describe('Result modality — always "preview".'),
    documentId: z
      .string()
      .optional()
      .describe('Stable identifier for the previewed document.'),
    warnings: z
      .array(z.string())
      .optional()
      .describe('Non-fatal warnings.'),
  })
  .describe('Result of rendering markdown into the editor preview pane.');

export type RenderPreviewOutput = z.infer<typeof RenderPreviewOutputSchema>;

/**
 * Build a preview envelope. Pass optional documentId and warnings;
 * `kind` is hard-coded to `"preview"`.
 */
export function buildRenderPreviewOutput(
  args: {
    documentId?: string;
    warnings?: string[];
  } = {},
): RenderPreviewOutput {
  const envelope = {
    ok: true,
    kind: 'preview' as const,
    ...(args.documentId !== undefined ? { documentId: args.documentId } : {}),
    ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
  };
  return RenderPreviewOutputSchema.parse(envelope);
}