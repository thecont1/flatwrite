"""One-shot probe: run the sample PPTX through MarkItDown and dump output.

Used to verify the `<!-- Slide number: N -->` + `Notes:` hypothesis in
rules.py. Run with:
    uv run --directory services/extract python test/extract/probe_pptx.py
"""
from __future__ import annotations
import sys
from io import BytesIO
from pathlib import Path

from markitdown import MarkItDown

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sample.pptx"

md = MarkItDown(enable_plugins=False)
with open(FIXTURE, "rb") as f:
    result = md.convert_stream(BytesIO(f.read()), source_name="sample.pptx")
text = getattr(result, "markdown", result)
print("===BEGIN===")
print(text)
print("===END===")
print(f"len={len(text)}", file=sys.stderr)
