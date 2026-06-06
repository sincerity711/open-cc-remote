# WS Heartbeat Design — PWA ↔ hub and daemon ↔ hub

**Status**: draft, awaiting user review
**Origin**: `docs/research/aionui-comparison.md` borrow-list item #6.
**Related**: `docs/TODO.md` "AionUi 借鉴 6 项".

---

## Problem

Both long-lived WebSockets (`PWA ↔ hub`, `daemon ↔ hub`) currently have **zero application-level heartbeat**. `grep -E 'ping|heartbeat|setInterval' packages/{pwa,hub,daemon}/src` returns 0 hits in `useHub.ts`, `hub-client.ts`, and `routes.ts`'s websocket handler.

Reconnect logic exists on the client side (PWA: exponential backoff 500ms → 10s + frameless-open guard at `useHub.ts:689`; daemon: identical pattern at `hub-client.ts:34-46`). It works **only if `ws.onclose` fires** — i.e. the underlying TCP connection produces a FIN/RST. Two failure modes do NOT produce a close event:

1. **NAT idle eviction** — mobile carrier NAT (~5 min) and corporate NAT (~30 min) silently drop the connection's flow table entry. Both ends still hold an `OPEN` socket. Client `ws.send()` writes succeed locally (TCP buffers), bytes are black-holed at the NAT.
2. **Reverse-proxy idle timeout** — nginx default 60s, k8s ingress 60s, cloudflare 100s. These produce a close eventually, but the time window between "actually idle" and "RST received" can be tens of seconds during which messages are silently lost.

Daemon ↔ hub is **more exposed than PWA ↔ hub** — daemon is a long-running background process, can sit minutes idle between user prompts. PWA is exposed when the browser tab is foregrounded but mostly silent (user is reading).

## Decision

Add symmetric application-level ping/pong on **both** WebSocket links.

- **Client → Server**: PWA and daemon emit `{type:"ping"}` every **25 seconds**. Server replies `{type:"pong"}` immediately.
- **Client watchdog**: if 45 seconds elapse since the last received pong, client calls `ws.close()` to trigger existing reconnect logic.
- **Server watchdog**: hub tracks `lastFrameAt` per WS; if no frame (any kind) in 45 seconds, hub calls `ws.close()`.

The client watchdog catches NAT eviction. The server watchdog catches client crashes that don't FIN (kernel hard-kill, power off). Both watchdogs are necessary; they are not redundant.

### Parameter justification

| Parameter | Value | Why |
|---|---|---|
| Ping interval | **25s** | Below nginx 60s default with comfortable margin (35s buffer). 40% less traffic than 15s alternative. |
| Watchdog timeout | **45s** | Allows missing one ping (25s) plus 20s grace. Two consecutive missed pings = dead. |
| Server scan cadence | **5s** | Cheap iteration over all sockets; 5s granularity acceptable for a 45s timeout. |

NAT carrier 5-min timeout and CDN 60s timeout are both safely covered.

## Frame schema

Add to `packages/proto/src/frames.ts`:

```ts
export interface PingFrame { type: "ping" }
export interface PongFrame { type: "pong" }
```

Add `PingFrame` to **both** `PwaToHub` and `DaemonToHub` (clients send ping).
Add `PongFrame` to **both** `HubToPwa` and `HubToDaemon` (server sends pong).

Frames are intentionally payload-free — no timestamps, no sequence numbers. Heartbeat is a liveness probe, not a latency monitor; adding fields invites scope creep.

## Implementation contract

### Client side (PWA + daemon, identical algorithm)

State per active WS:
```
let lastPongAt = Date.now()  // initialize to now on open
let timer: Timer | null = null
```

On `ws.onopen`:
```
lastPongAt = Date.now()
timer = setInterval(tick, 25_000)
```

`tick()`:
```
if (ws.readyState !== OPEN) return
if (Date.now() - lastPongAt > 45_000) {
  ws.close()  // existing reconnect logic takes over
  return
}
ws.send(JSON.stringify({type: "ping"}))
```

On `ws.onmessage`, before existing dispatch:
```
if (frame.type === "pong") { lastPongAt = Date.now(); return }
```

On `ws.onclose`:
```
if (timer !== null) { clearInterval(timer); timer = null }
```

**Critical**: `tick()` does both the ping send AND the watchdog check on the same `setInterval`. Do NOT split into two timers. Reason: when a browser tab is backgrounded, throttled `setInterval` slows ping AND watchdog symmetrically. A separate fast watchdog timer would fire while ping was throttled and produce false-positive disconnects on tab resume.

### Server side (hub, both `/ws/daemon` and `/ws/pwa`)

State per active WS (extend `WsData`):
```ts
type WsData = {
  kind: "daemon" | "pwa"
  key: string
  user?: string
  user_id?: string
  lastFrameAt: number  // NEW
}
```

