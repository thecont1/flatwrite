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
 * Zod schema for the `export_document_html` tool's success envelope.
 * Mirrors the previously hand-written EXPORT_HTML_OUTPUT_SCHEMA.
 *
 * `format` is the literal `"html"`. `downloadUrl` is the temporary
 * blob URL created by the browser-side export handler.
 */

import { z } from 'zod';

export const ExportHtmlOutputSchema = z
  .object({
    ok: z.boolean().describe('Always true on success.'),
    documentId: z.string().describe('Stable identifier for the exported document.'),
    format: z.enum(['html']).describe('Export format — always "html".'),
    downloadUrl: z
      .string()
      .optional()
      .describe('Blob URL of the exported HTML (temporary, valid for the session).'),
    warnings: z
      .array(z.string())
      .optional()
      .describe('Non-fatal warnings.'),
  })
  .describe('Result of exporting the document as HTML.');

export type ExportHtmlOutput = z.infer<typeof ExportHtmlOutputSchema>;