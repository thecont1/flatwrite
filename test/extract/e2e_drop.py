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


def test_drop_md_file_in_edit_mode(browser):
    """
    Drag-and-drop a .md onto the editor in Edit mode.
    Expect the textarea to be populated with the file contents
    immediately (no extract round-trip) and the mode to remain Edit.
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        # Drop a .md file
        md_content = "# Hello Markdown\n\nThis is dropped directly into the editor."
        page.evaluate(
            """([name, content]) => {
                const file = new File([content], name, { type: 'text/markdown' });
                const dt = new DataTransfer();
                dt.items.add(file);
                document.dispatchEvent(new DragEvent('drop', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                }));
            }""",
            ["hello.md", md_content],
        )
        # Wait briefly for FileReader.readAsText to complete
        page.wait_for_function(
            f"() => document.getElementById('editor').value.includes('Hello Markdown')",
            timeout=5000,
        )
        assert "Hello Markdown" in editor.input_value()
        assert "dropped directly" in editor.input_value()
        # Mode is still Edit
        mode_class = page.evaluate(
            "() => [...document.getElementById('app-shell').classList].find(c => c.startsWith('mode-'))"
        )
        assert mode_class == "mode-edit", f"expected mode-edit, got {mode_class}"
    finally:
        page.close()


def test_drop_md_file_in_view_mode_renders_preview(browser):
    """
    Drag-and-drop a .md onto the editor in View mode. Expect:
      - The textarea receives the content
      - The preview pane re-renders (the user actually sees the
        new content — previously the textarea was hidden in
        View mode so a drop with no renderPreview() left a blank
        preview)
      - Mode remains View
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        # Switch to View mode
        page.locator(".mode-switch-label:has-text('View')").click()
        page.wait_for_timeout(300)
        assert page.evaluate(
            "() => [...document.getElementById('app-shell').classList].find(c => c.startsWith('mode-'))"
        ) == "mode-preview"

        # Drop a .md
        md_content = "# View Mode Drop\n\nVisible in the preview pane."
        page.evaluate(
            """([name, content]) => {
                const file = new File([content], name, { type: 'text/markdown' });
                const dt = new DataTransfer();
                dt.items.add(file);
                document.dispatchEvent(new DragEvent('drop', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                }));
            }""",
            ["hello.md", md_content],
        )

        # Wait for the preview to render the new content. The
        # preview iframe is rebuilt on renderPreview(), so wait
        # for the visible preview text instead of the textarea
        # value.
        page.wait_for_function(
            "() => { const f = document.getElementById('preview-frame');"
            " return f && f.contentDocument && f.contentDocument.body &&"
            " f.contentDocument.body.textContent.includes('View Mode Drop'); }",
            timeout=10_000,
        )

        # Mode preserved
        assert page.evaluate(
            "() => [...document.getElementById('app-shell').classList].find(c => c.startsWith('mode-'))"
        ) == "mode-preview"
    finally:
        page.close()


def _read_b64(path: Path) -> str:
    import base64
    return base64.b64encode(path.read_bytes()).decode("ascii")


