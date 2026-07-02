#!/usr/bin/env bash
#
# deploy.sh — deploy the flatwrite-extract Cloudflare Worker.
#
# Why this script exists:
# wrangler 4.x auto-discovers config files by walking UP from the cwd.
# The repo root has a `wrangler.jsonc` declaring a different Worker
# (the `flatwrite` static-site project, with `assets.directory = "public"`
# and `name = "flatwrite"`). When wrangler runs from this directory,
# it would otherwise merge that parent config in and deploy to the
# wrong Worker.
#
# We force wrangler to use ONLY the local `wrangler.toml` with the
# `--config wrangler.toml` flag. That keeps the deploy isolated from
# the parent's static-site config.
#
# We also temporarily stash `public/_redirects` because wrangler
# *additionally* scans the workspace for static files to upload, and
# the `_redirects` SPA-fallback rule trips CF's upload validator
# ("Infinite loop detected [code: 100324]") even when the script
# itself is unrelated. The stash is restored on exit.
#
# Required environment / setup:
#   - wrangler 4.x (at $REPO_ROOT/node_modules/.bin/wrangler)
#   - secrets set on the Worker:
#       API_KEY              — browser-facing
#       INTERNAL_EXTRACT_KEY — shared with the Fly service
#   - the Fly service at $UPSTREAM_URL has the SAME INTERNAL_EXTRACT_KEY
#
# Usage:
#   ./deploy.sh
#
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
WORKER_DIR="$REPO_ROOT/workers/flatwrite-extract"
PUBLIC_DIR="$REPO_ROOT/public"
REDIRECTS="$PUBLIC_DIR/_redirects"
STASH="$(mktemp -d)/_redirects"

cleanup() {
  if [ -f "$STASH" ] && [ ! -f "$REDIRECTS" ]; then
    echo "→ restoring public/_redirects"
    mv "$STASH" "$REDIRECTS"
  fi
}
trap cleanup EXIT INT TERM

if [ -f "$REDIRECTS" ]; then
  echo "→ temporarily stashing public/_redirects → $STASH"
  mv "$REDIRECTS" "$STASH"
fi

cd "$WORKER_DIR"
echo "→ running wrangler deploy (with --config to bypass parent wrangler.jsonc)"
"$REPO_ROOT/node_modules/.bin/wrangler" deploy --config wrangler.toml

# Restore happens via the EXIT trap above.
