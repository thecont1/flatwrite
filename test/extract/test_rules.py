"""
Tests for the deterministic per-type post-processing rules in
`flatwrite_extract.rules`. AnyDoc already returns clean Markdown, so the
only real post-processing left is the image/audio metadata stubs.
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import anydoc
import pytest

from flatwrite_extract.rules import (
    apply_rules,
    image_metadata,
    audio_metadata,
    passthrough,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


# --------------------------------------------------------------------------
# apply_rules dispatch
# --------------------------------------------------------------------------

class TestApplyRules:
    def test_dispatches_passthrough_types(self):
        for ft in ("pdf", "word", "powerpoint", "excel", "csv", "epub"):
            assert apply_rules(ft, "# hi") == "# hi"

    def test_dispatches_image(self):
        out = apply_rules("image", "", filename="pic.png", size_bytes=42)
        assert "Image metadata" in out
        assert "pic.png" in out
        assert "42 bytes" in out

    def test_dispatches_audio(self):
        out = apply_rules("audio", "", filename="song.mp3", size_bytes=99)
        assert "Audio metadata" in out
        assert "song.mp3" in out

    def test_unknown_type_falls_back_to_passthrough(self):
        # Defensive: if a new fileType is added but no rule wired up, the
        # API still returns the raw markdown rather than 500-ing.
        assert apply_rules("future-type", "# raw") == "# raw"


# --------------------------------------------------------------------------
# Passthrough
# --------------------------------------------------------------------------

class TestPassthrough:
    def test_returns_input_unchanged(self):
        assert passthrough("hello\n\nworld") == "hello\n\nworld"

    def test_empty_string(self):
        assert passthrough("") == ""


# --------------------------------------------------------------------------
# AnyDoc output for the bundled PPTX fixture
# --------------------------------------------------------------------------

class TestPowerpoint:
    def test_anydoc_extracts_slide_headings_and_notes(self):
        """
        Fixture-based test: run the real AnyDoc PPTX converter on the bundled
        sample.pptx (3 slides; slide 1 and 3 have notes, slide 2 has none).
        AnyDoc emits notes as blockquotes, so we assert the notes text and
        slide headings are present rather than the legacy MarkItDown
        `### Notes:` shape.
        """
        fixture = FIXTURES / "sample.pptx"
        if not fixture.exists():
            pytest.skip(
                f"fixture {fixture} missing — regenerate with "
                f"`python test/extract/build_fixture_pptx.py`"
            )

        raw = anydoc.to_markdown_bytes(fixture.read_bytes())

        # Slide headings and notes from the fixture are present.
        assert "## Welcome" in raw
        assert "## Agenda" in raw
        assert "## Closing" in raw
        assert "greet the audience" in raw
        assert "introduce the agenda" in raw
        assert "call to action" in raw
        assert "thank-yous" in raw


# --------------------------------------------------------------------------
# Image / audio metadata stubs
# --------------------------------------------------------------------------

class TestImageMetadata:
    def test_includes_filename_and_size(self):
        out = image_metadata("", filename="pic.png", size_bytes=42)
        assert "pic.png" in out
        assert "42 bytes" in out

    def test_notes_no_ocr(self):
        out = image_metadata("", filename="pic.png", size_bytes=42)
        assert "No text was detected in this image" in out

    def test_passes_through_ocr_text(self):
        out = image_metadata("# Hello\n\nWorld", filename="pic.png", size_bytes=42)
        assert out == "# Hello\n\nWorld"


class TestAudioMetadata:
    def test_includes_filename_and_size(self):
        out = audio_metadata("", filename="song.mp3", size_bytes=99)
        assert "song.mp3" in out
        assert "99 bytes" in out

    def test_notes_no_transcription(self):
        out = audio_metadata("", filename="song.mp3", size_bytes=99)
        assert "AnyDoc does not transcribe audio" in out
