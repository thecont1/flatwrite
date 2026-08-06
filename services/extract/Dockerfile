FROM python:3.12-slim

# System packages for the AnyDoc-backed extract service.
# firecrawl-anydoc ships platform wheels with bundled native libraries,
# so only ca-certificates and curl (for uv install) are needed.
# rapidocr-onnxruntime depends on opencv-python, which needs libGL and
# related X11 shared libraries at runtime (headless — no X server needed).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libgl1 \
        libglib2.0-0 \
        libxcb1 \
        libsm6 \
        libxext6 \
        libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# Install uv (single binary, pinned to a known-good version).
ENV UV_VERSION=0.9.16
RUN curl -fsSL https://astral.sh/uv/${UV_VERSION}/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv

WORKDIR /app

# Copy only the project metadata first so the dependency layer caches.
COPY pyproject.toml uv.lock* ./

# --frozen requires uv.lock; we don't ship one yet (first deploy), so fall
# back to `uv sync --no-dev` if the lock is missing. This keeps the image
# buildable in CI without committing the lock.
RUN if [ -f uv.lock ]; then \
        uv sync --frozen --no-dev --no-install-project; \
    else \
        uv sync --no-dev --no-install-project; \
    fi

# Now copy the source and install the project itself (no deps, just the wheel).
COPY src ./src
RUN uv sync --no-dev --no-install-project \
    && uv pip install --no-deps .

# Drop privileges.
RUN useradd --create-home --shell /bin/bash app \
    && chown -R app:app /app
USER app

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# uvicorn is installed via the `[standard]` extra in pyproject.toml.
CMD ["uvicorn", "flatwrite_extract.main:app", "--host", "0.0.0.0", "--port", "8000"]
