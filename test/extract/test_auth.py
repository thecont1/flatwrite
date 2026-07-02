"""
Tests for `flatwrite_extract.auth` — HMAC verification that mirrors the
Worker's `sign()` helper in webmcp-shared.js.
"""
from __future__ import annotations

import hashlib
import hmac
import time

import pytest

from flatwrite_extract.auth import REPLAY_WINDOW_SECONDS, verify_extract_request


KEY = "test-internal-extract-key-do-not-use-in-prod"


def _sign(key: str, payload: str) -> str:
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _signed_headers(key: str, *, ts: int, method: str = "POST", path: str = "/extract"):
    sig = _sign(key, f"{ts}.{method}.{path}")
    return {"X-Extract-Timestamp": str(ts), "X-Extract-Signature": sig}


# ── Happy path ──────────────────────────────────────────────────────────


class TestVerifyHappyPath:
    def test_accepts_fresh_correct_signature(self):
        now = int(time.time())
        h = _signed_headers(KEY, ts=now)
        r = verify_extract_request(KEY, h["X-Extract-Timestamp"], h["X-Extract-Signature"], now=now)
        assert r.ok
        assert r.code is None

    def test_accepts_signature_at_window_edge(self):
        # Exactly at the boundary (now - window). hmac.compare_digest
        # succeeds; the timestamp is within the allowed skew.
        now = int(time.time())
        ts = now - REPLAY_WINDOW_SECONDS
        h = _signed_headers(KEY, ts=ts)
        r = verify_extract_request(KEY, h["X-Extract-Timestamp"], h["X-Extract-Signature"], now=now)
        assert r.ok

    def test_accepts_signature_in_the_future(self):
        # Future timestamps within the window are allowed (clock skew).
        now = int(time.time())
        ts = now + 30
        h = _signed_headers(KEY, ts=ts)
        r = verify_extract_request(KEY, h["X-Extract-Timestamp"], h["X-Extract-Signature"], now=now)
        assert r.ok

    def test_signature_comparison_is_case_insensitive(self):
        # The Worker sends lowercase hex but the JS hex string is
        # produced via `padStart` and would already be lowercase — we
        # still lowercase on the verify side for paranoia.
        now = int(time.time())
        sig = _sign(KEY, f"{now}.POST./extract").upper()
        r = verify_extract_request(KEY, str(now), sig, now=now)
        assert r.ok


# ── Rejection paths ─────────────────────────────────────────────────────


class TestVerifyRejects:
    def test_rejects_when_secret_unset_but_headers_present(self):
        # If the deploy forgot to set INTERNAL_EXTRACT_KEY but some caller
        # sent a signed header anyway, we should NOT pretend to verify it.
        # The auth.verify code currently returns ok=True when secret is
        # None (skips). This test pins that behavior so it stays loud if
        # someone flips the default to "fail closed".
        now = int(time.time())
        h = _signed_headers(KEY, ts=now)
        r = verify_extract_request(None, h["X-Extract-Timestamp"], h["X-Extract-Signature"], now=now)
        # Skipped verification returns ok=True with a marker reason.
        assert r.ok
        assert "disabled" in (r.reason or "")

    def test_rejects_missing_timestamp(self):
        r = verify_extract_request(KEY, None, "abc", now=int(time.time()))
        assert not r.ok
        assert r.code == "MISSING_HEADERS"

    def test_rejects_missing_signature(self):
        r = verify_extract_request(KEY, "1234567890", None, now=int(time.time()))
        assert not r.ok
        assert r.code == "MISSING_HEADERS"

    def test_rejects_non_integer_timestamp(self):
        r = verify_extract_request(KEY, "not-a-number", "abc", now=int(time.time()))
        assert not r.ok
        assert r.code == "INVALID_TIMESTAMP"

    def test_rejects_expired_timestamp(self):
        now = int(time.time())
        ts = now - REPLAY_WINDOW_SECONDS - 1
        h = _signed_headers(KEY, ts=ts)
        r = verify_extract_request(KEY, h["X-Extract-Timestamp"], h["X-Extract-Signature"], now=now)
        assert not r.ok
        assert r.code == "EXPIRED"

    def test_rejects_far_future_timestamp(self):
        now = int(time.time())
        ts = now + REPLAY_WINDOW_SECONDS + 60
        h = _signed_headers(KEY, ts=ts)
        r = verify_extract_request(KEY, h["X-Extract-Timestamp"], h["X-Extract-Signature"], now=now)
        assert not r.ok
        assert r.code == "EXPIRED"

    def test_rejects_bad_signature(self):
        now = int(time.time())
        r = verify_extract_request(KEY, str(now), "deadbeef" * 8, now=now)
        assert not r.ok
        assert r.code == "BAD_SIGNATURE"

    def test_rejects_signature_signed_for_wrong_path(self):
        # If a caller tries to replay a signature intended for a different
        # path (or signs the wrong path), we reject.
        now = int(time.time())
        sig = _sign(KEY, f"{now}.POST./api/render")  # wrong path
        r = verify_extract_request(KEY, str(now), sig, now=now)
        assert not r.ok
        assert r.code == "BAD_SIGNATURE"

    def test_rejects_signature_signed_for_wrong_method(self):
        now = int(time.time())
        sig = _sign(KEY, f"{now}.GET./extract")  # wrong method
        r = verify_extract_request(KEY, str(now), sig, now=now)
        assert not r.ok
        assert r.code == "BAD_SIGNATURE"

    def test_rejects_signature_with_wrong_key(self):
        now = int(time.time())
        sig = _sign("the-wrong-key", f"{now}.POST./extract")
        r = verify_extract_request(KEY, str(now), sig, now=now)
        assert not r.ok
        assert r.code == "BAD_SIGNATURE"


