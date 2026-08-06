"""
flatwrite_extract.ocr — local image OCR via RapidOCR.

Converts in-memory image bytes (PNG, JPEG, GIF, WebP, TIFF) to structured
GitHub-Flavored Markdown using `rapidocr-onnxruntime` (PaddleOCR models
converted to ONNX, CPU-only, no network call).

The conversion runs locally: no network call, no LLM, no disk write.
RapidOCR returns text lines with bounding boxes; this module groups them
into headings, bullet points, and paragraphs using position and font-size
heuristics.

Known limitations (v1):
  - Merged all-lowercase words (e.g. "interactiveeditorial") cannot be
    split without a dictionary — those remain as-is.
  - Bullet items where the · character was not detected by OCR are
    treated as paragraphs.
  - Table structure is not reconstructed; table-like layouts come through
    as paragraphs.
"""
from __future__ import annotations

import re

_BULLET_RE = re.compile(r"^[·•●▪◦]\s*")


def _fix_spaces(text: str) -> str:
    """Insert missing spaces that RapidOCR's recognition model often drops.

    Handles camelCase boundaries, punctuation, ampersands, and digit→letter
    transitions. Merged all-lowercase words are left as-is.
    """
    # "EditorialCoder" → "Editorial Coder" (lowercase→Capital+lower)
    # Use [A-Z][a-z] to avoid splitting ALLCAPS like "YOUR" → "YO UR"
    text = re.sub(r"([a-z])([A-Z][a-z])", r"\1 \2", text)
    # "Location:Delhi" → "Location: Delhi" (punctuation→letter/digit)
    text = re.sub(r"([:;,!?])([A-Za-z0-9])", r"\1 \2", text)
    # "Coder&Data" → "Coder & Data"
    text = re.sub(r"(\w)&([A-Z])", r"\1 & \2", text)
    text = re.sub(r"([a-z])&(\w)", r"\1 & \2", text)
    # "3-6Years" → "3-6 Years" (digit→Capital+lower, but not "D3.js")
    text = re.sub(r"(\d)([A-Z][a-z])", r"\1 \2", text)
    # "SUBMITYoUR" → "SUBMIT YoUR" (ALLCAPS→CapLower)
    text = re.sub(r"([A-Z])([A-Z][a-z])", r"\1 \2", text)
    # Rejoin "YoUR" → "YOUR" (common OCR case confusion)
    text = re.sub(r"YoUR", "YOUR", text)
    # Collapse multiple spaces
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def _lines_to_markdown(lines: list) -> str:
    """Convert RapidOCR result lines into structured markdown.

    Each line is a tuple of (box, text, confidence) where box is a list of
    four [x, y] corner points.
    """
    if not lines:
        return ""

    items = []
    for box, text, conf in lines:
        y = box[0][1]
        x = box[0][0]
        h = box[2][1] - box[0][1]
        w = box[1][0] - box[0][0]
        items.append({"y": y, "x": x, "h": h, "w": w, "text": text, "conf": conf})

    # Sort by reading order: top-to-bottom, left-to-right.
    items.sort(key=lambda it: (it["y"], it["x"]))
    heights = sorted(it["h"] for it in items)
    median_h = heights[len(heights) // 2]

    # ── Group lines into blocks ──────────────────────────────────────
    # A block = one heading, one paragraph, or one bullet (with continuations).
    blocks: list[list[dict]] = []
    for it in items:
        if not blocks:
            blocks.append([it])
            continue

        cur = blocks[-1]
        last = cur[-1]
        first = cur[0]
        gap = it["y"] - (last["y"] + last["h"])

        # Bullet character → always new block.
        if _BULLET_RE.match(it["text"]):
            blocks.append([it])
            continue

        # Multi-column: very different x at similar y → new block.
        x_diff = abs(it["x"] - last["x"])
        y_overlap = abs(it["y"] - last["y"])
        if x_diff > median_h * 3 and y_overlap < median_h * 1.5:
            blocks.append([it])
            continue

        # Vertical gap > 0.8 * median_h → new block (paragraph break).
        if gap > median_h * 0.8:
            blocks.append([it])
            continue

        # ── Indentation-aware splitting ───────────────────────────────
        # For bullet blocks: a line at the bullet's x = new item (· missed);
        #   a more-indented line = continuation.
        # For non-bullet blocks: a line less indented than the block's
        #   first line = new block; same/more indented = continuation.
        is_bullet_block = bool(_BULLET_RE.match(first["text"]))
        if is_bullet_block:
            if abs(it["x"] - first["x"]) <= 12:
                blocks.append([it])
                continue
        else:
            if it["x"] < first["x"] - 12:
                blocks.append([it])
                continue

        cur.append(it)

    # ── Classify blocks and emit markdown ─────────────────────────────
    md_parts: list[str] = []
    for block in blocks:
        raw_text = " ".join(it["text"] for it in block)
        text = _fix_spaces(raw_text)

        first_text = block[0]["text"]
        if _BULLET_RE.match(first_text):
            text = _fix_spaces(_BULLET_RE.sub("", raw_text))
            md_parts.append(f"- {text}")
            continue

        max_h = max(it["h"] for it in block)
        if max_h >= median_h * 3.0:
            md_parts.append(f"# {text}")
            continue
        if max_h >= median_h * 1.8:
            md_parts.append(f"## {text}")
            continue

        if len(block) == 1 and text.endswith(":"):
            md_parts.append(f"### {text.rstrip(':')}")
            continue

        md_parts.append(text)

    return "\n\n".join(md_parts) + "\n"


def image_to_markdown(content: bytes) -> str:
    """Convert in-memory image bytes to structured markdown via RapidOCR.

    Returns empty string if no text is detected (e.g. a photograph with
    no text content). The caller should check for empty output and fall
    back to the metadata stub.

    Raises RuntimeError if RapidOCR is not installed or fails.
    """
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as e:
        raise RuntimeError("rapidocr-onnxruntime is not installed") from e

    engine = RapidOCR()
    result, _elapse = engine(content)

    if not result:
        return ""

    return _lines_to_markdown(result)
