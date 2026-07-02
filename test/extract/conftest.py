"""
Pytest conftest — make `flatwrite_extract` importable regardless of whether
the editable install's .pth file has a trailing newline (uv's editable
installs have shipped with a missing-newline bug in some versions).

The right place to add the source directory to sys.path is the test suite's
own conftest, so we don't have to touch the venv.
"""
from __future__ import annotations

import sys
from pathlib import Path

# /test/extract/conftest.py → /services/extract/src
_SRC = Path(__file__).resolve().parents[2] / "services" / "extract" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
