#!/usr/bin/env bash
# Demo: bring up the full open-cc-remote stack so you can play with a real
# channel-permission flow against a tmux-driven claude session.
#
# Layout after this script returns:
#   - docker:  hub (7745) + fake-ias  (e2e-real/docker-compose.yml + .demo.yml)
#   - host:    daemon (paired, daemon_id=demo-1) under /tmp/cc-remote-demo/
#   - host:    PWA dev server (5173) — open in your browser
#   - host:    tmux session 'demo-claude' running real claude with channel
#
# Talk to claude:   tmux attach -t demo-claude
# Watch the PWA:    open http://localhost:5173/
# Stop everything:  tools/demo-channel.sh stop

set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_STATE_DIR="/tmp/cc-remote-demo"
TMUX_NAME="demo-claude"
DAEMON_LOG="${DEMO_STATE_DIR}/daemon.log"
PWA_LOG="${DEMO_STATE_DIR}/pwa.log"
DAEMON_ID="demo-1"

stop() {
  echo "[demo] stopping..."
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  pkill -F "${DEMO_STATE_DIR}/daemon.pid" 2>/dev/null || true
  pkill -F "${DEMO_STATE_DIR}/pwa.pid" 2>/dev/null || true
  (cd e2e-real && docker compose -f docker-compose.yml -f docker-compose.demo.yml down -v --remove-orphans -t 5 2>&1) | tail -3 || true
  echo "[demo] stopped."
}

if [[ "${1:-start}" == "stop" ]]; then
  stop
  exit 0
fi

# Hard reset any prior demo state.
stop || true
mkdir -p "$DEMO_STATE_DIR"

echo "[demo] bringing up hub + fake-ias (compose)..."
(cd e2e-real && docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --wait)

echo "[demo] issuing pairing code..."
PAIR_CODE=$(cd e2e-real && docker compose -f docker-compose.yml -f docker-compose.demo.yml exec -T hub \
  bun run /app/packages/hub/src/admin.ts issue-pairing-code i060912@sap.com "$DAEMON_ID" | tr -d '[:space:]')
echo "[demo] pairing code: $PAIR_CODE"

echo "[demo] writing daemon config..."
cat > "${DEMO_STATE_DIR}/config.json" <<EOF
{
  "daemon_id": "$DAEMON_ID",
  "hub_url": "ws://localhost:7745",
  "allow_kill": true,
  "allow_start": false,
  "allowed_cwd_prefix": ["${DEMO_STATE_DIR}", "/tmp"],
  "idle_window_ms": 30000
}
EOF

echo "[demo] starting daemon..."
CC_REMOTE_STATE_DIR="$DEMO_STATE_DIR" \
  bun run packages/daemon/src/index.ts \
  > "$DAEMON_LOG" 2>&1 &
echo $! > "${DEMO_STATE_DIR}/daemon.pid"
sleep 2

echo "[demo] pairing daemon..."
CC_REMOTE_STATE_DIR="$DEMO_STATE_DIR" \
  bun run packages/daemon/bin/cc-remote.ts pair \
  --hub http://localhost:7745 --code "$PAIR_CODE" --daemon-id "$DAEMON_ID"

echo "[demo] restarting daemon (pick up paired identity)..."
pkill -F "${DEMO_STATE_DIR}/daemon.pid" 2>/dev/null || true
sleep 1
CC_REMOTE_STATE_DIR="$DEMO_STATE_DIR" \
  bun run packages/daemon/src/index.ts \
  > "$DAEMON_LOG" 2>&1 &
echo $! > "${DEMO_STATE_DIR}/daemon.pid"
sleep 2

echo "[demo] writing mcp-config for the plugin..."
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

echo "[demo] starting PWA dev server (vite, port 5173)..."
(cd packages/pwa && bun run dev > "$PWA_LOG" 2>&1 &
 echo $! > "${DEMO_STATE_DIR}/pwa.pid")
sleep 3

echo "[demo] starting tmux claude session ($TMUX_NAME)..."
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
  "${AUTH_PREFIX} claude --mcp-config ${DEMO_STATE_DIR}/mcp-config.json --dangerously-load-development-channels server:cc-remote --model claude-haiku-4-5 --setting-sources project,local" Enter

cat <<'EOF'

=========================================================================
 [demo] all up. play time.

   1) PWA           open http://localhost:5173/  in your browser
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

 logs:
   daemon:  tail -f /tmp/cc-remote-demo/daemon.log
   pwa:     tail -f /tmp/cc-remote-demo/pwa.log
=========================================================================
EOF
