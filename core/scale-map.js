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

// core/scale-map.js
// Scale indices → absolute CSS values, shared between the FlatWrite UI and the API.

'use strict';

const SIZE_SCALE = {
  '-5': 0.62,
  '-4': 0.68,
  '-3': 0.76,
  '-2': 0.84,
  '-1': 0.92,
  '0': 1,
  '1': 1.1,
  '2': 1.2,
  '3': 1.32,
  '4': 1.46,
  '5': 1.62,
  '6': 1.8,
};
const SIZE_MIN = -5;
const SIZE_MAX = 6;

const WEIGHT_MAP = {
  '-3': 100,
  '-2': 200,
  '-1': 300,
  '0': 400,
  '1': 600,
  '2': 700,
};
const WEIGHT_MIN = -3;
const WEIGHT_MAX = 2;

const LINE_SCALE = {
  '-2': 1.3,
  '-1': 1.5,
  '0': 1.75,
  '1': 2.0,
  '2': 2.3,
  '3': 2.6,
};
const LINE_MIN = -2;
const LINE_MAX = 3;

const BASE_FONT_SIZE = 15;

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function resolveSize(step) {
  return SIZE_SCALE[String(clampInt(step, SIZE_MIN, SIZE_MAX, 0))] || 1;
}

function resolveWeight(step) {
  return WEIGHT_MAP[String(clampInt(step, WEIGHT_MIN, WEIGHT_MAX, 0))] || 400;
}

function resolveLine(step) {
  return LINE_SCALE[String(clampInt(step, LINE_MIN, LINE_MAX, 0))] || 1.75;
}

function absoluteFontSize(step) {
  return Math.round(BASE_FONT_SIZE * resolveSize(step));
}

function absoluteFontWeight(step) {
  return resolveWeight(step);
}

function absoluteLineHeight(step) {
  return resolveLine(step);
}

module.exports = {
  SIZE_SCALE,
  WEIGHT_MAP,
  LINE_SCALE,
  SIZE_MIN,
  SIZE_MAX,
  WEIGHT_MIN,
  WEIGHT_MAX,
  LINE_MIN,
  LINE_MAX,
  BASE_FONT_SIZE,
  clampInt,
  resolveSize,
  resolveWeight,
  resolveLine,
  absoluteFontSize,
  absoluteFontWeight,
  absoluteLineHeight,
};
