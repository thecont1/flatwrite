"""
End-to-end browser smoke for the drop-and-extract flow.

Verifies the full chain: a File is dropped onto the editor at
flatwrite.md, the JS mints a token from extract.flatwrite.md, the
multipart body POSTs to extract.flatwrite.md/extract, the Worker
forwards to Fly, MarkItDown converts, and the markdown lands in
the editor.

This is the only test that actually exercises the browser-side
handleExtractDrop() against the real public surface. The bun
tests cover the routing helpers; the bun Worker tests cover the
Worker. This covers the user-visible drop.

Run with:
    /Library/Developer/CommandLineTools/usr/bin/python3 -m playwright install chromium
    /Library/Developer/CommandLineTools/usr/bin/python3 -m pytest test/extract/e2e_drop.py -v
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from playwright.sync_api import expect, sync_playwright

# The system-Python Playwright (per memory note: can't reach
# thecontrarian.in or localhost:<port> via MCP browser). The
# flatwrite.md page is reachable because Playwright is using the
# system browser, not the MCP one.
PLAYWRIGHT_PY = "/Library/Developer/CommandLineTools/usr/bin/python3"

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sample.pptx"
# Default to the local editor served from public/ on port 8080
# (started via `cd public && python3 -m http.server 8080`).
# Override with FLATWRITE_E2E_URL=https://flatwrite.md/ to run
# against prod once the new frontend is deployed there.
EDITOR_URL = os.environ.get("FLATWRITE_E2E_URL", "http://127.0.0.1:8080/")


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        yield b
        b.close()


def test_drop_pptx_extracts_notes_into_editor(browser):
    """
    Drag-and-drop a .pptx onto the editor. Expect:
      - A toast appears (the "Extracting ..." indicator)
      - The editor <textarea> value contains the Slide 1 notes
        extracted by the rule (the plan's hypothesis)
    """
    if not FIXTURE.exists():
        pytest.skip(f"fixture {FIXTURE} missing")
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)

        # Wait for the editor to be ready (it sets initialEditorContent
        # in init()).
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)
        # The "extract-drop.js" helper must be loaded before the test
        # can simulate a drop — if the script tag was missed, this
        # will be None and the test fails clearly.
        helper = page.evaluate("() => typeof window.FlatwriteExtractDrop")
        assert helper == "object", (
            f"FlatwriteExtractDrop not on window; got {helper!r}. "
            f"Likely extract-drop.js failed to load (check <script> order "
            f"and the ?v= cache-bust param)."
        )

        # Read the current editor value so we can confirm the
        # post-drop state is different.
        before = page.locator("#editor").input_value()

        # Simulate a real File drop via the DataTransfer API.
        # Playwright doesn't have a built-in "drop file" helper for
        # the editor (which is a <textarea>, not a file input), so
        # we construct the DragEvent ourselves and dispatch it on
        # the document (where bindDropZone() is listening).
        page.evaluate(
            """async ([name, b64]) => {
                // Decode the base64 fixture into a File object.
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const file = new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });

                // Build a DragEvent with a DataTransfer that carries
                // exactly one File. dispatchEvent is synchronous but
                // handleExtractDrop is async; we don't need to await
                // it from inside the page because we poll the
                // editor's value from the test driver.
                const dt = new DataTransfer();
                dt.items.add(file);
                const ev = new DragEvent('drop', {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: dt,
                });
                document.dispatchEvent(ev);
            }""",
            [FIXTURE.name, _read_b64(FIXTURE)],
        )

        # Wait for the editor to be updated with the extracted notes.
        # We poll for the unique Slide 1 notes string from the fixture.
        page.wait_for_function(
            "() => document.getElementById('editor') && "
            "document.getElementById('editor').value.includes('greet the audience warmly')",
            timeout=45_000,
        )

        after = page.locator("#editor").input_value()
        assert after != before, "editor content did not change after drop"
        assert "greet the audience warmly" in after
        assert "## Slide 1" in after
        # The notes-only slide (slide 3) should also be present.
        assert "call to action" in after or "thank-yous" in after
    finally:
        page.close()


def _read_b64(path: Path) -> str:
    import base64
    return base64.b64encode(path.read_bytes()).decode("ascii")
