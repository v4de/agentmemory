#!/usr/bin/env bash
# agentmemory local container setup (Podman or Docker)
# Builds the image, creates volumes, starts the container, and prints
# the MCP config snippet for your chosen client.
#
# The HMAC secret is generated inside the container on first boot and
# stored in a dedicated secrets volume. The shim container mounts that
# same volume read-only. The secret never leaves the volume layer.
#
# Usage:
#   cd deploy/container-local
#   ./setup.sh                           # auto-detect engine, show all configs
#   ./setup.sh podman mcp-gateway
#   ./setup.sh docker vscode
#   ./setup.sh auto claude-code
#
# Arguments:
#   $1 - Engine: auto (default), podman, docker
#   $2 - Client: all (default), mcp-gateway, vscode, claude-code, cursor, kiro, codex

set -euo pipefail

ENGINE="${1:-auto}"
CLIENT="${2:-all}"

# --- Detect container engine ---
if [ "$ENGINE" = "auto" ]; then
    if command -v podman >/dev/null 2>&1; then
        ENGINE="podman"
    elif command -v docker >/dev/null 2>&1; then
        ENGINE="docker"
    else
        echo "ERROR: Neither podman nor docker found on PATH. Install one and retry." >&2
        exit 1
    fi
fi

echo "Using container engine: $ENGINE"

IMAGE_NAME="agentmemory"
CONTAINER_NAME="agentmemory"
DATA_VOLUME="agentmemory-data"
SECRETS_VOLUME="agentmemory-secrets"
SHIM_IMAGE_NAME="agentmemory-mcp-shim"
REST_PORT=3111
VIEWER_PORT=3113

# Podman requires --load; docker does not.
LOAD_FLAG=""
if [ "$ENGINE" = "podman" ]; then
    LOAD_FLAG="--load"
fi

echo ""
echo "=== Building agentmemory server image ==="
$ENGINE build $LOAD_FLAG -t "$IMAGE_NAME" -f Dockerfile .

echo ""
echo "=== Building MCP shim image (for gateway backend) ==="
$ENGINE build $LOAD_FLAG -t "$SHIM_IMAGE_NAME" -f Dockerfile.mcp-shim .

echo ""
echo "=== Creating persistent volumes ==="
for vol in "$DATA_VOLUME" "$SECRETS_VOLUME"; do
    if $ENGINE volume inspect "$vol" >/dev/null 2>&1; then
        echo "Volume already exists: $vol"
    else
        $ENGINE volume create "$vol"
        echo "Created volume: $vol"
    fi
done

# Stop existing container if running
if $ENGINE ps -a --filter "name=^${CONTAINER_NAME}$" --format "{{.ID}}" 2>/dev/null | grep -q .; then
    echo ""
    echo "=== Stopping existing container ==="
    $ENGINE rm -f "$CONTAINER_NAME"
fi

echo ""
echo "=== Starting agentmemory container ==="
$ENGINE run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${REST_PORT}:3111" \
    -p "127.0.0.1:${VIEWER_PORT}:3113" \
    -v "${DATA_VOLUME}:/data" \
    -v "${SECRETS_VOLUME}:/secrets" \
    "$IMAGE_NAME"

echo ""
echo "=== Waiting for startup ==="
healthy=false
for i in $(seq 1 15); do
    if curl -sf --max-time 3 "http://localhost:${REST_PORT}/agentmemory/livez" >/dev/null 2>&1; then
        healthy=true
        break
    fi
    sleep 4
done

if [ "$healthy" = true ]; then
    echo "agentmemory is healthy!"
else
    echo "WARNING: Health check failed. Check logs with: $ENGINE logs $CONTAINER_NAME"
fi

# Determine the host address containers use to reach the host
if [ "$ENGINE" = "podman" ]; then
    HOST_ADDR="host.containers.internal"
else
    HOST_ADDR="host.docker.internal"
fi

echo ""
echo "================================================================"
echo "agentmemory is running!"
echo "  Engine:    $ENGINE"
echo "  REST API:  http://localhost:$REST_PORT"
echo "  Viewer:    http://localhost:$VIEWER_PORT"
echo "  Secret:    inside '$SECRETS_VOLUME' volume (never leaves volume layer)"
echo "================================================================"

# --- Client config printers ---

