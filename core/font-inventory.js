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

'use strict';

/**
 * Single source of truth for FlatWrite's bundled fonts.
 *
 * Each entry describes one font family and one or more weight/style
 * variants. The `file` paths are relative to public/fonts/. The
 * inventory is consumed by:
 *
 *   - core/font-loader.js — embeds the woff2 as a data URI when the
 *     server-rendered output is built (the "render" path used by both
 *     the live editor preview and the public render.flatwrite.md API).
 *
 *   - scripts/build-fonts-css.mjs — writes public/fonts.css with the
 *     matching @font-face declarations, which the static index.html
 *     page loads via <link rel="stylesheet">. The browser preview uses
 *     these so the picker/saved YAML/preview all reference the same
 *     font inventory.
 *
 * Adding a new font = add a woff2 file under public/fonts/ + add an
 * entry here + (optionally) regenerate public/fonts.css. A regression
 * test (test/font-inventory.test.js) cross-checks this module, the
 * generated CSS, the file system, and core/font-loader.js so the
 * inventory can't drift silently.
 */

const FONT_INVENTORY = {
  Inter: [
    { file: 'inter-latin.woff2', weight: '100 900', style: 'normal' },
  ],
  'JetBrains Mono': [
    { file: 'jetbrains-mono-latin.woff2', weight: '100 800', style: 'normal' },
  ],
  Lato: [
    { file: 'lato-latin-300.woff2', weight: '300', style: 'normal' },
    { file: 'lato-latin-400.woff2', weight: '400', style: 'normal' },
    { file: 'lato-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  Lora: [
    { file: 'lora-latin.woff2', weight: '400 700', style: 'normal' },
  ],
  Merriweather: [
    { file: 'merriweather-latin.woff2', weight: '400 900', style: 'normal' },
  ],
  'Playfair Display': [
    { file: 'playfair-display-latin.woff2', weight: '400 900', style: 'normal' },
  ],
  Comfortaa: [
    { file: 'comfortaa-latin.woff2', weight: '300 700', style: 'normal' },
  ],
  Unbounded: [
    { file: 'unbounded-latin.woff2', weight: '200 900', style: 'normal' },
  ],
};

const UNICODE_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

module.exports = { FONT_INVENTORY, UNICODE_RANGE };