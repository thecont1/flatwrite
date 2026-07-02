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


def test_extract_rejects_empty_filename(client: TestClient):
    # A multipart part with an explicit empty-string filename (the wire
    # shape a malformed client could send). httpx's file-tuple helper
    # won't produce this directly — it either fabricates a filename or
    # 422s client-side — so the raw multipart body is built by hand to
    # pin the exact `Content-Disposition: ...; filename=""` case our
    # handler must reject with 400, not the FastAPI-generated 422 or a
    # 415 from treating it as an unsupported type.
    boundary = "----flatwriteTestBoundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename=""\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
        "x\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    r = client.post(
        "/extract",
        content=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "BAD_REQUEST"


def test_extract_rejects_empty_body(client: TestClient):
    # Allowed extension, but zero-byte body — this is the EMPTY_FILE path.
    files = {"file": ("data.csv", io.BytesIO(b""), "text/csv")}
    r = client.post("/extract", files=files)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "EMPTY_FILE"


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


def test_extract_500_does_not_leak_internal_paths(client: TestClient, monkeypatch, caplog):
    """A conversion failure must not echo the raw exception (which can
    contain absolute paths, library versions, etc.) into the response
    body. The full detail is still available server-side via log.exception.
    """
    def _boom(content, source_name):
        raise RuntimeError("file:///srv/secrets/db.sqlite not found")

    monkeypatch.setattr("flatwrite_extract.main.convert_bytes", _boom)
    body = b"col1,col2\na,1\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    with caplog.at_level("ERROR", logger="flatwrite-extract"):
        r = client.post("/extract", files=files)
    assert r.status_code == 500
    detail = r.json()["detail"]
    assert detail["code"] == "CONVERSION_FAILED"
    assert "secrets" not in detail["error"]
    assert "file://" not in detail["error"]
    # The full exception must still be captured in the server log.
    assert any("secrets" in rec.getMessage() or "db.sqlite" in str(rec.exc_info) for rec in caplog.records)


def test_extract_audio_returns_metadata_stub(client: TestClient):
    # Minimal valid WAV file: RIFF header + fmt chunk + a single zero
    # data sample. MarkItDown's audio converter should accept this and
    # fall through to the metadata-only stub (no transcription in v1).
    # This is a real, well-formed WAV — the test pins a strict 200
    # contract rather than accepting a silent 500 regression.
    wav = (
        b"RIFF" + (36).to_bytes(4, "little") + b"WAVE"
        + b"fmt " + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")   # PCM
        + (1).to_bytes(2, "little")   # mono
        + (44100).to_bytes(4, "little")  # sample rate
        + (88200).to_bytes(4, "little")  # byte rate
        + (2).to_bytes(2, "little")   # block align
        + (16).to_bytes(2, "little")  # bits per sample
        + b"data" + (0).to_bytes(4, "little")
    )
    files = {"file": ("a.wav", io.BytesIO(wav), "audio/wav")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["metadata"]["fileType"] == "audio"
    assert "Audio metadata" in j["markdown"]


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


def test_extract_accepts_unsigned_request_when_secret_not_set_and_hmac_not_required(
    client: TestClient, monkeypatch
):
    """When the deploy hasn't set INTERNAL_EXTRACT_KEY and HMAC is not
    required (e.g. local dev), auth is skipped."""
    monkeypatch.setenv("EXTRACT_HMAC_REQUIRED", "false")
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    r = client.post("/extract", files=files)
    assert r.status_code == 200


def test_extract_rejects_unsigned_request_when_hmac_required_but_secret_missing(
    client: TestClient, monkeypatch
):
    """Production misconfiguration: fly.toml sets EXTRACT_HMAC_REQUIRED=true
    but INTERNAL_EXTRACT_KEY is missing. The service must fail closed."""
    monkeypatch.setenv("EXTRACT_HMAC_REQUIRED", "true")
    body = b"a,b\n1,2\n"
    files = {"file": ("data.csv", io.BytesIO(body), "text/csv")}
    r = client.post("/extract", files=files)
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "MISSING_SECRET"
