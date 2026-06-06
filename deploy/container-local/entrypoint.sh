#!/bin/sh
# agentmemory local Podman entrypoint.
#
# Runs as the unprivileged `node` user (switched via USER in Dockerfile).
# Directory creation, config injection, ownership, and static env vars
# are handled at build time in the Dockerfile.
#
# This script:
#   1. Generates the HMAC secret on first boot and persists it to
#      /secrets/.hmac so the secret survives restarts.
#   2. Exports AGENTMEMORY_SECRET (must be runtime since it reads from volume).
#   3. Execs the agentmemory CLI.

set -eu

SECRETS_DIR="${AGENTMEMORY_SECRETS_DIR:-/secrets}"
HMAC_FILE="${SECRETS_DIR}/.hmac"

# Generate HMAC secret on first boot, persist to secrets volume
if [ ! -s "$HMAC_FILE" ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' "$SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"
  echo "[agentmemory] HMAC secret generated and stored in secrets volume."
fi

AGENTMEMORY_SECRET="$(cat "$HMAC_FILE")"
export AGENTMEMORY_SECRET

# Enable all tools server-side so the MCP shim exposes the full set
export AGENTMEMORY_TOOLS="${AGENTMEMORY_TOOLS:-all}"

# Bind the viewer to 0.0.0.0 inside the container so the port mapping works
export AGENTMEMORY_VIEWER_HOST="${AGENTMEMORY_VIEWER_HOST:-0.0.0.0}"

# Trusted Host headers for the viewer's DNS-rebinding defence
export VIEWER_ALLOWED_HOSTS="${VIEWER_ALLOWED_HOSTS:-localhost:3113,127.0.0.1:3113}"

exec agentmemory "$@"
