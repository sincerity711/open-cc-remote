#!/usr/bin/env bash
# Demo: bring up the full open-cc-remote stack so you can play with a real
# channel-permission flow against a tmux-driven claude session.
#
# Layout after this script returns:
#   - docker:  hub (host:17745 → container:7745) + fake-ias  (e2e-real/docker-compose.yml + .demo.yml)
#   - host:    daemon (paired, daemon_id=demo-1) under /tmp/cc-remote-demo/
#   - host:    PWA dev server (15173) — open in your browser
#   - host:    tmux session 'demo-claude' running real claude with channel
#
# Talk to claude:   tmux attach -t demo-claude
# Watch the PWA:    open http://localhost:15173/
# Stop everything:  tools/demo-channel.sh stop

set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_STATE_DIR="/tmp/cc-remote-demo"
TMUX_NAME="demo-claude"
DAEMON_LOG="${DEMO_STATE_DIR}/daemon.log"
PWA_LOG="${DEMO_STATE_DIR}/pwa.log"
DAEMON_ID="demo-1"
HUB_HOST_PORT=17745
PWA_HOST_PORT=15173

# Optional --otel: bring up Jaeger all-in-one and export OTel env to all
# spawned children. Disabled by default. Filtered out before the
# start/stop dispatch below so the rest of the script stays unchanged.
WITH_OTEL=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--otel" ]]; then WITH_OTEL=1; else ARGS+=("$a"); fi
done
set -- "${ARGS[@]+${ARGS[@]}}"

if [[ "$WITH_OTEL" == "1" ]]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
  export VITE_OTEL_ENABLED="1"
  export VITE_OTEL_COLLECTOR_URL="http://localhost:4318"
fi

_t0=$(date +%s)
_t_prev=$_t0
_step() {
  local now elapsed_total elapsed_step
  now=$(date +%s)
  elapsed_total=$((now - _t0))
  elapsed_step=$((now - _t_prev))
  _t_prev=$now
  printf '[+%3ds Δ%2ds] %s\n' "$elapsed_total" "$elapsed_step" "$*"
}

stop() {
  echo "[demo] stopping..."
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  pkill -F "${DEMO_STATE_DIR}/daemon.pid" 2>/dev/null || true
  pkill -F "${DEMO_STATE_DIR}/pwa.pid" 2>/dev/null || true
  (cd e2e-real && docker compose -f docker-compose.yml -f docker-compose.demo.yml down -v --remove-orphans -t 5 2>&1) | tail -3 || true
  (cd e2e-real && docker compose -f docker-compose.otel.yml down -v --remove-orphans -t 5 2>&1) | tail -3 || true
  echo "[demo] stopped."
}

if [[ "${1:-start}" == "stop" ]]; then
  stop
  exit 0
fi

# Hard reset any prior demo state.
stop || true
mkdir -p "$DEMO_STATE_DIR"

# Pick a hostname that reaches fake-ias from BOTH the hub container AND a
# host-side browser. Two strategies, in priority order:
#   1) Mac LAN IP (10.x / 192.168.x): fast, no setup, BUT may be blocked by
#      firewall on some networks. Probe by opening a temporary listener and
#      curling back to the IP.
#   2) /etc/hosts entry "127.0.0.1 cc-ias-demo": works on any network, but
#      requires sudo. We refuse to start without it as a fallback.
HOST_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [[ -z "${HOST_IP}" ]]; then
  HOST_IP=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}')
fi
ISSUER_HOST=""
if [[ -n "${HOST_IP}" ]]; then
  ISSUER_HOST="${HOST_IP}"
  echo "[demo] using LAN IP ${HOST_IP} for IAS issuer"
elif grep -qE '^[^#]*\s+cc-ias-demo(\s|$)' /etc/hosts; then
  ISSUER_HOST="cc-ias-demo"
  echo "[demo] no LAN IP detected; using /etc/hosts cc-ias-demo entry"
else
  cat <<'EOF' >&2

[demo] Cannot detect a LAN IP and /etc/hosts has no cc-ias-demo entry.
       The OIDC callback flow needs ONE of them. One-time setup:

         echo '127.0.0.1 cc-ias-demo' | sudo tee -a /etc/hosts