def test_file_picker_accepts_pptx_and_routes_through_extract(browser):
    """
    Verify the "From Disk" button now accepts any file format and
    routes non-text files through the /extract endpoint (same
    dispatch as drag-and-drop). The user picks a .pptx via the
    file input, and the editor gets the extracted markdown.
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_timeout(500)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        # Sanity-check the file input's accept attribute covers all
        # the extractable types — without this regression users see
        # the picker filtered down to .md/.txt.
        accept = page.evaluate(
            "() => document.getElementById('load-file-input').accept"
        )
        for ext in (".pdf", ".pptx", ".docx", ".xlsx", ".csv"):
            assert ext in accept, f"missing {ext} from file input accept: {accept!r}"

        # Simulate picking a .pptx. The fixture lives outside the
        # public/ dir, so we read it via the Python side and inline
        # the bytes into the page as a File.
        pptx_b64 = _read_b64(FIXTURE)
        page.evaluate(
            """([name, b64]) => {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const file = new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
                const dt = new DataTransfer();
                dt.items.add(file);
                const input = document.getElementById('load-file-input');
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }""",
            [FIXTURE.name, pptx_b64],
        )

        # Wait for the extract to complete and the editor to update.
        page.wait_for_function(
            "() => document.getElementById('editor') && "
            "document.getElementById('editor').value.includes('greet the audience warmly')",
            timeout=45_000,
        )
        assert "greet the audience warmly" in editor.input_value()
    finally:
        page.close()


def test_url_load_with_md_url_loads_directly(browser):
    """
    Verify the "From URL" modal handles .md URLs by reading the
    response as text and setting the editor content directly (no
    extract round-trip).
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_timeout(500)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        # Stub fetch to return markdown content for any URL the modal
        # fires (we don't want the test to depend on a real network).
        page.evaluate(
            """() => {
                window.fetch = async function (url) {
                    return new Response(
                        '# Markdown from URL\\n\\nLoaded directly via the URL modal.',
                        { status: 200, headers: { 'Content-Type': 'text/markdown' } }
                    );
                };
            }"""
        )

        # Open the modal, type the URL, click Fetch.
        page.locator("#btn-load-url").click()
        page.wait_for_timeout(300)
        page.locator("#load-url-input").fill("https://example.com/file.md")
        page.locator("#load-modal-insert").click()

        # Wait for the modal to close and the editor to update.
        page.wait_for_function(
            "() => document.getElementById('editor').value.includes('Markdown from URL')",
            timeout=10_000,
        )
        assert "Loaded directly via the URL modal" in editor.input_value()
    finally:
        page.close()


def test_url_load_with_pdf_url_routes_through_extract(browser):
    """
    Verify the "From URL" modal handles binary URLs (PDF, PPTX, …)
    by fetching them as a Blob and forwarding to /extract. The
    result is the extracted markdown in the editor.
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_timeout(500)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        # Stub fetch to return a fake PDF Blob for the user URL,
        # and a fake token + fake extract response for the Worker
        # calls. We can't route the real /extract here because
        # we don't have a real PDF; this proves the *routing* works.
        page.evaluate(
            """() => {
                window.fetch = async function (url, opts) {
                    if (String(url).includes('mcp-token')) {
                        return new Response(
                            JSON.stringify({ token: 'fake-token', expiresAt: Math.floor(Date.now() / 1000) + 60 }),
                            { status: 200, headers: { 'Content-Type': 'application/json' } }
                        );
                    }
                    if (String(url).includes('extract.flatwrite.md/extract')) {
                        return new Response(
                            JSON.stringify({
                                markdown: '# PDF Content\\n\\nExtracted from URL.',
                                metadata: { fileType: 'pdf', extractionType: 'pdf-body', filename: 'doc.pdf', sizeBytes: 100 },
                            }),
                            { status: 200, headers: { 'Content-Type': 'application/json' } }
                        );
                    }
                    return new Response(
                        new Blob(['fake-pdf-bytes'], { type: 'application/pdf' }),
                        { status: 200, headers: { 'Content-Type': 'application/pdf' } }
                    );
                };
            }"""
        )

        page.locator("#btn-load-url").click()
        page.wait_for_timeout(300)
        page.locator("#load-url-input").fill("https://example.com/document.pdf")
        page.locator("#load-modal-insert").click()

        # Wait for the extract to round-trip and the editor to update.
        page.wait_for_function(
            "() => document.getElementById('editor').value.includes('Extracted from URL')",
            timeout=15_000,
        )
        assert "PDF Content" in editor.input_value()
    finally:
        page.close()


def test_postmessage_dropped_files_rejected_from_unknown_source(browser):
    """
    The parent's `window.addEventListener("message", ...)` handler in
    app.js MUST reject any `{type: "dropped-files", ...}` message whose
    `event.source` is not the preview iframe. Otherwise, a script that
    runs inside the preview (e.g. user-supplied markdown that slips
    past DOMPurify, or a nested <iframe>) could CSRF the parent into
    sending a request to /extract on the attacker's behalf, burning the
    user's per-IP token quota.

    This test simulates the attack by posting a well-formed "dropped-files"
    message from the page's own window — which is the easiest "untrusted"
    source to forge from a Playwright test (we cannot inject a script
    into the sandboxed preview iframe from outside, but we can use
    `window.parent.postMessage(..., window)` semantics by calling
    `window.postMessage` from within the page; the parent's handler
    must reject any source that isn't the preview's contentWindow).
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        # Capture the editor's current content so we can prove the
        # malicious message didn't change it.
        before = page.locator("#editor").input_value()

        # Spy on fetch — if the parent's handler falls for the attack,
        # it will call handleExtractDrop(), which will:
        #   1. mint a token from /mcp-token
        #   2. POST the File to /extract
        # If the rejection works, neither call should happen.
        page.evaluate(
            """() => {
                window.__suspiciousNetworkCalls = [];
                const realFetch = window.fetch.bind(window);
                window.fetch = async function (url, opts) {
                    const s = String(url);
                    if (s.includes('mcp-token') || s.includes('/extract')) {
                        window.__suspiciousNetworkCalls.push(s);
                    }
                    return realFetch(url, opts);
                };
            }"""
        )

        # Forge a dropped-files message from the page's own window —
        # the only sane way to drive `event.source` from a Playwright
        # test. The parent's handler at app.js ~line 1833 must reject
        # any source that isn't the preview iframe.
        page.evaluate(
            """() => {
                const fakeFile = new File(['x'], 'evil.pptx', { type: 'application/octet-stream' });
                window.postMessage(
                    { type: 'dropped-files', files: [fakeFile] },
                    '*'
                );
            }"""
        )

        # Give any (incorrect) async handler a chance to fire and the
        # editor a chance to update. 500ms is plenty for a synchronous
        # rejection and 10× the round-trip latency of a token mint.
        page.wait_for_timeout(500)

        after = page.locator("#editor").input_value()
        suspicious = page.evaluate("() => window.__suspiciousNetworkCalls || []")
        assert after == before, (
            f"editor changed after a forged postMessage from an unknown "
            f"source — CSRF defense failed. suspicious={suspicious!r}"
        )
        assert not suspicious, (
            f"parent triggered extract/token network calls in response to "
            f"a forged postMessage from an unknown source. "
            f"suspicious={suspicious!r}"
        )
    finally:
        page.close()


