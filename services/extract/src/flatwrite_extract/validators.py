"""
flatwrite_extract.validators — extension allowlist and file-type inference.

Single source of truth for the set of file types FlatWrite can convert.
Anything not in the allowlist is rejected with HTTP 415 by the API layer.
"""
from __future__ import annotations

from dataclasses import dataclass

# extension (lowercase, including the leading dot) -> (fileType, extractionType)
ALLOWED_EXTENSIONS: dict[str, tuple[str, str]] = {
    ".pdf":  ("pdf",     "pdf-body"),
    ".pptx": ("powerpoint", "powerpoint-notes"),
    ".docx": ("word",    "word-body"),
    ".xlsx": ("excel",   "excel-tables"),
    ".xls":  ("excel",   "excel-tables"),
    ".csv":  ("csv",     "structured-data"),
    ".json": ("json",    "structured-data"),
    ".xml":  ("xml",     "structured-data"),
    ".zip":  ("zip",     "zip-contents"),
    ".epub": ("epub",    "epub-body"),
    ".html": ("html",    "html-body"),
    ".htm":  ("html",    "html-body"),
    # Image and audio types get metadata-only treatment (no OCR / no transcription
    # in v1 — we honor the no-LLM-calls constraint from the plan).
    ".png":  ("image",   "image-metadata"),
    ".jpg":  ("image",   "image-metadata"),
    ".jpeg": ("image",   "image-metadata"),
    ".gif":  ("image",   "image-metadata"),
    ".webp": ("image",   "image-metadata"),
    ".tiff": ("image",   "image-metadata"),
    ".tif":  ("image",   "image-metadata"),
    ".mp3":  ("audio",   "audio-metadata"),
    ".wav":  ("audio",   "audio-metadata"),
    ".m4a":  ("audio",   "audio-metadata"),
    ".ogg":  ("audio",   "audio-metadata"),
    ".flac": ("audio",   "audio-metadata"),
}

# Max upload size — 25 MB per the plan.
MAX_BYTES: int = 25 * 1024 * 1024


@dataclass(frozen=True)
class FileTypeInfo:
    file_type: str        # canonical fileType token
    extraction_type: str  # canonical extractionType token


def infer_type(filename: str) -> FileTypeInfo:
    """Map `filename` to a FileTypeInfo. Raises ValueError if unsupported."""
    if not filename:
        raise ValueError("filename is empty")
    # Walk to the last dot AFTER the last path separator so e.g. ".bashrc"
    # is treated as having no extension.
    base = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." not in base:
        raise ValueError(f"no extension in filename '{filename}'")
    ext = "." + base.rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"unsupported extension '{ext}'")
    file_type, extraction_type = ALLOWED_EXTENSIONS[ext]
    return FileTypeInfo(file_type=file_type, extraction_type=extraction_type)


def validate_size(size_bytes: int) -> None:
    """Raise ValueError if size is empty, missing, or exceeds the cap."""
    if size_bytes is None or size_bytes <= 0:
        raise ValueError("file is empty")
    if size_bytes > MAX_BYTES:
        raise ValueError(f"file exceeds {MAX_BYTES} bytes")
