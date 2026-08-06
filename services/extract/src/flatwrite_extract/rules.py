"""
flatwrite_extract.rules — deterministic per-type post-processing.

Zero model calls. AnyDoc already returns clean, well-structured
GitHub-Flavored Markdown. Images are converted via local OCR (RapidOCR);
when OCR finds text, it is passed through. When OCR finds no text (e.g. a
photograph), a metadata-only stub is emitted. Audio files always get a
metadata stub (no transcription in v1).
"""
from __future__ import annotations

from typing import Callable

RuleFn = Callable[[str], str]


def passthrough(md: str) -> str:
    """Identity rule — AnyDoc's output for document types is used as-is."""
    return md


def image_metadata(md: str, filename: str = "", size_bytes: int = 0) -> str:
    """Pass through OCR text for images, or emit a metadata stub.

    If `md` is non-empty, it contains OCR-extracted markdown from RapidOCR
    and is returned as-is. If `md` is empty (no text detected, or OCR
    failed), a metadata-only stub is emitted noting that no text was found.
    """
    if md and md.strip():
        return md
    return (
        f"## Image metadata\n\n"
        f"- **Filename:** `{filename}`\n"
        f"- **Size:** {size_bytes} bytes\n"
        f"\n_No text was detected in this image (OCR found no readable text)._\n"
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
