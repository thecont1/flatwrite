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

// api/import-url.js — retired endpoint
//
// Server-side conversion used to live behind this route. Import-from-URL is
// now split into /api/fetch-document (server fetches raw bytes with SSRF
// guards) plus browser-local conversion. The route remains only to give old
// clients an explicit, machine-readable retirement response.
'use strict';

module.exports = async function handleImportUrl(req, res) {
  res.statusCode = 410;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: false,
    code: 'ENDPOINT_RETIRED',
    error: 'Use /api/fetch-document — conversion now runs in the browser',
  }));
};
