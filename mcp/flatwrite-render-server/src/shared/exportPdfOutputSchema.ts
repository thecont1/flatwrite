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
 * Zod schema for the `export_document_pdf` tool's success envelope.
 * Mirrors the previously hand-written EXPORT_PDF_OUTPUT_SCHEMA.
 *
 * `format` is the literal `"pdf"`. PDF export goes through the browser
 * print dialog, so `downloadUrl` is not used here — only `pageCount`
 * if known.
 */

import { z } from 'zod';

export const ExportPdfOutputSchema = z
  .object({
    ok: z.boolean().describe('Always true on success.'),
    documentId: z.string().describe('Stable identifier for the exported document.'),
    format: z.enum(['pdf']).describe('Export format — always "pdf".'),
    pageCount: z
      .number()
      .optional()
      .describe('Number of pages in the rendered output, if known.'),
    warnings: z
      .array(z.string())
      .optional()
      .describe('Non-fatal warnings.'),
  })
  .describe('Result of exporting the document as PDF (via browser print dialog).');

export type ExportPdfOutput = z.infer<typeof ExportPdfOutputSchema>;