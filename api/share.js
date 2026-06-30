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

/* POST /api/share — create a new Dustebin paste and return its key */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const BASE = process.env.DUSTEBIN_BASE_URL;

  if (!BASE) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  let body = "";
  try {
    body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => { resolve(data); });
      req.on("error", (err) => { reject(err); });
    });
  } catch (e) {
    return res.status(400).json({ error: "Failed to read request body" });
  }

  if (!body) {
    return res.status(400).json({ error: "Empty content" });
  }

  try {
    const upstream = await fetch(BASE + "/api/pastes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: body,
        language: "markdown",
        expiration: "30d",
      }),
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream_error" });
    }

    const data = await upstream.json();
    if (!data || !data.id) {
      return res.status(502).json({ error: "upstream_error" });
    }

    return res.status(200).json({ key: data.id });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
