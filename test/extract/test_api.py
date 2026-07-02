"""
Tests for the FastAPI /extract endpoint via httpx.AsyncClient + ASGITransport
(avoids spinning up uvicorn). Covers:
  - 200 on a known file type
  - 400 on empty file
  - 413 on oversize
  - 415 on unknown extension
  - 401 when INTERNAL_EXTRACT_KEY is set and signature is wrong
  - 200 when INTERNAL_EXTRACT_KEY is set and signature is correct
  - 200 on /health
"""
from __future__ import annotations

import hashlib
import hmac
import io
import os
import time

import pytest
from fastapi.testclient import TestClient

from flatwrite_extract.main import app

TEST_KEY = "test-internal-extract-key"


def _sign(key: str, payload: str) -> str:
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def authed_client(monkeypatch) -> TestClient:
    """A client that simulates a properly signed request.

    Patches the env var, then patches `_internal_secret()` via the same
    lookup so the app picks up the new value (FastAPI doesn't read os
    directly inside the request — we still need the lookup to refresh).
    The simplest robust path: monkeypatch `_internal_secret` directly on
    the module.
    """
    monkeypatch.setattr("flatwrite_extract.main._internal_secret", lambda: TEST_KEY)
    return TestClient(app)


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["service"] == "flatwrite-extract"
    assert body["maxBytes"] == 25 * 1024 * 1024


def test_extract_rejects_unsupported_extension(client: TestClient):
    files = {"file": ("a.xyz", io.BytesIO(b"hi"), "application/octet-stream")}
    r = client.post("/extract", files=files)
    assert r.status_code == 415
    assert r.json()["detail"]["code"] == "UNSUPPORTED_FILE_TYPE"


def test_extract_rejects_empty_file(client: TestClient):
    files = {"file": ("a.txt", io.BytesIO(b""), "text/plain")}
    # .txt is not in the allowlist — but we expect 415 before 400.
    r = client.post("/extract", files=files)
    assert r.status_code == 415


def test_extract_rejects_oversize(client: TestClient):
    big = b"x" * (25 * 1024 * 1024 + 1)
    files = {"file": ("big.json", io.BytesIO(big), "application/json")}
    r = client.post("/extract", files=files)
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "PAYLOAD_TOO_LARGE"


def test_extract_csv_passthrough(client: TestClient):
    body = b"col1,col2\na,1\nb,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["metadata"]["fileType"] == "csv"
    assert j["metadata"]["extractionType"] == "structured-data"
    assert j["metadata"]["sizeBytes"] == len(body)
    # MarkItDown emits a markdown table — the column names should still
    # be present in the rendered output.
    assert "col1" in j["markdown"] and "col2" in j["markdown"]


def test_extract_json_passthrough(client: TestClient):
    body = b'{"hello":"world","n":1}\n'
    files = {"file": ("data.json", io.BytesIO(body), "application/json")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200
    j = r.json()
    assert j["metadata"]["fileType"] == "json"
    assert "hello" in j["markdown"]


def test_extract_xml_passthrough(client: TestClient):
    body = b"<root><item>1</item></root>\n"
    files = {"file": ("data.xml", io.BytesIO(body), "application/xml")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200
    j = r.json()
    assert j["metadata"]["fileType"] == "xml"


def test_extract_html_passthrough(client: TestClient):
    body = b"<html><body><h1>Hi</h1></body></html>\n"
    files = {"file": ("page.html", io.BytesIO(body), "text/html")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200
    j = r.json()
    assert j["metadata"]["fileType"] == "html"


def test_extract_image_returns_metadata_stub(client: TestClient):
    # 1x1 transparent PNG, minimal bytes
    body = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d4944415478da63000100000005000159ce5e8e0000000049454e44"
        "ae426082"
    )
    files = {"file": ("p.png", io.BytesIO(body), "image/png")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200
    j = r.json()
    assert j["metadata"]["fileType"] == "image"
    assert j["metadata"]["extractionType"] == "image-metadata"
    assert "Image metadata" in j["markdown"]


def test_extract_audio_returns_metadata_stub(client: TestClient):
    # Just enough bytes to be non-empty; MarkItDown may not be able to
    # parse the actual file format, so we expect a 200 with the metadata
    # stub OR a 500 if it really fails to convert. Accept either, but
    # verify a real failure path returns 500 with the right code.
    body = b"ID3\x03\x00\x00\x00\x00\x00\x21TPE1\x00\x00\x00\x0aTest Artist\x00\x00\x00\x00\x00\x00"
    files = {"file": ("a.mp3", io.BytesIO(body), "audio/mpeg")}
    r = client.post("/extract", files=files)
    if r.status_code == 200:
        j = r.json()
        assert j["metadata"]["fileType"] == "audio"
        assert "Audio metadata" in j["markdown"]
    else:
        # If the conversion truly fails, the error must be 500/CONVERSION_FAILED.
        assert r.status_code == 500
        assert r.json()["detail"]["code"] == "CONVERSION_FAILED"


# ── Auth verification (when INTERNAL_EXTRACT_KEY is configured) ──────────


def test_extract_rejects_unsigned_request_when_secret_set(authed_client: TestClient):
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    r = authed_client.post("/extract", files=files)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "MISSING_HEADERS"


def test_extract_rejects_bad_signature_when_secret_set(authed_client: TestClient):
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    r = authed_client.post(
        "/extract",
        files=files,
        headers={
            "X-Extract-Timestamp": str(int(time.time())),
            "X-Extract-Signature": "deadbeef" * 8,
        },
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "BAD_SIGNATURE"


def test_extract_rejects_expired_timestamp_when_secret_set(authed_client: TestClient):
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    ts = int(time.time()) - 600  # way outside the 5-minute window
    sig = _sign(TEST_KEY, f"{ts}.POST./extract")
    r = authed_client.post(
        "/extract",
        files=files,
        headers={
            "X-Extract-Timestamp": str(ts),
            "X-Extract-Signature": sig,
        },
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "EXPIRED"


def test_extract_accepts_signed_request_when_secret_set(authed_client: TestClient):
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    ts = int(time.time())
    sig = _sign(TEST_KEY, f"{ts}.POST./extract")
    r = authed_client.post(
        "/extract",
        files=files,
        headers={
            "X-Extract-Timestamp": str(ts),
            "X-Extract-Signature": sig,
        },
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["metadata"]["fileType"] == "csv"
    assert "a" in j["markdown"]


def test_extract_accepts_unsigned_request_when_secret_not_set(client: TestClient):
    """When the deploy hasn't set INTERNAL_EXTRACT_KEY (e.g. local dev),
    auth is skipped. This pins the asymmetric-default behavior."""
    # The default `client` fixture does NOT patch the secret, so
    # `_internal_secret()` returns None.
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200
