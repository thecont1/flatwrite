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