# Shared printer for clients using the { "mcpServers": { ... } } shape
# (Claude Code, Cursor, Kiro, Windsurf)
print_mcpservers_json() {
    local label="$1"
    local filepath="$2"
cat <<EOF

=== $label ===

{
  "mcpServers": {
    "agentmemory": {
      "command": "$ENGINE",
      "args": [
        "run", "--rm", "-i",
        "-e", "AGENTMEMORY_URL=http://${HOST_ADDR}:${REST_PORT}",
        "-v", "${SECRETS_VOLUME}:/run/secrets:ro",
        "$SHIM_IMAGE_NAME"
      ]
    }
  }
}

  File: $filepath
EOF
}

print_gateway_config() {
cat <<EOF

=== MCP Gateway (gateway.yaml under servers:) ===

  agentmemory:
    transport: stdio
    command: $ENGINE
    args:
      - run
      - --rm
      - -i
      - -e
      - AGENTMEMORY_URL=http://${HOST_ADDR}:${REST_PORT}
      - -v
      - ${SECRETS_VOLUME}:/run/secrets:ro
      - $SHIM_IMAGE_NAME
    description: "Agent persistent memory — save, recall, search, sessions"
    enabled: true

  File: ~/.mcp-gateway/gateway.yaml
EOF
}

print_vscode_config() {
cat <<EOF

=== VS Code / GitHub Copilot (.vscode/mcp.json) ===

{
  "servers": {
    "agentmemory": {
      "command": "$ENGINE",
      "args": [
        "run", "--rm", "-i",
        "-e", "AGENTMEMORY_URL=http://${HOST_ADDR}:${REST_PORT}",
        "-v", "${SECRETS_VOLUME}:/run/secrets:ro",
        "$SHIM_IMAGE_NAME"
      ]
    }
  }
}

  File: .vscode/mcp.json (workspace) or ~/.vscode/mcp.json (global)
EOF
}

print_codex_config() {
cat <<EOF

=== Codex CLI (~/.codex/config.toml) ===

# Option 1: codex mcp add
codex mcp add agentmemory -- $ENGINE run --rm -i -e AGENTMEMORY_URL=http://${HOST_ADDR}:${REST_PORT} -v ${SECRETS_VOLUME}:/run/secrets:ro $SHIM_IMAGE_NAME

# Option 2: manual TOML (~/.codex/config.toml)
[mcp_servers.agentmemory]
command = "$ENGINE"
args = ["run", "--rm", "-i", "-e", "AGENTMEMORY_URL=http://${HOST_ADDR}:${REST_PORT}", "-v", "${SECRETS_VOLUME}:/run/secrets:ro", "$SHIM_IMAGE_NAME"]

  File: ~/.codex/config.toml
EOF
}

echo ""
echo "=== Client MCP Configuration ==="

case "$CLIENT" in
    mcp-gateway)  print_gateway_config ;;
    vscode)       print_vscode_config ;;
    claude-code)  print_mcpservers_json "Claude Code (~/.claude.json)" "~/.claude.json" ;;
    cursor)       print_mcpservers_json "Cursor (~/.cursor/mcp.json)" "~/.cursor/mcp.json" ;;
    kiro)         print_mcpservers_json "Kiro (~/.kiro/settings/mcp.json)" "~/.kiro/settings/mcp.json (user) or .kiro/settings/mcp.json (workspace)" ;;
    codex)        print_codex_config ;;
    all)
        print_gateway_config
        print_mcpservers_json "Claude Code (~/.claude.json)" "~/.claude.json"
        print_vscode_config
        print_mcpservers_json "Cursor (~/.cursor/mcp.json)" "~/.cursor/mcp.json"
        print_mcpservers_json "Kiro (~/.kiro/settings/mcp.json)" "~/.kiro/settings/mcp.json (user) or .kiro/settings/mcp.json (workspace)"
        print_codex_config
        ;;
    *)
        echo "Unknown client: $CLIENT"
        echo "Valid options: all, mcp-gateway, vscode, claude-code, cursor, kiro, codex"
        exit 1
        ;;
esac

echo ""
echo "NOTE: The secret lives only in the '$SECRETS_VOLUME' volume."
echo "      Both the server and shim mount it — no secret in config files or env vars."
echo "      To rotate: $ENGINE volume rm $SECRETS_VOLUME && re-run this script."

echo ""
echo "=== To verify ==="
echo "  curl http://localhost:${REST_PORT}/agentmemory/livez"
echo "  $ENGINE logs $CONTAINER_NAME"
echo ""
