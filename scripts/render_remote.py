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

# scripts/render_remote.py
import httpx, yaml, pathlib, os, sys

RENDER_URL = "https://render.flatwrite.md"
API_KEY    = os.environ["FLATWRITE_API_KEY"]
CONTENT    = pathlib.Path("content")
DIST       = pathlib.Path("dist")

errors = []
for sidecar in CONTENT.glob("**/*.yaml"):
    cfg  = sidecar.read_text()
    resp = httpx.post(
        RENDER_URL,
        content=cfg,
        headers={"Content-Type": "text/yaml", "X-Api-Key": API_KEY},
        timeout=30,
    )
    if resp.status_code != 200:
        errors.append(f"{sidecar}: HTTP {resp.status_code} — {resp.text[:200]}")
        continue
    out = DIST / sidecar.relative_to(CONTENT).with_suffix(".html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(resp.text)
    print(f"✓ {sidecar} → {out}")

if errors:
    for e in errors: print(f"✗ {e}", file=sys.stderr)
    sys.exit(1)
