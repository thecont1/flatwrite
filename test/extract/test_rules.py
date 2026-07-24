"""
Tests for the deterministic per-type post-processing rules in
`flatwrite_extract.rules`. Unit-level where possible; one end-to-end
fixture-based PPTX test exercises the real MarkItDown output to pin the
expected shape (the `Notes:` regex is a hypothesis from the plan, not a
given — this test is the safety net that catches future drift).
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from markitdown import MarkItDown

from flatwrite_extract.rules import (
    apply_rules,
    image_metadata,
    audio_metadata,
    passthrough,
    pdf_strip_repeated_lines,
    powerpoint_notes,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


# --------------------------------------------------------------------------
# apply_rules dispatch
# --------------------------------------------------------------------------

class TestApplyRules:
    def test_dispatches_passthrough_types(self):
        for ft in ("word", "excel", "csv", "json", "xml", "html", "zip", "epub"):
            assert apply_rules(ft, "# hi") == "# hi"

    def test_dispatches_powerpoint(self):
        out = apply_rules("powerpoint", "<!-- Slide number: 1 -->\n# T\n\n### Notes:\nnote")
        assert "note" in out
        assert "## Slide 1" in out
        assert "# T" not in out  # slide body was discarded

    def test_dispatches_pdf(self):
        # a single line repeated 4 times should be stripped
        body = "REPEATED\n" * 5 + "kept"
        out = apply_rules("pdf", body)
        assert "REPEATED" not in out
        assert "kept" in out

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
# PowerPoint
# --------------------------------------------------------------------------

class TestPowerpoint:
    def test_extracts_notes_from_single_slide(self):
        text = (
            "<!-- Slide number: 1 -->\n"
            "# Welcome\n"
            "First bullet\n\n"
            "### Notes:\n"
            "Speaker note one.\n"
            "Speaker note two.\n"
        )
        out = powerpoint_notes(text)
        assert "## Slide 1" in out
        assert "Speaker note one." in out
        assert "Speaker note two." in out
        # slide body should be discarded
        assert "First bullet" not in out
        assert "# Welcome" not in out

    def test_falls_back_to_full_body_when_no_notes(self):
        text = (
            "<!-- Slide number: 1 -->\n"
            "# Title only slide\n"
            "Some body text but no notes block.\n"
        )
        out = powerpoint_notes(text)
        assert "## Slide 1" in out
        # full body preserved
        assert "Title only slide" in out
        assert "Some body text" in out

    def test_handles_bare_notes_header_without_hashes(self):
        # The regex accepts both `### Notes:` and bare `Notes:`.
        text = (
            "<!-- Slide number: 1 -->\n"
            "# T\n"
            "Notes:\n"
            "raw notes line\n"
        )
        out = powerpoint_notes(text)
        assert "raw notes line" in out
        assert "# T" not in out

    def test_preserves_slide_index_across_multiple_slides(self):
        text = (
            "<!-- Slide number: 1 -->\n# A\n### Notes:\nn1\n"
            "<!-- Slide number: 2 -->\n# B\n### Notes:\nn2\n"
            "<!-- Slide number: 3 -->\n# C\n### Notes:\nn3\n"
        )
        out = powerpoint_notes(text)
        assert "## Slide 1" in out and "n1" in out
        assert "## Slide 2" in out and "n2" in out
        assert "## Slide 3" in out and "n3" in out

    def test_empty_input_returns_empty(self):
        assert powerpoint_notes("") == ""

    def test_real_fixture_extracts_notes_correctly(self):
        """
        Fixture-based test (the hypothesis check from the plan).

        Runs the real MarkItDown 0.1.6 PPTX converter on the bundled
        sample.pptx (3 slides; slide 1 has notes, slide 2 has no notes,
        slide 3 has notes only). Asserts the post-processed output has:
          - 3 sections, labelled Slide 1/2/3
          - notes text from slides 1 and 3
          - full body for slide 2 (the fallback branch)
        """
        fixture = FIXTURES / "sample.pptx"
        if not fixture.exists():
            pytest.skip(
                f"fixture {fixture} missing — regenerate with "
                f"`python test/extract/build_fixture_pptx.py`"
            )
        md = MarkItDown(enable_plugins=False)
        with open(fixture, "rb") as f:
            result = md.convert_stream(BytesIO(f.read()), source_name="sample.pptx")
        raw = getattr(result, "markdown", result)

        # Sanity: the raw MarkItDown output uses the `### Notes:` shape
        # (not bare `Notes:`). This is what the regex was tuned for.
        assert "### Notes:" in raw, (
            f"MarkItDown output shape changed — expected `### Notes:` "
            f"marker; got:\n{raw}"
        )

        processed = powerpoint_notes(raw)

        # All three slide sections are present.
        assert "## Slide 1" in processed
        assert "## Slide 2" in processed
        assert "## Slide 3" in processed

        # Slide 1: notes extracted, body discarded.
        assert "greet the audience warmly" in processed
        assert "introduce the agenda" in processed
        assert "First bullet" not in processed
        assert "# Welcome" not in processed

        # Slide 2: no notes — body falls through.
        assert "Item one" in processed
        assert "Item two" in processed
        assert "# Agenda" in processed

        # Slide 3: notes extracted, body was already empty.
        assert "call to action" in processed
        assert "thank-yous" in processed


# --------------------------------------------------------------------------
# PDF header/footer stripping
# --------------------------------------------------------------------------

class TestPdfStripRepeatedLines:
    def test_strips_line_repeated_at_threshold(self):
        # 4 repetitions hits the threshold (min is 4).
        body = "HEADER\n" * 4 + "body line\n"
        out = pdf_strip_repeated_lines(body)
        assert "HEADER" not in out
        assert "body line" in out

    def test_keeps_line_repeated_below_threshold(self):
        # 3 repetitions is below the threshold and stays.
        body = "MAYBE\n" * 3 + "body\n"
        out = pdf_strip_repeated_lines(body)
        assert "MAYBE" in out
        assert "body" in out

    def test_keeps_unique_lines(self):
        body = "alpha\nbeta\ngamma\n"
        assert pdf_strip_repeated_lines(body) == body

    def test_empty_input(self):
        assert pdf_strip_repeated_lines("") == ""

    def test_collapses_excess_blank_lines(self):
        # Removing 5 repeated lines should leave at most 2 consecutive blanks
        # (the rule collapses runs > 2 down to 2).
        body = "X\n" * 5 + "a\n\n\n\n\nb\n"
        out = pdf_strip_repeated_lines(body)
        # No run of 4+ newlines anywhere in the output.
        assert "\n\n\n\n" not in out


# --------------------------------------------------------------------------
# Image / audio metadata stubs
# --------------------------------------------------------------------------

class TestMetadataStubs:
    def test_image_metadata_mentions_filename_and_size(self):
        out = image_metadata("", "vacation.jpg", 1024)
        assert "vacation.jpg" in out
        assert "1024 bytes" in out
        assert "OCR" in out  # explains why body wasn't rendered

    def test_audio_metadata_mentions_filename_and_size(self):
        out = audio_metadata("", "song.mp3", 4096)
        assert "song.mp3" in out
        assert "4096 bytes" in out
        assert "transcription" in out.lower()