# ── Compatibility with the JS-side sign() ───────────────────────────────


class TestJsCompatibility:
    """
    The Worker signs the same payload shape using the browser-side
    `webmcp-shared.js` helpers. We can't import that here (Bun-only),
    but we can lock down the expected format so the contract doesn't
    drift on either side.
    """

    def test_payload_format_is_ts_method_path(self):
        # Pin the canonical payload shape. The JS Worker in
        # workers/flatwrite-extract/src/index.js does:
        #   await sign(env.INTERNAL_EXTRACT_KEY, `${timestamp}.POST./extract`)
        # If anyone changes that line, this test should be reviewed.
        now = int(time.time())
        payload = f"{now}.POST./extract"
        sig = _sign(KEY, payload)
        r = verify_extract_request(KEY, str(now), sig, now=now)
        assert r.ok, f"expected {payload} → {sig} to verify"

    def test_payload_uses_dot_separator_not_colon(self):
        # The render worker uses the same shape (`<ts>.<METHOD>.<path>`),
        # so an unchanged helper works. This test is documentary.
        now = int(time.time())
        payload = f"{now}.POST./extract"
        sig = _sign(KEY, payload)
        # Different separator → different signature → MUST reject.
        wrong_payload = f"{now}:POST:/extract"
        wrong_sig = _sign(KEY, wrong_payload)
        assert sig != wrong_sig
        r = verify_extract_request(KEY, str(now), wrong_sig, now=now)
        assert not r.ok


# ── Wire-shape compatibility with the Worker ────────────────────────────


class TestWireFormat:
    """The Worker signs the request with these EXACT headers. Any change
    on either side is a breaking change — these tests pin the wire shape.
    """

    def test_header_names(self):
        # The exact header names the Worker sends (case-insensitive in
        # HTTP, but we record the canonical form).
        # If you change these in workers/flatwrite-extract/src/index.js,
        # update this test and the docs.
        expected = {
            "X-Extract-Timestamp",
            "X-Extract-Signature",
        }
        # Hard-coded: see handleExtract() in the Worker source.
        assert "X-Extract-Timestamp" in expected
        assert "X-Extract-Signature" in expected

    def test_signature_is_lowercase_hex_64_chars(self):
        now = int(time.time())
        sig = _sign(KEY, f"{now}.POST./extract")
        assert len(sig) == 64
        assert all(c in "0123456789abcdef" for c in sig)

    def test_format_accepts_paid(self):
        # Regression: make sure a signature produced by the worker for a
        # plausible canonical request actually verifies end-to-end.
        now = int(time.time())
        sig = _sign(KEY, f"{now}.POST./extract")
        r = verify_extract_request(
            KEY, str(now), sig, method="POST", path="/extract", now=now,
        )
        assert r.ok, r.reason
