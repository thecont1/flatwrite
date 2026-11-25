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
# Environments:
# The worker converts in-process with WASM — there is no upstream
# service and no INTERNAL_EXTRACT_KEY anymore. The production route
# (`extract.flatwrite.md/*`) lives ONLY in [env.production] because
# wrangler inherits top-level `route` into named environments — a bare
# `--env staging` deploy would otherwise steal the production route.
# This script therefore ALWAYS passes an explicit --env flag:
#
#   ./deploy.sh                    → production (default)
#   ./deploy.sh --env production   → production (explicit)
#   ./deploy.sh --env staging      → workers.dev-only copy named
#                                    flatwrite-extract-staging
#
# Required environment / setup:
#   - wrangler 4.x (at $REPO_ROOT/node_modules/.bin/wrangler)
#   - secrets set on the Worker, once per environment:
#       wrangler secret put API_KEY --env production
#       wrangler secret put API_KEY --env staging
#
# Usage:
#   ./deploy.sh [--env production|staging]
#
set -euo pipefail

# Parse the optional --env passthrough. Anything other than
# `--env <name>` or `--env=<name>` is rejected so a typo can't deploy
# to the wrong target.
ENV_NAME="production"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      shift
      if [ "$#" -eq 0 ]; then
        echo "error: --env requires a value (production|staging)" >&2
        exit 1
      fi
      ENV_NAME="$1"
      ;;
    --env=*)
      ENV_NAME="${1#--env=}"
      ;;
    *)
      echo "error: unknown argument '$1' (only --env is supported)" >&2
      exit 1
      ;;
  esac
  shift
done

# Validate the resolved value itself — an empty `--env ""` or a typo like
# `--env prod` must never reach wrangler, where it would create or deploy
# to an unintended environment.
if [ "$ENV_NAME" != "production" ] && [ "$ENV_NAME" != "staging" ]; then
  echo "error: invalid environment '$ENV_NAME' (must be production|staging)" >&2
  exit 1
fi

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
echo "→ running wrangler deploy --env $ENV_NAME (with --config to bypass parent wrangler.jsonc)"
# Local-dev convenience: pass ALLOWED_DEV_ORIGINS via the CLI so the
# Worker accepts requests from http://127.0.0.1:8080 etc. Defaults to
# empty (production-safe). Override with:
#   ALLOWED_DEV_ORIGINS=http://127.0.0.1:8080 ./deploy.sh
"${REPO_ROOT}/node_modules/.bin/wrangler" deploy \
  --config wrangler.toml \
  --env "$ENV_NAME" \
  --var "ALLOWED_DEV_ORIGINS:${ALLOWED_DEV_ORIGINS:-}"

# Restore happens via the EXIT trap above.
