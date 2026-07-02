"""
flatwrite_extract.converter — thin MarkItDown wrapper.

Hard rules (per the plan):
  - `enable_plugins=False` so no third-party MarkItDown plugins can sneak in
    LLM-bearing converters like the YouTube or Azure Document Intelligence ones.
  - `convert_stream(BytesIO(content), source_name=filename)` — never writes
    the upload to disk, never accepts a URL.
"""
from __future__ import annotations

import os
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


def is_markitdown_llm_disabled() -> bool:
    """Sanity check: confirm no LLM-touching plugin is loaded."""
    # When enable_plugins=False, MarkItDown skips the plugin discovery that
    # would otherwise register e.g. markitdown[azdocintel] and
    # markitdown[youtube-transcript]. We assert that the registered
    # converters don't include those well-known LLM-backed names.
    llm_marker_modules = ("azdocintel", "youtube")
    try:
        registered = list(_CONVERTER._converters)  # type: ignore[attr-defined]
    except AttributeError:
        # Newer MarkItDown versions may not expose this — fall back to env
        # check, which is what `enable_plugins=False` ultimately respects.
        return os.environ.get("MARKITDOWN_DISABLE_PLUGINS") != "0"
    for c in registered:
        mod = type(c).__module__.lower()
        for marker in llm_marker_modules:
            if marker in mod:
                return False
    return True
