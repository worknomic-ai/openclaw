#!/bin/bash
set -euo pipefail

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/data/.openclaw}"

# First boot: generate default config if none exists
if [ ! -f "$CONFIG_DIR/openclaw.json" ]; then
  echo "[clawsy] First boot detected. Generating default config..."
  mkdir -p "$CONFIG_DIR/agents" "$CONFIG_DIR/skills" "$CONFIG_DIR/memory" "$CONFIG_DIR/logs"

  # Copy default config template
  cp /app/dist/default-config/openclaw.json.tmpl "$CONFIG_DIR/openclaw.json"

  # Substitute environment variables into config
  sed -i "s|\${OPENCLAW_GATEWAY_TOKEN}|${OPENCLAW_GATEWAY_TOKEN:-changeme}|g" "$CONFIG_DIR/openclaw.json"
  sed -i "s|\${OPENCLAW_GATEWAY_PORT}|${OPENCLAW_GATEWAY_PORT:-18789}|g" "$CONFIG_DIR/openclaw.json"

  echo "[clawsy] Default config generated at $CONFIG_DIR/openclaw.json"
fi

# Ensure clawsy plugin is loaded
echo "[clawsy] Starting OpenClaw gateway..."
exec node /app/dist/index.js \
  --config-dir "$CONFIG_DIR" \
  --gateway-port "${OPENCLAW_GATEWAY_PORT:-18789}" \
  --gateway-bind "${OPENCLAW_GATEWAY_BIND:-lan}"
