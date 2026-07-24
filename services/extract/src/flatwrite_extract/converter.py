"""
flatwrite_extract.converter — thin MarkItDown wrapper.

Hard rules (per the plan):
  - `enable_plugins=False` so no third-party MarkItDown plugins can sneak in
    LLM-bearing converters like the YouTube or Azure Document Intelligence ones.
  - `convert_stream(BytesIO(content), source_name=filename)` — never writes
    the upload to disk, never accepts a URL.
"""
from __future__ import annotations

from io import BytesIO
from markitdown import MarkItDown

# Single instance per process is fine — MarkItDown's converters are stateless
# w.r.t. the data they convert.
_CONVERTER = MarkItDown(enable_plugins=False)


def convert_bytes(content: bytes, source_name: str) -> str:
    """Convert in-memory bytes to markdown text.

    Raises whatever MarkItDown raises on conversion failure (typically
    Exception subclasses with a `message` attribute or just bare Exception
    instances — callers should treat any exception as a 500).
    """
    if not content:
        raise ValueError("convert_bytes: content is empty")
    stream = BytesIO(content)
    # MarkItDown's convert_stream wants a stream and an optional source name
    # for extension inference. We pass the original filename so e.g. .pptx
    # dispatches to the PPTX converter even though our stream is in-memory.
    result = _CONVERTER.convert_stream(stream, source_name=source_name)
    # The result object exposes `.markdown` (str) on the modern API; older
    # versions may return a str directly. Handle both.
    md = getattr(result, "markdown", None)
    if md is None and isinstance(result, str):
        md = result
    if md is None:
        raise RuntimeError(
            f"MarkItDown returned unexpected type {type(result).__name__}"
        )
    return md
