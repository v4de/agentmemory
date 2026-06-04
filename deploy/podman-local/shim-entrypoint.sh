#!/bin/sh
# Read AGENTMEMORY_SECRET from mounted file if available,
# otherwise fall back to the environment variable.
set -eu

SECRET_FILE="${AGENTMEMORY_SECRET_FILE:-/run/secrets/.hmac}"

if [ -f "$SECRET_FILE" ]; then
  AGENTMEMORY_SECRET="$(cat "$SECRET_FILE")"
  export AGENTMEMORY_SECRET
fi

exec agentmemory-mcp "$@"