In `websocket.message`, before dispatching to router:
```ts
ws.data.lastFrameAt = Date.now()
const text = typeof msg === "string" ? msg : msg.toString("utf8")
let frame: unknown
try { frame = JSON.parse(text) } catch { ws.close(1003, "bad json"); return }
if ((frame as { type?: string }).type === "ping") {
  ws.send(JSON.stringify({ type: "pong" }))
  return  // do not pass to router
}
// existing dispatch unchanged
```

In `websocket.open`, set `lastFrameAt = Date.now()` on the data object.

Server watchdog (start once at `Bun.serve` time, e.g. in `hub/src/index.ts`):
```ts
setInterval(() => {
  const cutoff = Date.now() - 45_000
  for (const { ws, data } of allConnections()) {
    if (data.lastFrameAt < cutoff) {
      try { ws.close(1011, "heartbeat timeout") } catch {}
    }
  }
}, 5_000)
```

`allConnections()` — iterate `daemonReg` and `pwaReg` together. Each registry already tracks the ws object; expose an iterator method.

## File-by-file changes

| File | Change |
|---|---|
| `packages/proto/src/frames.ts` | Add `PingFrame` + `PongFrame` types; extend `PwaToHub` `DaemonToHub` `HubToPwa` `HubToDaemon` unions. |
| `packages/proto/src/index.ts` | Re-export the two new types. |
| `packages/pwa/src/hooks/useHub.ts` | Add `lastPongAt` + `setInterval` in the connect closure (around line 660-688). Handle `frame.type === "pong"` in `ws.onmessage` (around line 671). |
| `packages/daemon/src/hub-client.ts` | Symmetric to PWA: `lastPongAt`, ping interval, pong handler in `ws.addEventListener("message", ...)`. |
| `packages/hub/src/routes.ts` | Extend `WsData` with `lastFrameAt`; intercept `ping` in `websocket.message` before dispatch; set `lastFrameAt` on every message; init `lastFrameAt` in `websocket.open`. |
| `packages/hub/src/connections.ts` | Add `iterAll()` (or similar) so the watchdog loop can scan both registries. |
| `packages/hub/src/index.ts` | Wire the 5-second watchdog `setInterval` after `Bun.serve` boot. |

Net: ~120 lines added across 6 files. No deletions.

## Out of scope

- **Latency reporting** — pong is bare. If we want client-perceived RTT later, add `ts` field; not now.
- **Adaptive intervals** — could throttle ping when frames are flowing recently, but added complexity is not justified for current scale.
- **Server-initiated ping** — relying on client-driven ping is sufficient because the client watchdog is what detects NAT death; making hub also ping doubles traffic without solving an unsolved failure mode.
- **WebSocket protocol-level ping (`ws.ping()`)** — Bun's `ServerWebSocket` exposes it, but it is opaque to the JSON frame protocol and would require parallel handling on PWA (browser WebSocket cannot programmatically send protocol-level pings). Application-level frames keep both ends symmetric.

## Testing strategy

Unit tests (PWA + daemon):
- Mock `setInterval` / `Date.now()`. Open ws, advance 25s, assert ping sent. Advance another 25s without pong, assert ws.close() called. Send pong, advance, assert connection survives.
- After ws.close() / reconnect, assert `lastPongAt` resets and timer recreated.

Unit tests (hub):
- Send a frame, advance < 45s, assert no close. Advance > 45s with no frame, assert close fired. Send a ping, assert pong response, assert frame NOT forwarded to router.

Integration test (e2e-real or hub-testing):
- Connect a real WS client, do not send anything, observe that hub closes after ~45s.
- Send pings at 25s intervals, observe pongs received and connection stays open for 5+ minutes.

The "real NAT eviction" test is impossible to automate — accept that the unit + integration coverage exercises the same code paths.

## Migration / compatibility

- **Old client + new server**: server's 45s watchdog will close idle connections that have not sent any frame in 45s. Old client reconnects via existing logic. Realistically: an old PWA still sends `subscribe` on every reconnect and `permission_reply` / `chat_send` on user activity, so it only gets evicted during true silent idle (which is exactly when CDN timeouts would kill it anyway). Net: arguably an improvement (faster reaction); no regression.
- **New client + old server**: client sends ping, server doesn't reply. Client watchdog fires after 45s, closes, reconnects against the new server.

→ No deployment ordering constraint. Either side can roll first. New PWA with old hub will reconnect every 45s until hub upgrades — annoying, not broken.

## Acceptance criteria

1. `grep -E 'ping|heartbeat' packages/{pwa,hub,daemon}/src` returns matches in all three packages.
2. Hub log shows pong response counts roughly = (active connections) × 2.4/min.
3. After artificially blackholing a client (e.g. pkill -STOP on daemon), hub closes the daemon's WS within 45s and the daemon entry leaves `daemonReg`.
4. After NAT eviction simulation (drop client→server packets via firewall rule), client `useHub.connected` flips false within 45s and reconnect kicks in.
5. No existing test regresses.

## Open questions

None. Parameters and algorithm are decided. Spec is implementation-ready.
