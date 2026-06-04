#!/bin/sh
# agentmemory local Podman entrypoint.
#
# Runs as root so it can:
#   1. Overwrite the npm-bundled iii-config.yaml with a deploy-tuned
#      version that binds 0.0.0.0 and uses absolute /data paths.
#   2. chown the Podman-mounted /data volume to the runtime user.
#   3. Generate the HMAC secret on first boot and persist it to
#      /data/.hmac (chmod 600) so the secret survives restarts.
#
# Then execs the agentmemory CLI as the unprivileged `node` user.

set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
SECRETS_DIR="${AGENTMEMORY_SECRETS_DIR:-/secrets}"
HMAC_FILE="${SECRETS_DIR}/.hmac"
RUN_AS="node:node"
III_CONFIG="/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml"

mkdir -p "$DATA_DIR" "$SECRETS_DIR"
chown -R "$RUN_AS" "$DATA_DIR"
chown -R "$RUN_AS" "$SECRETS_DIR"

# Write deploy-tuned iii config: binds 0.0.0.0, absolute /data paths
cat > "$III_CONFIG" <<'EOF'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins:
          - "http://localhost:3111"
          - "http://localhost:3113"
          - "http://127.0.0.1:3111"
          - "http://127.0.0.1:3113"
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/stream_store
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 0.1
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: false
  - name: iii-exec
    config:
      watch:
        - src/**/*.ts
      exec:
        - node dist/index.mjs
EOF
chown "$RUN_AS" "$III_CONFIG"

# Generate HMAC secret on first boot, persist to secrets volume
if [ ! -s "$HMAC_FILE" ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' "$SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"
  chown "$RUN_AS" "$HMAC_FILE"
  echo "[agentmemory] HMAC secret generated and stored in secrets volume."
fi

AGENTMEMORY_SECRET="$(cat "$HMAC_FILE")"
export AGENTMEMORY_SECRET

# Enable all 53 tools server-side so the MCP shim exposes the full set
export AGENTMEMORY_TOOLS="${AGENTMEMORY_TOOLS:-all}"

exec gosu "$RUN_AS" agentmemory "$@"
