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
 * Zod schema and builder for the `create_share_link` tool's success
 * envelope. Mirrors the previously hand-written SHARE_LINK_OUTPUT_SCHEMA.
 *
 * `expiresAt` is optional — callers may mint a non-expiring share
 * for short-lived demos, though production traffic uses a 30-day TTL.
 */

import { z } from 'zod';

export const ShareLinkOutputSchema = z
  .object({
    ok: z.boolean().describe('Always true on success.'),
    documentId: z.string().describe('Stable identifier for the shared document.'),
    shareUrl: z
      .string()
      .describe('Shareable URL that loads the document in the FlatWrite editor.'),
    expiresAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when the share link expires.'),
  })
  .describe('Result of creating a shareable URL for the document.');

export type ShareLinkOutput = z.infer<typeof ShareLinkOutputSchema>;

/**
 * Build a share-link envelope.
 */
export function buildShareLinkOutput(args: {
  documentId: string;
  shareUrl: string;
  expiresAt?: string;
}): ShareLinkOutput {
  const envelope = {
    ok: true,
    documentId: args.documentId,
    shareUrl: args.shareUrl,
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
  };
  return ShareLinkOutputSchema.parse(envelope);
}