EOF
  exit 2
fi
export ISSUER_HOST

_step "bringing up hub + fake-ias (compose)..."
if [[ "$WITH_OTEL" == "1" ]]; then
  (cd e2e-real && ISSUER_HOST="${ISSUER_HOST}" docker compose -f docker-compose.otel.yml up -d --wait)
  echo "[demo] Jaeger UI: http://localhost:16686"
  (cd e2e-real && ISSUER_HOST="${ISSUER_HOST}" docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.otel-hub.yml up -d --wait)
else
  (cd e2e-real && ISSUER_HOST="${ISSUER_HOST}" docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --wait)
fi

_step "issuing pairing code..."
PAIR_CODE=$(cd e2e-real && docker compose -f docker-compose.yml -f docker-compose.demo.yml exec -T hub \
  bun run /app/packages/hub/src/admin.ts issue-pairing-code i060912@sap.com "$DAEMON_ID" | tr -d '[:space:]')
echo "[demo] pairing code: $PAIR_CODE"

_step "writing daemon config..."
cat > "${DEMO_STATE_DIR}/config.json" <<EOF
{
  "daemon_id": "$DAEMON_ID",
  "hub_url": "ws://localhost:${HUB_HOST_PORT}",
  "allow_kill": true,
  "allow_start": true,
  "allowed_cwd_prefix": ["${DEMO_STATE_DIR}", "/tmp", "${HOME}"],
  "spawn_command": "claude --mcp-config ${DEMO_STATE_DIR}/mcp-config.json --dangerously-load-development-channels server:cc-remote",
  "idle_window_ms": 3000
}
EOF

_step "starting daemon..."
CC_REMOTE_STATE_DIR="$DEMO_STATE_DIR" \
  bun run packages/daemon/src/index.ts \
  > "$DAEMON_LOG" 2>&1 &
echo $! > "${DEMO_STATE_DIR}/daemon.pid"
sleep 2

_step "pairing daemon..."
CC_REMOTE_STATE_DIR="$DEMO_STATE_DIR" \
  bun run packages/daemon/bin/cc-remote.ts pair \
  --hub "http://localhost:${HUB_HOST_PORT}" --code "$PAIR_CODE" --daemon-id "$DAEMON_ID"

# `pair` rewrites config.json down to {daemon_id, hub_url}. Re-emit the rich
# config so allow_start / spawn_command / etc. survive the pair step.
_step "re-writing daemon config (post-pair)..."
cat > "${DEMO_STATE_DIR}/config.json" <<EOF
{
  "daemon_id": "$DAEMON_ID",
  "hub_url": "ws://localhost:${HUB_HOST_PORT}",
  "allow_kill": true,
  "allow_start": true,
  "allowed_cwd_prefix": ["${DEMO_STATE_DIR}", "/tmp", "${HOME}"],
  "spawn_command": "claude --mcp-config ${DEMO_STATE_DIR}/mcp-config.json --dangerously-load-development-channels server:cc-remote",
  "idle_window_ms": 3000
}
EOF

_step "restarting daemon (paired identity)..."
pkill -F "${DEMO_STATE_DIR}/daemon.pid" 2>/dev/null || true
sleep 1
CC_REMOTE_STATE_DIR="$DEMO_STATE_DIR" \
  bun run packages/daemon/src/index.ts \
  > "$DAEMON_LOG" 2>&1 &
echo $! > "${DEMO_STATE_DIR}/daemon.pid"
sleep 2

_step "writing mcp-config for the plugin..."
cat > "${DEMO_STATE_DIR}/mcp-config.json" <<EOF
{
  "mcpServers": {
    "cc-remote": {
      "command": "bun",
      "args": ["run", "$(pwd)/packages/plugin/src/index.ts"],
      "env": { "CC_REMOTE_SOCKET": "${DEMO_STATE_DIR}/daemon.sock" }
    }
  }
}
EOF

