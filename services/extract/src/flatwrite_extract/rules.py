"""
flatwrite_extract.rules — deterministic per-type post-processing.

Zero model calls. Each rule is a pure function `(markdown: str) -> str` and
the dispatch table is keyed by `fileType`. The PPTX "notes only" rule is
intentionally defensive: if the expected Notes: marker pattern doesn't match
the actual MarkItDown output, we fall back to the full body. Tests must pin
the expected output shape against a real PPTX fixture.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Callable

RuleFn = Callable[[str], str]


# --------------------------------------------------------------------------
# Individual rules
# --------------------------------------------------------------------------

def passthrough(md: str) -> str:
    """Identity rule — used for word, excel, csv, json, xml, html, zip, epub."""
    return md


# MarkItDown's PPTX converter emits a slide like:
#
#     <!-- Slide number: 1 -->
#     # Slide Title
#
#     Some bullet text
#
#     ### Notes:
#     Speaker notes for the slide go here.
#
# Multiple slides are separated by HTML comments. We extract everything that
# appears under each `### Notes:` (or `Notes:`) header (until the next slide
# comment or EOF) and emit one section per slide.
#
# This pattern was verified against a real MarkItDown 0.1.6 PPTX fixture
# in test/extract/test_rules.py::test_powerpoint_extracts_notes.
_NOTES_SPLIT_RE = re.compile(
    r"<!--\s*Slide number:\s*\d+\s*-->",
    re.IGNORECASE,
)
# Match `### Notes:` (MarkItDown's actual output) or a bare `Notes:` line.
_NOTES_HEADER_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?Notes\s*:\s*$\s*",
    re.IGNORECASE | re.MULTILINE,
)


def _extract_pptx_notes(md: str) -> str:
    """Return one section per slide containing only the speaker notes.

    If a slide has no `Notes:` block, the full slide body is preserved as
    a fallback (this matches the plan's "fall back to full content if no
    notes found" requirement)."""
    if not md:
        return ""

    sections = _NOTES_SPLIT_RE.split(md)
    # The first element is anything before the first slide comment (often empty).
    if sections and not sections[0].strip():
        sections = sections[1:]

    out_chunks: list[str] = []
    for idx, section in enumerate(sections, start=1):
        if not section.strip():
            continue
        m = _NOTES_HEADER_RE.search(section)
        if not m:
            # No notes block — fall back to the full body.
            out_chunks.append(f"## Slide {idx}\n\n{section.strip()}\n")
            continue
        notes_text = section[m.end():].strip()
        if not notes_text:
            # Notes: header with no content — still mark the slide.
            out_chunks.append(f"## Slide {idx}\n\n_(no notes)_\n")
            continue
        out_chunks.append(f"## Slide {idx}\n\n{notes_text}\n")
    return "\n".join(out_chunks).rstrip() + "\n"


def powerpoint_notes(md: str) -> str:
    return _extract_pptx_notes(md)


# Heuristic for stripping PDF headers/footers. MarkItDown's PDF converter
# emits one Markdown line per source line, so we look at the literal text
# of each line. A line that appears 4 or more times in the document is
# almost certainly a page header or footer (e.g. the document title printed
# on every page). We drop them all.
_HEADER_FOOTER_MIN_REPEATS = 4


def pdf_strip_repeated_lines(md: str) -> str:
    if not md:
        return md
    lines = md.split("\n")
    counts = Counter(line.strip() for line in lines if line.strip())
    offenders = {
        line for line, n in counts.items() if n >= _HEADER_FOOTER_MIN_REPEATS
    }
    if not offenders:
        return md
    kept = [line for line in lines if line.strip() not in offenders]
    # Collapse runs of more than 2 blank lines that the removal created.
    cleaned: list[str] = []
    blank_run = 0
    for line in kept:
        if not line.strip():
            blank_run += 1
            if blank_run <= 2:
                cleaned.append(line)
        else:
            blank_run = 0
            cleaned.append(line)
    return "\n".join(cleaned).rstrip() + "\n"


# Image and audio are metadata-only — MarkItDown may still emit a short
# caption or empty body, so we collapse to a single metadata stub rather
# than passing the raw output through. The caller is expected to fetch
# richer metadata (EXIF etc.) at the API layer if needed; in v1 we just
# emit a stub so the user gets *something* to render.
def image_metadata(md: str, filename: str = "", size_bytes: int = 0) -> str:
    return (
        f"## Image metadata\n\n"
        f"- **Filename:** `{filename}`\n"
        f"- **Size:** {size_bytes} bytes\n"
        f"\n_MarkItDown returned {len(md)} chars of body text (none rendered — "
        f"OCR is not enabled in v1)._\n"
    )


def audio_metadata(md: str, filename: str = "", size_bytes: int = 0) -> str:
    return (
        f"## Audio metadata\n\n"
        f"- **Filename:** `{filename}`\n"
        f"- **Size:** {size_bytes} bytes\n"
        f"\n_MarkItDown returned {len(md)} chars of body text (none rendered — "
        f"transcription is not enabled in v1)._\n"
    )


# --------------------------------------------------------------------------
# Dispatch table
# --------------------------------------------------------------------------

# Plain identity rules by fileType.
_PASSTHROUGH_TYPES = {
    "word", "excel", "csv", "json", "xml", "html", "zip", "epub",
}

# Rules that need more than (md) — they take (md, filename, size_bytes).
_METADATA_TYPES = {"image", "audio"}


def apply_rules(file_type: str, markdown: str, *, filename: str = "", size_bytes: int = 0) -> str:
    """Dispatch to the per-type rule. Always returns a string."""
    if file_type in _PASSTHROUGH_TYPES:
        return passthrough(markdown)
    if file_type == "powerpoint":
        return powerpoint_notes(markdown)
    if file_type == "pdf":
        return pdf_strip_repeated_lines(markdown)
    if file_type in _METADATA_TYPES:
        if file_type == "image":
            return image_metadata(markdown, filename=filename, size_bytes=size_bytes)
        return audio_metadata(markdown, filename=filename, size_bytes=size_bytes)
    # Unknown type — defensive passthrough rather than raising, so the API
    # layer's 415 check (in validators.infer_type) remains the single gate.
    return passthrough(markdown)