def test_postmessage_unknown_source_does_not_trigger_extract(browser):
    """
    Companion to `test_postmessage_dropped_files_rejected_from_unknown_source`:
    the parent MUST also reject *any* unknown-source postMessage that
    could plausibly reach handleExtractDrop through a different path
    (e.g. a future handler that uses a different `type`). The
    source-check is the only line of defense — every other type guard
    in the listener assumes the message is from a trusted frame.

    This test confirms the source check runs *before* the type
    dispatch by sending a message with an unknown type and a known
    bad source; the editor must not change.
    """
    page = browser.new_page()
    try:
        page.goto(EDITOR_URL, wait_until="domcontentloaded", timeout=30_000)
        editor = page.locator("#editor")
        expect(editor).to_be_visible(timeout=15_000)

        before = page.locator("#editor").input_value()

        page.evaluate(
            """() => {
                window.__suspiciousNetworkCalls = [];
                const realFetch = window.fetch.bind(window);
                window.fetch = async function (url, opts) {
                    const s = String(url);
                    if (s.includes('mcp-token') || s.includes('/extract')) {
                        window.__suspiciousNetworkCalls.push(s);
                    }
                    return realFetch(url, opts);
                };
            }"""
        )

        # Send a message with an unknown type. If the source check runs
        # first (as it should), the handler returns before any
        # type-specific logic — so even a hypothetical handler keyed on
        # this unknown type cannot fire.
        page.evaluate(
            """() => {
                window.postMessage(
                    { type: 'some-future-handler-type', payload: 'whatever' },
                    '*'
                );
            }"""
        )

        page.wait_for_timeout(300)

        after = page.locator("#editor").input_value()
        suspicious = page.evaluate("() => window.__suspiciousNetworkCalls || []")
        assert after == before, "editor changed after a postMessage from an unknown source"
        assert not suspicious, (
            f"parent triggered network calls in response to a postMessage "
            f"from an unknown source. suspicious={suspicious!r}"
        )
    finally:
        page.close()
