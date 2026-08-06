"""
flatwrite_extract.rules — deterministic per-type post-processing.

Zero model calls. AnyDoc already returns clean, well-structured
GitHub-Flavored Markdown, so the only special-casing left is for binary
media (images and audio), where we emit a metadata-only stub because
AnyDoc does not support those formats.
"""
from __future__ import annotations

from typing import Callable

RuleFn = Callable[[str], str]


def passthrough(md: str) -> str:
    """Identity rule — AnyDoc's output for document types is used as-is."""
    return md


def image_metadata(md: str, filename: str = "", size_bytes: int = 0) -> str:
    """Emit a metadata stub for image files (no OCR in v1).

    Returns a Markdown section with the filename and byte size, noting
    that the body text was not rendered.
    """
    return (
        f"## Image metadata\n\n"
        f"- **Filename:** `{filename}`\n"
        f"- **Size:** {size_bytes} bytes\n"
        f"\n_AnyDoc does not extract text from images (OCR is not enabled in v1)._\n"
    )


def audio_metadata(md: str, filename: str = "", size_bytes: int = 0) -> str:
    """Emit a metadata stub for audio files (no transcription in v1).

    Returns a Markdown section with the filename and byte size, noting
    that the body text was not rendered.
    """
    return (
        f"## Audio metadata\n\n"
        f"- **Filename:** `{filename}`\n"
        f"- **Size:** {size_bytes} bytes\n"
        f"\n_AnyDoc does not transcribe audio (transcription is not enabled in v1)._\n"
    )


# Plain identity rules by fileType. AnyDoc handles Word, PowerPoint,
# Excel, OpenDocument, RTF, EPUB, CSV, and PDF in one pass.
_PASSTHROUGH_TYPES = {
    "pdf", "word", "powerpoint", "excel", "csv", "epub",
}

# Rules that need more than (md) — they take (md, filename, size_bytes).
_METADATA_TYPES = {"image", "audio"}


def apply_rules(file_type: str, markdown: str, *, filename: str = "", size_bytes: int = 0) -> str:
    """Dispatch to the per-type rule. Always returns a string."""
    if file_type in _PASSTHROUGH_TYPES:
        return passthrough(markdown)
    if file_type == "image":
        return image_metadata(markdown, filename=filename, size_bytes=size_bytes)
    if file_type == "audio":
        return audio_metadata(markdown, filename=filename, size_bytes=size_bytes)
    # Unknown type — defensive passthrough rather than raising, so the API
    # layer's 415 check (in validators.infer_type) remains the single gate.
    return passthrough(markdown)
