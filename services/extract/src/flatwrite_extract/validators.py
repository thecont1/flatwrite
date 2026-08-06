"""
flatwrite_extract.validators — extension allowlist and file-type inference.

Single source of truth for the set of file types FlatWrite can convert.
Anything not in the allowlist is rejected with HTTP 415 by the API layer.
"""
from __future__ import annotations

from dataclasses import dataclass

# extension (lowercase, including the leading dot) -> (fileType, extractionType)
# Keep this in sync with the AnyDoc-supported formats listed at
# https://github.com/firecrawl/anydoc and `public/index.html`.
ALLOWED_EXTENSIONS: dict[str, tuple[str, str]] = {
    # PDF
    ".pdf":  ("pdf",        "pdf-body"),
    # Word / Word-like
    ".doc":  ("word",       "word-body"),
    ".docx": ("word",       "word-body"),
    ".docm": ("word",       "word-body"),
    ".odt":  ("word",       "word-body"),
    ".rtf":  ("word",       "word-body"),
    # PowerPoint / presentation-like
    ".ppt":  ("powerpoint", "powerpoint-notes"),
    ".pps":  ("powerpoint", "powerpoint-notes"),
    ".pot":  ("powerpoint", "powerpoint-notes"),
    ".pptx": ("powerpoint", "powerpoint-notes"),
    ".pptm": ("powerpoint", "powerpoint-notes"),
    ".ppsx": ("powerpoint", "powerpoint-notes"),
    ".ppsm": ("powerpoint", "powerpoint-notes"),
    ".odp":  ("powerpoint", "powerpoint-notes"),
    # Excel / spreadsheet-like
    ".xls":  ("excel",      "excel-tables"),
    ".xlsx": ("excel",      "excel-tables"),
    ".xlsm": ("excel",      "excel-tables"),
    ".xlsb": ("excel",      "excel-tables"),
    ".ods":  ("excel",      "excel-tables"),
    ".csv":  ("csv",        "structured-data"),
    # Other document formats
    ".epub": ("epub",       "epub-body"),
    # Image types are converted via local OCR (RapidOCR). When OCR finds
    # no text, rules.py emits a metadata-only stub.
    ".png":  ("image",      "image-ocr"),
    ".jpg":  ("image",      "image-ocr"),
    ".jpeg": ("image",      "image-ocr"),
    ".gif":  ("image",      "image-ocr"),
    ".webp": ("image",      "image-ocr"),
    ".tiff": ("image",      "image-ocr"),
    ".tif":  ("image",      "image-ocr"),
    ".mp3":  ("audio",      "audio-metadata"),
    ".wav":  ("audio",      "audio-metadata"),
    ".m4a":  ("audio",      "audio-metadata"),
    ".ogg":  ("audio",      "audio-metadata"),
    ".flac": ("audio",      "audio-metadata"),
}

# Max upload size — 25 MB per the plan.
MAX_BYTES: int = 25 * 1024 * 1024


@dataclass(frozen=True)
class FileTypeInfo:
    """Canonical type tokens for an allowed file extension.

    `file_type` is the internal fileType used for rule dispatch (e.g.
    "powerpoint"), and `extraction_type` is the human/API-facing label
    (e.g. "powerpoint-notes").
    """
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
