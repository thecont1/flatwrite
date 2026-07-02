"""
flatwrite_extract.auth — HMAC verification for incoming requests from the
Cloudflare Worker proxy (`workers/flatwrite-extract/src/index.js`).

The Worker signs `<unix-timestamp>.POST.<path>` with HMAC-SHA256 and
forwards the result in two headers:

  X-Extract-Timestamp: <unix-seconds>
  X-Extract-Signature: <hex(HMAC-SHA256)>

This module verifies both, with a 5-minute replay window (same value the
Vercel-side /api/render uses for `core/auth.verify` — keeping the
auth contract identical across services avoids surprise drift).

When `INTERNAL_EXTRACT_KEY` is unset, verification is SKIPPED — this
matches the Worker's behavior of returning 500 MISCONFIGURED. We want
local development to be reachable without a Worker in the loop.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from dataclasses import dataclass


# 5-minute replay window. Same value used by api/render.js.
REPLAY_WINDOW_SECONDS = 5 * 60


@dataclass(frozen=True)
class AuthResult:
    ok: bool
    code: str | None = None   # machine-readable error code (None on success)
    reason: str | None = None # human-readable detail


def _sign(key: str, payload: str) -> str:
    """Return HMAC-SHA256(key, payload) as lowercase hex.

    Mirrors the browser-side `sign()` helper in webmcp-shared.js:
    crypto.subtle.sign('HMAC', ...) with SHA-256, hex-encoded.
    """
    return hmac.new(
        key.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_extract_request(
    secret: str | None,
    timestamp_header: str | None,
    signature_header: str | None,
    *,
    required: bool = False,
    method: str = "POST",
    path: str = "/extract",
    now: int | None = None,
) -> AuthResult:
    """Verify a request signed by the Worker proxy.

    Returns AuthResult(ok=True) on success, otherwise AuthResult with
    `code` populated for the caller to map to an HTTP status:
      - MISSING_HEADERS      (400)
      - INVALID_TIMESTAMP    (401)
      - EXPIRED              (401)
      - BAD_SIGNATURE        (401)
      - MISSING_SECRET       (401)  # only when required=True and secret is absent
    """
    if not secret:
        if required:
            return AuthResult(
                ok=False,
                code="MISSING_SECRET",
                reason="HMAC verification required but INTERNAL_EXTRACT_KEY is not configured",
            )
        # No secret configured on this service — skip verification. The
        # Worker's matching secret check returns 500 MISCONFIGURED, so
        # this asymmetry means a misconfigured dev deploy still refuses to
        # accidentally authenticate as a Worker.
        return AuthResult(ok=True, code=None, reason="auth disabled (no secret configured)")

    if not timestamp_header or not signature_header:
        return AuthResult(
            ok=False,
            code="MISSING_HEADERS",
            reason="missing X-Extract-Timestamp or X-Extract-Signature",
        )

    try:
        ts = int(timestamp_header)
    except (TypeError, ValueError):
        return AuthResult(
            ok=False,
            code="INVALID_TIMESTAMP",
            reason=f"timestamp is not an integer (got {timestamp_header!r})",
        )

    current = now if now is not None else int(time.time())
    if abs(current - ts) > REPLAY_WINDOW_SECONDS:
        return AuthResult(
            ok=False,
            code="EXPIRED",
            reason=f"timestamp {ts} is outside the {REPLAY_WINDOW_SECONDS}s window",
        )

    expected = _sign(secret, f"{ts}.{method}.{path}")
    if not hmac.compare_digest(expected, signature_header.lower()):
        return AuthResult(
            ok=False,
            code="BAD_SIGNATURE",
            reason="signature does not match expected HMAC",
        )
    return AuthResult(ok=True)
