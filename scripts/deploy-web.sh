#!/usr/bin/env bash
# =============================================================================
# scripts/deploy-web.sh — build the Vite bundle off-box + ship it to the VPS.
# =============================================================================
# Serves opta.fyi from the Vultr box (144.202.58.6, same box as crank+sb-create).
# Build is OFF-box (the app's package-lock drifts → `npm ci` fails; use
# --legacy-peer-deps). Run from a machine with the Windows SSH key on PATH
# (Git Bash / WSL-with-key). VITE_POSTHOG_KEY + VITE_RPC_URL must be in app/.env*
# at build time (Vite bakes them in).
#
#   bash scripts/deploy-web.sh
# =============================================================================
set -euo pipefail

HOST="${OPTA_WEB_HOST:-root@144.202.58.6}"
DEST="${OPTA_WEB_DEST:-/opt/opta-web/dist}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/app"
npm install --legacy-peer-deps      # lockfile drift — never `npm ci`
npm run build                        # → app/dist

# Ship: clean the remote dir (drop stale hashed assets), then stream the fresh
# build. Uses tar-over-ssh (no rsync dependency; works from Git Bash).
ssh "$HOST" "mkdir -p '$DEST' && rm -rf '$DEST'/*"
tar -czf - -C dist . | ssh "$HOST" "tar -xzf - -C '$DEST'"

# Static swap needs no reload; validate + reload only to be safe (no-op if clean).
ssh "$HOST" 'nginx -t && systemctl reload nginx'
echo "deployed → https://opta.fyi"
