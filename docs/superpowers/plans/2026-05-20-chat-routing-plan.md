# Chat routing — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (TDD-flavored). Each task has a "write failing test → make it pass → commit" cycle.

Source of truth: `docs/superpowers/specs/2026-05-20-chat-routing-design.md`. Closes the chat loop deferred by `plan-plugin-mcp-rework`.

---

## Task 1: proto frames

**Files:**
- Modify: `packages/proto/src/frames.ts`
- Modify: `packages/proto/tests/frames.test.ts` (or create if absent)

- [ ] **Step 1**: Add `PwaToHubChatSend`, `HubToDaemonChatSend`, `PwaChatBroadcast`, `HubChatErrorBroadcast` interfaces per spec §4. Extend the four discriminated unions: add `PwaToHubChatSend` to `PwaToHub`; add `PwaChatBroadcast` and `HubChatErrorBroadcast` to `HubToPwa`; add `HubToDaemonChatSend` to `HubToDaemon`; add `PluginChatOut` to `DaemonToHub` if not already there (existing plugin↔daemon `chat_out`).

- [ ] **Step 2 (TDD)**: write/extend tests for the discriminator — round-trip JSON serialize/parse asserts type narrowing.

- [ ] **Step 3**: Run `bun test packages/proto && bun run --filter='@cc-remote/*' typecheck`. Both must pass.

- [ ] **Step 4: Commit**
```
feat(proto): chat-routing frames (PWA↔Hub, Hub↔Daemon)
```

---

## Task 2: daemon chat translation

