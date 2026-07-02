"""
flatwrite_extract.main — FastAPI app for POST /extract.

The app is intentionally tiny. All real logic lives in:
  - converter.convert_bytes
  - rules.apply_rules
  - validators.infer_type / validate_size

The /extract endpoint:
  - accepts multipart/form-data with field "file"
  - validates the file is under 25 MB (413), non-empty (400), and has an
    allowed extension (415)
  - converts in-memory (never writes to disk) via MarkItDown
  - applies the per-type post-processing rule
  - returns { markdown, metadata: { extractionType, filename, fileType, sizeBytes } }
  - logs only the filename and size — never the content
"""
from __future__ import annotations

import logging
import os
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from .auth import verify_extract_request
from .converter import convert_bytes
from .rules import apply_rules
from .validators import MAX_BYTES, infer_type, validate_size

log = logging.getLogger("flatwrite-extract")

app = FastAPI(
    title="flatwrite-extract",
    version="0.1.0",
    description="MarkItDown-backed file extraction for FlatWrite. "
                "No LLM calls, no disk writes, no URL-based conversion.",
)


def _internal_secret() -> str | None:
    """Read the shared HMAC secret from the environment.

    Optional at runtime (skips verification when unset) but the deploy
    must set it — the Worker will return 500 if its counterpart is
    missing, so asymmetric config makes the deploy surface obvious.
    """
    return os.environ.get("INTERNAL_EXTRACT_KEY") or None


@app.get("/health")
def health() -> dict:
    """Liveness probe for Fly.io / Docker."""
    return {"ok": True, "service": "flatwrite-extract", "maxBytes": MAX_BYTES}


@app.post("/extract")
async def extract(
    request: Request,
    file: Annotated[UploadFile, File(...)],
) -> JSONResponse:
    # ── Auth ───────────────────────────────────────────────────────────
    # The CF Worker proxy signs each upstream request with the shared
    # INTERNAL_EXTRACT_KEY. We verify here before reading the body so a
    # forged call can't even consume our conversion budget.
    secret = _internal_secret()
    ts = request.headers.get("X-Extract-Timestamp")
    sig = request.headers.get("X-Extract-Signature")
    auth = verify_extract_request(secret, ts, sig, method="POST", path="/extract")
    if not auth.ok:
        # Map structured auth failure → HTTP. Every reject logs without
        # exposing the offending headers themselves (just the code).
        status = 400 if auth.code == "MISSING_HEADERS" else 401
        log.warning("extract auth rejected: %s (%s)", auth.code, auth.reason)
        raise HTTPException(
            status_code=status,
            detail={"error": auth.reason, "code": auth.code},
        )

    # filename is the only header we trust from the multipart envelope.
    filename = file.filename or ""
    try:
        type_info = infer_type(filename)
    except ValueError as e:
        # Unsupported extension — 415.
        raise HTTPException(
            status_code=415,
            detail={"error": str(e), "code": "UNSUPPORTED_FILE_TYPE"},
        )

    content = await file.read()
    try:
        validate_size(len(content))
    except ValueError as e:
        msg = str(e)
        if "exceeds" in msg:
            raise HTTPException(
                status_code=413,
                detail={"error": msg, "code": "PAYLOAD_TOO_LARGE"},
            )
        raise HTTPException(
            status_code=400,
            detail={"error": msg, "code": "EMPTY_FILE"},
        )

    try:
        raw_md = convert_bytes(content, source_name=filename)
    except Exception as e:  # noqa: BLE001 — MarkItDown raises varied exception types
        log.exception("convert failed for filename=%s size=%d", filename, len(content))
        raise HTTPException(
            status_code=500,
            detail={"error": f"Conversion failed: {e}", "code": "CONVERSION_FAILED"},
        )

    final_md = apply_rules(
        type_info.file_type,
        raw_md,
        filename=filename,
        size_bytes=len(content),
    )

    return JSONResponse(
        status_code=200,
        content={
            "markdown": final_md,
            "metadata": {
                "extractionType": type_info.extraction_type,
                "filename": filename,
                "fileType": type_info.file_type,
                "sizeBytes": len(content),
            },
        },
    )