_step "starting PWA dev server (vite, port ${PWA_HOST_PORT})..."
# Subshell `&` rather than `& inside subshell` — the latter makes the
# subshell wait on its background child before exiting, which hangs the
# whole script because vite never exits.
(cd packages/pwa && exec env VITE_HUB_URL="ws://localhost:${HUB_HOST_PORT}" \
  bun run dev -- --port "${PWA_HOST_PORT}" --strictPort) > "$PWA_LOG" 2>&1 &
echo $! > "${DEMO_STATE_DIR}/pwa.pid"
sleep 3

_step "starting tmux claude session ($TMUX_NAME)..."
tmux new-session -d -s "$TMUX_NAME" -x 200 -y 50 -c "$DEMO_STATE_DIR"
# Use either ANTHROPIC_API_KEY or the AUTH_TOKEN/BASE_URL pair (whichever the user has).
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  AUTH_PREFIX="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
elif [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" && -n "${ANTHROPIC_BASE_URL:-}" ]]; then
  AUTH_PREFIX="ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN} ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}"
else
  echo "[demo] WARN: no ANTHROPIC_API_KEY / AUTH_TOKEN+BASE_URL in env; claude will likely error on first prompt"
  AUTH_PREFIX=""
fi
tmux send-keys -t "$TMUX_NAME" \
  "${AUTH_PREFIX} claude --mcp-config ${DEMO_STATE_DIR}/mcp-config.json --dangerously-load-development-channels server:cc-remote --model claude-haiku-4-5 --setting-sources project,local --allowedTools 'mcp__cc-remote__reply'" Enter

# Auto-dismiss the same boot dialogs that helpers/claude-tmux.ts handles in
# the e2e suite, so a fresh `tmux attach -t demo-claude` lands directly on
# the prompt instead of blocking on the dev-channels confirmation.
dismiss_dialog() {
  local pattern="$1"
  local timeout_s="$2"
  local end=$(( $(date +%s) + timeout_s ))
  while [[ $(date +%s) -lt $end ]]; do
    if tmux capture-pane -t "$TMUX_NAME" -p 2>/dev/null | grep -qE "$pattern"; then
      sleep 0.4   # let the dialog settle so the Enter is consumed by the right state
      tmux send-keys -t "$TMUX_NAME" Enter
      return 0
    fi
    sleep 0.3
  done
  return 1
}

_step "auto-dismissing claude boot dialogs..."
dismiss_dialog "Enter to confirm|local development" 20 || \
  echo "[demo] WARN: dev-channels dialog not seen; CC version drift?"
dismiss_dialog "trust.*workspace|trust.*folder|safety check|created or one you trust" 8 || \
  true   # workspace-trust is per-cwd and may already be remembered

# Wait for the interactive `❯` prompt to appear.
_step "waiting for claude prompt..."
end=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $end ]]; do
  if tmux capture-pane -t "$TMUX_NAME" -p 2>/dev/null | grep -qE "❯"; then
    break
  fi
  sleep 0.3
done

_step "ready"

cat <<EOF

=========================================================================
 [demo] all up. play time.

   1) PWA           open  http://localhost:${PWA_HOST_PORT}/  in your browser
                    click "Login" → fake-IAS auto-redirects → you land in PWA
                    you should see daemon "demo-1" with no sessions yet

   2) claude        tmux attach -t demo-claude
                    dismiss the dev-channels confirmation (press Enter)
                    dismiss workspace-trust if it shows  (press Enter)
                    type a prompt that needs a tool, e.g.:
                      Run the bash command: rm /tmp/cc-remote-demo/scratch.txt
                    (touch the file first if you want a real rm:
                       echo hi > /tmp/cc-remote-demo/scratch.txt )

   3) channel       in the PWA, an amber permission banner appears
                    Allow / Deny — claude continues / refuses accordingly

 detach tmux:        Ctrl-b then d
 stop all:           tools/demo-channel.sh stop

 ports:
   hub HTTP/WSS:     localhost:${HUB_HOST_PORT}
   PWA dev server:   localhost:${PWA_HOST_PORT}

 logs:
   daemon:  tail -f /tmp/cc-remote-demo/daemon.log
   pwa:     tail -f /tmp/cc-remote-demo/pwa.log
=========================================================================
EOF