**Files:**
- Create: `packages/daemon/src/chat.ts`
- Modify: `packages/daemon/src/index.ts` (wire chat.ts into the daemon's hub-frame and plugin-frame handlers)
- Create: `packages/daemon/tests/chat.test.ts`

- [ ] **Step 1 (TDD)**: write failing test in `packages/daemon/tests/chat.test.ts`:
  - In-process mock plugin Unix socket + mock hub WS
  - Test A: hub sends `chat_send {session_id, message_id, user, user_id, content, reply_to, ts}` → plugin socket receives `chat_in` with matching fields
  - Test B: plugin sends `chat_out {session_id, content, ts, reply_to}` → hub WS receives `chat_out` with same fields
  - Test C: hub sends `chat_send` for unknown session_id → daemon stderr logs warning, no plugin write, no crash

- [ ] **Step 2**: implement `packages/daemon/src/chat.ts`:
```ts
export function handleHubChatSend(frame: HubToDaemonChatSend, pluginSockets: Map<string, PluginSocket>): void;
export function handlePluginChatOut(frame: PluginChatOut, hub: HubConnection): void;
```
Both pure-routing: lookup session, translate frame type, write to other side. Read existing daemon source for the patterns used by permission relay (`packages/daemon/src/index.ts`).

- [ ] **Step 3**: wire into `index.ts` — add `chat_send` to the hub-inbound switch, add `chat_out` to the plugin-inbound switch.

- [ ] **Step 4**: run `bun test packages/daemon`. New tests + existing pass.

- [ ] **Step 5: Commit**
```
feat(daemon): chat-send / chat-out translation between hub and plugin
```

---

## Task 3: hub routing

**Files:**
- Modify: `packages/hub/src/router.ts` (or wherever the WS frame switch lives — likely `routes.ts` for the /ws/pwa handler and `router.ts` for the broadcast logic)
- Modify: `packages/hub/tests/router.test.ts`

- [ ] **Step 1 (TDD)**: extend tests:
  - chat_send from PWA → mock daemon receives `HubToDaemonChatSend` with `message_id` set, `user`/`user_id` from bearer, `ts` populated
  - chat_send from PWA → all PWA subscribers (the sender too) receive `chat` broadcast with `from: "pwa"` and correct user
  - chat_out from daemon → all PWA subscribers receive `chat` broadcast with `from: "claude"` and a freshly-generated `message_id`
  - chat_send to offline daemon → sender PWA receives `chat_error` with `reason`
  - bearer → user/user_id resolution comes from existing pwa-auth helper (do not re-implement)

- [ ] **Step 2**: implement routing:
  - Add ULID generator helper (`packages/hub/src/ulid.ts`) — small, no extra dep (use `crypto.randomBytes` + base32 encode, or pull a tiny inline impl)
  - Add `chat_send` case in PWA WS message handler: lookup daemon, gen message_id+ts, forward to daemon WS, broadcast echo
  - Add `chat_out` case in daemon WS message handler: gen message_id, broadcast to PWAs

- [ ] **Step 3**: run `bun test packages/hub`. All green.

- [ ] **Step 4: Commit**
```
feat(hub): route chat between PWA and daemon, broadcast both directions
```

---

## Task 4: PWA UI

**Files:**
- Modify: `packages/pwa/src/ws.ts` (rename happens to be `useHub.ts` per import — read it first to confirm location of the WS hook)
- Modify: `packages/pwa/src/SessionPane.tsx`
- Modify: `packages/pwa/src/App.tsx` if needed for prop wiring
- Optional: new file `packages/pwa/src/ChatComposer.tsx` if extraction reads cleanly

- [ ] **Step 1**: read `packages/pwa/src/ws.ts` to find the WS hook (`useHub`). Add to its returned shape:
  - `chatMessages: Record<string, PwaChatBroadcast[]>` keyed by `eventKey(daemon_id, session_id)`
  - `sendChat(daemon_id, session_id, content, reply_to?)` function
  - Frame handler: on incoming `chat`, append to the bucket

- [ ] **Step 2**: in `SessionPane.tsx`, add a chat composer + log section per spec §7. Minimal styling, matches existing event-stream colors.

- [ ] **Step 3**: TDD-where-feasible — PWA tests are sparse in this repo. Skip unit tests for the UI; rely on the e2e in Task 5/6.

- [ ] **Step 4**: typecheck (`bun run --filter=@cc-remote/pwa typecheck`).

- [ ] **Step 5: Commit**
```
feat(pwa): chat composer + chat log per session
```

---

## Task 5: in-process e2e (fake-claude)

**Files:**
- Create: `e2e/chat.test.ts`
- Possibly modify: `tools/fake-claude/fake-claude.ts` to add a `--reply-on-chat` flag that auto-emits `chat_out` when it receives a `chat_in`. (Or: parameterize via env var.)

- [ ] **Step 1**: extend fake-claude with an auto-reply-on-chat hook. New flag: `--auto-reply <text>` → on every `chat_in` received, emit `chat_out` with `content: text`. Used by the new test.

- [ ] **Step 2 (TDD)**: write `e2e/chat.test.ts`:
  - Boot daemon + hub + fake-claude with `--auto-reply "pong"`
  - PWA-equivalent client connects, subscribes
  - Client sends `chat_send {daemon_id, session_id, content: "ping"}`
  - Assert: client receives `chat` broadcast with `from: "pwa", content: "ping"` (echo)
  - Assert: client receives `chat` broadcast with `from: "claude", content: "pong"` within 2s

- [ ] **Step 3**: run `bun test e2e/`. All pass.

- [ ] **Step 4: Commit**
```
test(e2e): chat round-trip (fake-claude auto-reply)
```

---

## Task 6: real e2e (tmux + real claude)

**Files:**
- Create: `e2e-real/tests/12-chat-roundtrip.test.ts`

- [ ] **Step 1**: pattern matches existing e2e-real scenarios. Pair daemon, restart, connect PWA-equivalent, start claude under tmux with the standard helpers/claude-tmux invocation.

- [ ] **Step 2 (TDD)**: write the test:
  - PWA sends chat_send `"please reply with the word ACK using the reply tool"`
  - Wait for chat broadcast `from: "pwa"` (echo, ~immediate)
  - Wait for chat broadcast `from: "claude"` containing `"ACK"` (real claude turn, up to 60s)
  - Both timing-bounded; failure includes capture-pane in error

- [ ] **Step 3**: run individually: `bun test e2e-real/tests/12-chat-roundtrip.test.ts`. Then full suite: `bun test e2e-real/`.

- [ ] **Step 4: Commit**
```
test(e2e-real): 12 chat roundtrip (real claude reply tool)
```

---

## Task 7: final verification

- [ ] **Step 1**: `bun test packages/` — all green (target 154+ pass; new tests in proto, daemon, hub).

- [ ] **Step 2**: `bun test e2e/` — all green (existing + new chat.test.ts).

- [ ] **Step 3**: `bun test e2e-real/` — 13 pass (was 12, now +1 chat scenario), under ~6.5 min wall time.

- [ ] **Step 4**: `bun run typecheck` — clean across all 6 workspace packages.

- [ ] **Step 5**: update `docs/TODO.md` with chat-routing done; update root README with a one-liner mentioning chat capability.

- [ ] **Step 6: Commit + tag**
```
docs: chat routing done; tag plan-chat-routing
git tag plan-chat-routing
```

---

## Self-Review

| Spec section | Plan task |
|---|---|
| §3 flow | Tasks 1–4 |
| §4 frames | Task 1 |
| §5 hub routing | Task 3 |
| §6 daemon translation | Task 2 |
| §7 PWA UI | Task 4 |
| §8 tests | Tasks 2 (daemon), 3 (hub), 5 (e2e), 6 (e2e-real) |
| §9 open questions | Documented inline; no blocker |

TDD framing: every code change has its test in the same task. Granularity: one task per layer. The daemon and hub tasks are tightest (most logic); PWA is mostly UI; e2e tasks are full integration.
