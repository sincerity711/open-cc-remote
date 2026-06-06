# WS Heartbeat Implementation Plan

**Spec**: `docs/superpowers/specs/2026-06-06-ws-heartbeat-design.md`
**Branch**: `feat/ws-heartbeat` (already created, spec committed at `84aeb23`)
**Tag for `bin/save-ai-rambling`**: `plan-ws-heartbeat`

## Reconciliation with current code

The spec assumed payload-free `{type:"ping"}` / `{type:"pong"}`. Reality (`packages/proto/src/frames.ts:132,149`):

```ts
DaemonToHub: ... | { type: "pong"; ts: number } | ...
HubToDaemon: ... | { type: "ping"; ts: number } | ...
```

Both are dead code — hub never sends ping (grep `packages/hub/src/router.ts` confirms only the receive case at `:194` `case "pong": return;`), daemon never replies. PWA ↔ hub has zero ping/pong types.

**Decision**: keep the existing `{ type, ts }` shape. The spec said `ts` was out-of-scope but harmless — and the existing schema is already there. The `pong` handler in router.ts stays but becomes correct (we'll wire daemon side to actually send pong in response to a hub ping… **wait — re-read spec**).

**Spec direction is the opposite**: client sends ping, server replies pong. So the existing types are **backwards** for our design. Two options:

1. **Add new types** in the right direction:
   - `PwaToHub`/`DaemonToHub`: `{type:"ping",ts:number}`
   - `HubToPwa`/`HubToDaemon`: `{type:"pong",ts:number}`
   - Keep existing `HubToDaemon.ping` and `DaemonToHub.pong` to not break the `case "pong"` — but they become unreferenced.

2. **Flip the existing types**:
   - Move `{type:"ping",ts}` from `HubToDaemon` → `DaemonToHub`/`PwaToHub`
   - Move `{type:"pong",ts}` from `DaemonToHub` → `HubToDaemon`/`HubToPwa`
   - Delete the dead `case "pong"` in router.

**Choosing (2)**: cleaner, removes dead code, matches the spec's "client-driven ping" decision. The router's `case "pong"` was sized for "if a daemon someday replies pong to our ping" — that direction was never used and is gone now.

## Steps

Each step is independently testable. Run `bun test` after every step.

---

### Step 1 — proto: flip direction of ping/pong unions

**Files**: `packages/proto/src/frames.ts`

- Remove `{ type: "pong"; ts: number }` from `DaemonToHub` (line 132)
- Remove `{ type: "ping"; ts: number }` from `HubToDaemon` (line 149)
- Add `{ type: "ping"; ts: number }` to `DaemonToHub` and `PwaToHub`
- Add `{ type: "pong"; ts: number }` to `HubToDaemon` and `HubToPwa`

**Verify**: `bunx tsc --noEmit -p packages/proto` clean. `bun test packages/proto` pass.

---

### Step 2 — hub: handle inbound ping → emit pong, track lastFrameAt, server watchdog

**Files**:
- `packages/hub/src/routes.ts`
- `packages/hub/src/connections.ts`
- `packages/hub/src/router.ts` (delete dead pong case)
- `packages/hub/src/index.ts` (start watchdog)

Changes:

1. `routes.ts:12` — extend `WsData`:
   ```ts
   interface WsData { kind: WsKind; key: string; user?: string; user_id?: string; lastFrameAt: number; }
   ```
   Initialize `lastFrameAt: Date.now()` at every `ws.data = { ... }` call site (3 sites: line 286 daemon upgrade, line 390 pwa upgrade — ws.data is set on `Response` upgrade, plus the reassignment at line 409 in `websocket.open`).

2. `routes.ts websocket.message` (currently line 412-446) — first lines of handler:
   ```ts
   ws.data.lastFrameAt = Date.now();
   const text = typeof msg === "string" ? msg : msg.toString("utf8");
   let frame: unknown;
   try { frame = JSON.parse(text); } catch { ws.close(1003, "bad json"); return; }
   if ((frame as { type?: string }).type === "ping") {
     const ts = (frame as { ts?: number }).ts ?? Date.now();
     ws.send(JSON.stringify({ type: "pong", ts }));
     return;
   }
   // existing dispatch unchanged
   ```
   The `ts` field is echoed back so the client could compute RTT later if it cared.

3. `routes.ts websocket.open` — already runs once, set `ws.data.lastFrameAt = Date.now()` before registering. (For pwa branch: the existing reassignment at line 409 already creates a fresh `ws.data`, so set lastFrameAt there.)

4. `connections.ts` — add iterator:
   ```ts
   // DaemonRegistry
   *iterAll(): Generator<W> { for (const e of this.entries.values()) yield e.ws; }
   // PwaRegistry — same
   ```

5. `router.ts:194` — delete the `case "pong":` branch entirely (now unreachable; pong is HubToDaemon, never received from daemon).

6. `index.ts` — wire the watchdog. **Problem**: `daemonReg` and `pwaReg` are scoped inside `makeServer`, not exposed. Cleanest: have `makeServer` return a `closeStaleConnections()` helper or expose the registries.

   Decision: `makeServer` returns one more thing — `startHeartbeatWatchdog(intervalMs, timeoutMs)` that returns a cancel handle. `index.ts` calls it after `Bun.serve`:

   ```ts
   const { fetch, websocket, startHeartbeatWatchdog } = makeServer({...});
   const server = Bun.serve({...});
   const stopWatchdog = startHeartbeatWatchdog(5_000, 45_000);
   process.on("SIGTERM", () => { stopWatchdog(); ... });
   ```

   Inside `routes.ts`:
   ```ts
   function startHeartbeatWatchdog(intervalMs: number, timeoutMs: number) {
     const handle = setInterval(() => {
       const cutoff = Date.now() - timeoutMs;
       for (const ws of daemonReg.iterAll()) {
         if (ws.data.lastFrameAt < cutoff) {
           try { ws.close(1011, "heartbeat timeout"); } catch {}
         }
       }
       for (const ws of pwaReg.iterAll()) {
         if (ws.data.lastFrameAt < cutoff) {
           try { ws.close(1011, "heartbeat timeout"); } catch {}
         }
       }
     }, intervalMs);
     return () => clearInterval(handle);
   }
   ```

**Tests** (extend existing hub tests if any, else add `packages/hub/src/heartbeat.test.ts`):
- Connect a fake daemon/pwa ws, send a ping frame, assert pong response, assert it didn't reach router.
- After `lastFrameAt` is artificially backdated past cutoff, run the watchdog manually and assert `ws.close` was called.
- Confirm any non-ping frame still flows to router (regression).

---

### Step 3 — daemon: send ping every 25s, watchdog 45s on missing pong

**Files**: `packages/daemon/src/hub-client.ts`

Add inside the `connect()` async function in `startHubClient`:

```ts
let lastPongAt = Date.now();
let pingTimer: ReturnType<typeof setInterval> | null = null;

const tick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastPongAt > 45_000) {
    try { ws.close(); } catch {}
    return;
  }
  ws.send(JSON.stringify({ type: "ping", ts: Date.now() } satisfies DaemonToHub));
};
```

In `ws.addEventListener("open", ...)`:
```ts
lastPongAt = Date.now();
if (pingTimer !== null) clearInterval(pingTimer);
pingTimer = setInterval(tick, 25_000);
```

In `ws.addEventListener("message", (ev) => { ... })`:
- Parse JSON first (already does)
- Before passing to `opts.onFrame`, check:
  ```ts
  if (parsed && typeof parsed === "object" && (parsed as {type?:string}).type === "pong") {
    lastPongAt = Date.now();
    return;
  }
  ```

In `ws.addEventListener("close", scheduleReconnect)`: also clear the pingTimer:
```ts
ws.addEventListener("close", () => {
  if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
  scheduleReconnect();
});
```

**Tests**: add `packages/daemon/src/hub-client.test.ts` if not present (or extend existing) — use `vi.useFakeTimers()`:
- Open a fake WS, advance 25s, assert `ws.send` called with `{type:"ping"}`.
- Reply with `{type:"pong",ts:...}`, advance 50s, assert connection still open.
- Don't reply, advance 50s, assert `ws.close()` called.

---

### Step 4 — PWA: send ping every 25s, watchdog 45s

**Files**: `packages/pwa/src/hooks/useHub.ts`

Inside the `connect` closure (around line 644-728), add:

```ts
let lastPongAt = Date.now();
let pingTimer: ReturnType<typeof setInterval> | null = null;
```

`ws.onopen` (around line 660-670):
```ts
lastPongAt = Date.now();
if (pingTimer !== null) clearInterval(pingTimer);
pingTimer = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastPongAt > 45_000) {
    try { ws.close(); } catch {}
    return;
  }
  ws.send(JSON.stringify({ type: "ping", ts: Date.now() } satisfies PwaToHub));
}, 25_000);
```

`ws.onmessage` (around line 671): before the `apply(frame)` call:
```ts
const frame = JSON.parse(ev.data) as HubToPwa;
if (frame.type === "pong") { lastPongAt = Date.now(); return; }
// existing fs_list_result short-circuit + apply unchanged
```

Inside `reconnect` and the cleanup `return () => { ... }`:
```ts
if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
```

**Tests**: add `packages/pwa/src/hooks/useHub.heartbeat.test.ts` (or extend existing) with vitest fake timers:
- Mock WebSocket, simulate open, advance 25s, assert send was called with ping.
- Receive pong, advance 50s, assert close not called.
- Don't receive pong, advance 50s, assert close called.

---

### Step 5 — manual smoke + verification

1. `bun test` — full suite passes.
2. Start hub locally: `cd packages/hub && bun src/index.ts` (or via demo-channel.sh).
3. Start daemon: it should connect; tail daemon stderr; verify `ping` doesn't appear in the unknown-frame logs (router.ts has implicit `default`? — verify).
4. Stop hub mid-flight; daemon's `lastPongAt` will go stale; verify after 45s the daemon closes its ws and reconnects (via existing scheduleReconnect).
5. Open PWA, F12 console; observe periodic `ping → pong` ws frames (Network tab WS messages).
6. Block hub responses (e.g. `kill -STOP <hub pid>`); after 45s PWA's `connected` flag should flip false (visible in `<StatusDot>`).

### Step 6 — commit + push

Single commit per step? Or bundle? **Bundle**: spec is small, 4 implementation steps fit one logical change. Commit message:

```
feat(ws-heartbeat): add ping/pong heartbeat on PWA ↔ hub and daemon ↔ hub

Spec: docs/superpowers/specs/2026-06-06-ws-heartbeat-design.md

- proto: flip ping/pong direction (client-driven). PwaToHub + DaemonToHub
  carry ping; HubToPwa + HubToDaemon carry pong.
- hub: intercept ping in websocket.message, echo pong; track lastFrameAt
  per ws; 5s watchdog closes connections idle > 45s.
- daemon: send ping every 25s on hub-client connection; reconnect if no
  pong in 45s.
- PWA: same as daemon, in useHub.ts connect closure.

Closes the silent-NAT-eviction failure mode (carrier NAT 5min,
corporate NAT 30min) which previously left ws.send dropping into a
black hole until a user-triggered frame happened to fail.
```

(Don't push automatically; let user push.)

## Risk register

| Risk | Mitigation |
|---|---|
| `bun test` for PWA hooks needs fake-timer setup that's not yet in the repo | Check existing `useHub.test.ts` first; copy its harness or fall back to a thin test |
| Hub `case "pong"` deletion breaks router type narrowing if some union path expected it | TypeScript will catch — react if compile fails |
| Old PWA + new hub: PWA never pings, hub watchdog kills it after 45s on idle. Old PWA reconnects, but the cycle costs a frame. **Acceptance**: rare in practice (PWAs always send `subscribe` on reconnect, then user activity); mentioned in spec migration section. | accepted |
| ws.data type shape change cascades to all 3 ws.data assignment sites | grep `satisfies WsData` and update each one. TS will catch missed sites. |

## Estimate

- Step 1 (proto): 5 min
- Step 2 (hub): 30 min, mostly tests
- Step 3 (daemon): 20 min
- Step 4 (PWA): 20 min
- Step 5 (smoke): 10 min
- Step 6 (commit): 2 min

Total: ~90 min, plus test debugging budget ~30 min → 2 hours wall-clock.
