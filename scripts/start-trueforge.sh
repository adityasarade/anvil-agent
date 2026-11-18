#!/bin/sh
# Starts TrueForge in local mode for Anvil (npm run trueforge).
#
#  - HOST=127.0.0.1: the default "localhost" binds IPv6 only on macOS, so 127.0.0.1 would be refused.
#  - OUTBOUND_URL_ALLOWED_HOSTS: TrueForge's SSRF guard blocks loopback URLs; Anvil's editor MCP
#    server (and an optional local model) live on 127.0.0.1.
#  - TURN_PAUSED_KEEPALIVE_SECONDS=3600: keep the stream open while the user reviews a diff.
#  - MCP_REQUEST_TIMEOUT_MS=600000: long-running run_command calls (tests) are not cut at 120 s.
#
# Override the port with PORT=8790 (default). Pass-through: any other TrueForge env var.
set -eu

PORT="${PORT:-8790}"
export PORT
export HOST="${HOST:-127.0.0.1}"
export OUTBOUND_URL_ALLOWED_HOSTS="${OUTBOUND_URL_ALLOWED_HOSTS:-[\"127.0.0.1\",\"localhost\"]}"
export TURN_PAUSED_KEEPALIVE_SECONDS="${TURN_PAUSED_KEEPALIVE_SECONDS:-3600}"
export MCP_REQUEST_TIMEOUT_MS="${MCP_REQUEST_TIMEOUT_MS:-600000}"

echo "Starting TrueForge 0.185.1 on http://${HOST}:${PORT} (UI: http://${HOST}:${PORT}/ , API docs: /api/v1/docs)"
exec npx -y @truefoundry/trueforge@0.185.1 "$@"
