# Loading Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA shows clear loading feedback for every outbound command (chat, start session, history, permission reply, kill) and clears it only when the matching confirmation, failure, or 30s timeout arrives — without optimistic local state.

**Architecture:** Centralize outbound command pending state in `useHub`. A new in-memory `pendingCommands` registry is keyed by a per-command id (`client_message_id`, `request_id`, or a local kill key). Components read selectors from `useHub` and render spinners / "X not confirmed" UI accordingly. Protocol gains a `client_message_id` field on `chat_send` / `chat` / `chat_error` and an optional `request_id` on `session_open` so the PWA can correlate with the originating start_session.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), React 19, Tailwind, shadcn/ui buttons, `@cc-remote/proto` shared types.

---

## File Structure

**Modified:**
- `packages/proto/src/frames.ts` — add `client_message_id` (chat_send/chat/chat_error) and optional `request_id` (session_open).
- `packages/proto/tests/frames.test.ts` — type round-trip tests for new fields.
- `packages/hub/src/router.ts` — forward `client_message_id` and `session_open.request_id` end-to-end.
- `packages/hub/tests/router.test.ts` — assertions for the new round-trips.
- `packages/daemon/src/index.ts` — track pending start_sessions; attach request_id to `session_open` when a registered session matches a pending request by cwd.
- `packages/daemon/tests/` — new unit test for the pending-start tracker (created in Task 5).
- `packages/pwa/src/hooks/useHub.ts` — introduce `pendingCommands` registry, `setTimeout`-based timeouts, lifecycle wiring per command kind, and selector helpers.
- `packages/pwa/tests/useHub.test.ts` — state-model tests for each command kind (create, confirm, fail, timeout).
- `packages/pwa/src/screens/SessionView.tsx` — remove local message queue, show "Sending message…" pending row, disable composer while pending, show timeout error.
- `packages/pwa/tests/SessionView.test.tsx` — assertions for the new visible states.
- `packages/pwa/src/screens/HomeScreen.tsx` — disable cwd input + plus button while a start is pending, show "Starting session…" inline text, show timeout error, show "Killing session…" while a kill is pending.
- `packages/pwa/tests/HomeScreen.test.tsx` — start-session pending/timeout/kill assertions.
- `packages/pwa/src/screens/timeline/SessionTimeline.tsx` — show "Loading history…" empty-state placeholder and "Loading earlier events…" button label while a history request is pending, hide button on `noMoreHistory`.
- `packages/pwa/src/hooks/useSessionTimeline.ts` — surface history-pending flag from useHub; coalesce concurrent loadEarlier calls via the registry rather than the existing `lastLoadAt` ref.
- `packages/pwa/src/screens/PermissionSurface.tsx` — disable both buttons + show "Submitting decision…" when the active permission has a pending reply; remove optimistic queue advance.
- `packages/pwa/src/RealApp.tsx` — pass new selectors / pending state to children; remove the optimistic `permissionQueue.advance()` after `sendPermissionReply` and instead advance when the request leaves `pendingPermissions`.

**Created:**
- `packages/pwa/src/hooks/pendingCommands.ts` — pure helpers for the registry (create, confirm, fail, timeout, selector). Pure → easier to unit test independent of React.
- `packages/pwa/tests/pendingCommands.test.ts` — pure-helper unit tests.

**Boundary rationale:** The pending registry is concentrated in `useHub` because that hook already owns websocket I/O and is the natural place to start a timer when a frame is sent and clear it when a matching frame is received. Pure helpers are extracted into `pendingCommands.ts` so the state transitions are unit-testable without React. UI components stay dumb: each one reads one selector and renders.

---

## Task 1: Protocol — `client_message_id` on chat_send, chat, chat_error

**Files:**
- Modify: `packages/proto/src/frames.ts`
- Modify: `packages/proto/tests/frames.test.ts`

The PWA will generate a `client_message_id` (e.g. ULID) per `chat_send`. The hub MUST preserve and echo it on the resulting `chat` broadcast (`from: "pwa"`) and on any `chat_error` it returns to that sender. Without this, the PWA cannot correlate confirmations to the originating send.

- [ ] **Step 1: Read the relevant types**

Open `packages/proto/src/frames.ts` and locate:
- `PwaToHubChatSend` (~line 292)
- `HubToDaemonChatSend` (~line 301) — note: this stays unchanged; the daemon does not need `client_message_id`.
- `PwaChatBroadcast` (~line 313)
- `HubChatErrorBroadcast` (~line 326)

- [ ] **Step 2: Write the failing test**

Append to `packages/proto/tests/frames.test.ts`:

```typescript
import { test, expect } from "bun:test";
import type {
  PwaToHubChatSend, PwaChatBroadcast, HubChatErrorBroadcast,
} from "../src/frames";

test("PwaToHubChatSend carries optional client_message_id", () => {
  const f: PwaToHubChatSend = {
    type: "chat_send",
    daemon_id: "d", session_id: "s",
    content: "hi",
    client_message_id: "cm-1",
  };
  expect(f.client_message_id).toBe("cm-1");
});

test("PwaChatBroadcast preserves client_message_id round-trip", () => {
  const f: PwaChatBroadcast = {
    type: "chat",
    daemon_id: "d", session_id: "s",
    message_id: "m-1",
    from: "pwa",
    user: "alice",
    content: "hi",
    reply_to: null,
    ts: 0,
    client_message_id: "cm-1",
  };
  expect(f.client_message_id).toBe("cm-1");
});

test("HubChatErrorBroadcast preserves client_message_id round-trip", () => {
  const f: HubChatErrorBroadcast = {
    type: "chat_error",
    daemon_id: "d", session_id: "s",
    reason: "daemon_offline",
    client_message_id: "cm-1",
  };
  expect(f.client_message_id).toBe("cm-1");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/proto && bun test tests/frames.test.ts`
Expected: FAIL — `Property 'client_message_id' does not exist on type ...`

- [ ] **Step 4: Add fields to types**

Edit `packages/proto/src/frames.ts`:

In `PwaToHubChatSend`:
```typescript
export interface PwaToHubChatSend {
  type: "chat_send";
  daemon_id: string;
  session_id: string;
  content: string;
  reply_to?: string;
  /**
   * PWA-generated id used to correlate the resulting `chat` broadcast (or
   * `chat_error`) back to this send. Echoed verbatim by the hub.
   */
  client_message_id?: string;
}
```

In `PwaChatBroadcast`:
```typescript
export interface PwaChatBroadcast {
  type: "chat";
  daemon_id: string;
  session_id: string;
  message_id: string;
  from: "pwa" | "claude";
  user: string | null;
  content: string;
  reply_to: string | null;
  ts: number;
  /** Echoed when this broadcast originated from a PWA chat_send. Absent for
   *  Claude-originated messages. */
  client_message_id?: string;
}
```

In `HubChatErrorBroadcast`:
```typescript
export interface HubChatErrorBroadcast {
  type: "chat_error";
  daemon_id: string;
  session_id: string;
  reason: string;
  /** Present when the error is bound to a specific PWA chat_send. */
  client_message_id?: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/proto && bun test tests/frames.test.ts`
Expected: PASS, all three new cases.

- [ ] **Step 6: Commit**

```bash
git add packages/proto/src/frames.ts packages/proto/tests/frames.test.ts
git commit -m "feat(proto): add client_message_id to chat_send/chat/chat_error"
```

---

## Task 2: Protocol — `request_id` on session_open

**Files:**
- Modify: `packages/proto/src/frames.ts`
- Modify: `packages/proto/tests/frames.test.ts`

PWA will always populate `start_session.request_id` (already optional in the type — this task makes correlation possible from the other side). Add an optional `request_id` to the daemon→hub `session_open` and the hub→PWA `session_open`. Plugin-registration sessions (where there was no PWA `start_session`) leave it absent.

- [ ] **Step 1: Locate types**

In `packages/proto/src/frames.ts`:
- `DaemonToHub` union has an inline `{ type: "session_open"; session: SessionSnapshot }` — promote to a named type.
- `HubToPwa` union has `{ type: "session_open"; daemon_id: string; session: SessionSnapshot }` — same.

- [ ] **Step 2: Write the failing test**

Append to `packages/proto/tests/frames.test.ts`:

```typescript
import type {
  DaemonSessionOpenFrame, PwaSessionOpenFrame,
} from "../src/frames";

test("DaemonSessionOpenFrame carries optional request_id", () => {
  const f: DaemonSessionOpenFrame = {
    type: "session_open",
    session: {
      session_id: "s", claude_session_id: null,
      tmux_session: null, tmux_pane: null,
      cwd: "/x", model: null, pid: 1,
      started_at: 0, claude_client_version: "v",
      plugin_version: "v", state: "idle",
    },
    request_id: "req-1",
  };
  expect(f.request_id).toBe("req-1");
});

test("PwaSessionOpenFrame carries optional request_id", () => {
  const f: PwaSessionOpenFrame = {
    type: "session_open",
    daemon_id: "d",
    session: {
      session_id: "s", claude_session_id: null,
      tmux_session: null, tmux_pane: null,
      cwd: "/x", model: null, pid: 1,
      started_at: 0, claude_client_version: "v",
      plugin_version: "v", state: "idle",
    },
    request_id: "req-1",
  };
  expect(f.request_id).toBe("req-1");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/proto && bun test tests/frames.test.ts`
Expected: FAIL — types don't exist.

- [ ] **Step 4: Promote inline types and add request_id**

Edit `packages/proto/src/frames.ts`. Add named types:

```typescript
export interface DaemonSessionOpenFrame {
  type: "session_open";
  session: SessionSnapshot;
  /** Present when this session was spawned in response to a PWA start_session
   *  command; absent for plugin-driven registrations. */
  request_id?: string;
}

export interface PwaSessionOpenFrame {
  type: "session_open";
  daemon_id: string;
  session: SessionSnapshot;
  /** Forwarded verbatim from the daemon. Present for PWA-originated starts. */
  request_id?: string;
}
```

Replace the inline session_open in `DaemonToHub` union:
```typescript
export type DaemonToHub =
  | { type: "hello"; daemon_id: string; epoch: number; hostname: string; agent_version: string; sessions: SessionSnapshot[] }
  | DaemonSessionOpenFrame
  | { type: "session_close"; session_id: string; reason: string }
  // ...rest unchanged
```

Replace inline session_open in `HubToPwa` union:
```typescript
export type HubToPwa =
  | { type: "snapshot"; daemons: DaemonView[] }
  | { type: "daemon_online"; daemon_id: string; hostname: string; sessions: SessionSnapshot[] }
  | { type: "daemon_offline"; daemon_id: string }
  | PwaSessionOpenFrame
  | { type: "session_close"; daemon_id: string; session_id: string; reason: string }
  // ...rest unchanged
```

- [ ] **Step 5: Run test to verify it passes and full proto suite is green**

Run: `cd packages/proto && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/proto/src/frames.ts packages/proto/tests/frames.test.ts
git commit -m "feat(proto): add optional request_id to session_open frames"
```

---

## Task 3: Hub — round-trip `client_message_id`

**Files:**
- Modify: `packages/hub/src/router.ts`
- Modify: `packages/hub/tests/router.test.ts`

The hub already generates a server `message_id` (ULID) for every chat. Now it must also echo the PWA-supplied `client_message_id` on both the broadcast and the offline-error path.

- [ ] **Step 1: Write the failing tests**

Open `packages/hub/tests/router.test.ts`. Find an existing test that calls `router.onPwaChatSend(...)` for a successful broadcast, then append:

```typescript
test("onPwaChatSend echoes client_message_id on the chat broadcast", () => {
  const { router, daemonReg, pwaReg } = makeRouter(); // existing test helper
  daemonReg.fakeRegister("d");
  let captured: HubToPwa | null = null;
  pwaReg.broadcastSpy = (f) => { captured = f; };
  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "d", session_id: "s", content: "hi", client_message_id: "cm-1" },
    { user: "alice@example", user_id: "u1" },
    () => {},
  );
  expect(captured?.type).toBe("chat");
  expect((captured as PwaChatBroadcast).client_message_id).toBe("cm-1");
});

test("onPwaChatSend echoes client_message_id on chat_error when daemon offline", () => {
  const { router } = makeRouter();
  let err: HubToPwa | null = null;
  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "missing", session_id: "s", content: "hi", client_message_id: "cm-2" },
    { user: "alice", user_id: "u1" },
    (f) => { err = f; },
  );
  expect(err?.type).toBe("chat_error");
  expect((err as HubChatErrorBroadcast).client_message_id).toBe("cm-2");
});
```

If `makeRouter` / `pwaReg.broadcastSpy` shape differs in this file, mirror the existing helper conventions used for sibling tests in `router.test.ts` — do not invent new infra. Read the file first and match the existing test setup pattern exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/hub && bun test tests/router.test.ts`
Expected: FAIL — `captured.client_message_id` is undefined.

- [ ] **Step 3: Forward `client_message_id` in router**

Edit `packages/hub/src/router.ts` `onPwaChatSend`:

In the `daemon offline` branch, change the senderSend call:
```typescript
if (!this.daemonReg.has(frame.daemon_id)) {
  const errOut: HubChatErrorBroadcast = {
    type: "chat_error",
    daemon_id: frame.daemon_id,
    session_id: frame.session_id,
    reason: "daemon_offline",
    ...(frame.client_message_id !== undefined ? { client_message_id: frame.client_message_id } : {}),
  };
  senderSend(errOut);
  return;
}
```

In the broadcast block at the end:
```typescript
this.pwaReg.broadcast({
  type: "chat",
  daemon_id: frame.daemon_id,
  session_id: frame.session_id,
  message_id,
  from: "pwa",
  user: auth.user,
  content: frame.content,
  reply_to,
  ts,
  ...(frame.client_message_id !== undefined ? { client_message_id: frame.client_message_id } : {}),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/hub && bun test tests/router.test.ts`
Expected: PASS for the two new cases plus all existing.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/router.ts packages/hub/tests/router.test.ts
git commit -m "feat(hub): forward chat_send.client_message_id to chat/chat_error"
```

---

## Task 4: Hub — forward `request_id` on session_open

**Files:**
- Modify: `packages/hub/src/router.ts`
- Modify: `packages/hub/tests/router.test.ts`

The daemon will (Task 5) emit `session_open` with an optional `request_id`. Hub must preserve it on broadcast.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub/tests/router.test.ts`:

```typescript
test("session_open forwards request_id from daemon to PWA", () => {
  const { router, pwaReg } = makeRouter();
  router.onDaemonFrame("d", {
    type: "hello", daemon_id: "d", epoch: 1,
    hostname: "h", agent_version: "v", sessions: [],
  });
  const captured: HubToPwa[] = [];
  pwaReg.broadcastSpy = (f) => { captured.push(f); };
  router.onDaemonFrame("d", {
    type: "session_open",
    session: {
      session_id: "s", claude_session_id: null,
      tmux_session: null, tmux_pane: null,
      cwd: "/x", model: null, pid: 1, started_at: 0,
      claude_client_version: "v", plugin_version: "v",
      state: "idle",
    },
    request_id: "req-7",
  });
  const opens = captured.filter((f) => f.type === "session_open");
  expect(opens).toHaveLength(1);
  expect((opens[0] as PwaSessionOpenFrame).request_id).toBe("req-7");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && bun test tests/router.test.ts`
Expected: FAIL — `request_id` undefined on broadcast.

- [ ] **Step 3: Forward request_id**

Edit `packages/hub/src/router.ts` in the `case "session_open"` block:

```typescript
case "session_open": {
  const state = this.daemons.get(daemon_id);
  if (!state) return;
  state.sessions.set(frame.session.session_id, frame.session);
  this.pwaReg.broadcast({
    type: "session_open",
    daemon_id,
    session: frame.session,
    ...(frame.request_id !== undefined ? { request_id: frame.request_id } : {}),
  });
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && bun test tests/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/router.ts packages/hub/tests/router.test.ts
git commit -m "feat(hub): forward session_open.request_id from daemon to PWA"
```

---

## Task 5: Daemon — track pending start_sessions and tag session_open with request_id

**Files:**
- Create: `packages/daemon/src/pending-starts.ts`
- Create: `packages/daemon/tests/pending-starts.test.ts`
- Modify: `packages/daemon/src/index.ts`

The daemon receives `start_session` frames with optional `request_id`. After spawn it cannot directly know which session_id will register, so it tracks pending requests as a FIFO queue keyed by cwd. When a plugin registers a session, the daemon pops the oldest pending request whose cwd matches and attaches `request_id` to the resulting `session_open` frame. Pending entries also expire after 60s so a never-registering spawn doesn't leak.

- [ ] **Step 1: Write failing tests for the pure tracker**

Create `packages/daemon/tests/pending-starts.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { createPendingStarts } from "../src/pending-starts";

test("matches a registered session by cwd FIFO", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add("req-1", "/a");
  t.add("req-2", "/b");
  expect(t.consume("/a")).toBe("req-1");
  expect(t.consume("/a")).toBeUndefined(); // already consumed
  expect(t.consume("/b")).toBe("req-2");
});

test("FIFO across same-cwd entries", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add("req-1", "/a");
  t.add("req-2", "/a");
  expect(t.consume("/a")).toBe("req-1");
  expect(t.consume("/a")).toBe("req-2");
});

test("ignores entries with no request_id", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add(undefined, "/a");
  expect(t.consume("/a")).toBeUndefined();
});

test("expires entries past ttl", () => {
  let now = 0;
  const t = createPendingStarts({ ttlMs: 1_000, now: () => now });
  t.add("req-1", "/a");
  now = 2_000;
  expect(t.consume("/a")).toBeUndefined();
});

test("consume returns undefined for unmatched cwd", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add("req-1", "/a");
  expect(t.consume("/other")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && bun test tests/pending-starts.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the tracker**

Create `packages/daemon/src/pending-starts.ts`:

```typescript
export interface PendingStarts {
  add(request_id: string | undefined, cwd: string): void;
  consume(cwd: string): string | undefined;
}

interface Entry {
  request_id: string;
  cwd: string;
  expires_at: number;
}

export function createPendingStarts(opts: {
  ttlMs: number;
  now?: () => number;
}): PendingStarts {
  const now = opts.now ?? (() => Date.now());
  const queue: Entry[] = [];

  const purge = () => {
    const t = now();
    while (queue.length > 0 && queue[0]!.expires_at < t) queue.shift();
  };

  return {
    add(request_id, cwd) {
      if (!request_id) return;
      purge();
      queue.push({ request_id, cwd, expires_at: now() + opts.ttlMs });
    },
    consume(cwd) {
      purge();
      for (let i = 0; i < queue.length; i++) {
        if (queue[i]!.cwd === cwd) {
          const e = queue.splice(i, 1)[0]!;
          return e.request_id;
        }
      }
      return undefined;
    },
  };
}
```

- [ ] **Step 4: Run tracker tests to verify they pass**

Run: `cd packages/daemon && bun test tests/pending-starts.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire tracker into the daemon**

Edit `packages/daemon/src/index.ts`. Near the top of the module, add the import and instance:

```typescript
import { createPendingStarts } from "./pending-starts";

const pendingStarts = createPendingStarts({ ttlMs: 60_000 });
```

In the `start_session` handler (the success-path branches inside `r.unref()` and below), after the spawn succeeds (just before `dismissClaudeDialogs(tmuxName);`), add:

```typescript
pendingStarts.add(requestId ?? undefined, cwd);
```

In `sessions.onAdd((s: SessionSnapshot) => { ... })`, replace the existing `hub.send({ type: "session_open", session: s });` line with:

```typescript
const matchedReqId = pendingStarts.consume(s.cwd);
hub.send({
  type: "session_open",
  session: s,
  ...(matchedReqId ? { request_id: matchedReqId } : {}),
});
```

- [ ] **Step 6: Run all daemon tests**

Run: `cd packages/daemon && bun test`
Expected: PASS — no existing test should regress.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/pending-starts.ts packages/daemon/src/index.ts packages/daemon/tests/pending-starts.test.ts
git commit -m "feat(daemon): tag session_open with request_id for PWA-originated starts"
```

---

## Task 6: PWA — pure pendingCommands helpers

**Files:**
- Create: `packages/pwa/src/hooks/pendingCommands.ts`
- Create: `packages/pwa/tests/pendingCommands.test.ts`

Pure helpers for building/transitioning the pending registry. Keep the React-free surface so transitions are unit-tested independent of websocket plumbing.

- [ ] **Step 1: Write failing tests**

Create `packages/pwa/tests/pendingCommands.test.ts`:

```typescript
import { test, expect } from "bun:test";
import {
  createPending, confirmPending, failPending, timeoutPending,
  type PendingCommand, type PendingCommandKind,
} from "../src/hooks/pendingCommands";

const baseInput = (over: Partial<PendingCommand>): PendingCommand => ({
  id: "id-1",
  kind: "chat_send" as PendingCommandKind,
  daemon_id: "d",
  status: "pending",
  started_at: 1_700_000_000_000,
  ...over,
});

test("createPending adds entry keyed by id", () => {
  const out = createPending({}, baseInput({}));
  expect(out["id-1"]?.status).toBe("pending");
  expect(out["id-1"]?.kind).toBe("chat_send");
});

test("confirmPending removes entry", () => {
  const start = createPending({}, baseInput({}));
  const out = confirmPending(start, "id-1");
  expect(out["id-1"]).toBeUndefined();
});

test("confirmPending returns same reference if id missing", () => {
  const start = createPending({}, baseInput({}));
  const out = confirmPending(start, "missing");
  expect(out).toBe(start);
});

test("failPending marks status=failed and stores error", () => {
  const start = createPending({}, baseInput({}));
  const out = failPending(start, "id-1", "boom");
  expect(out["id-1"]?.status).toBe("failed");
  expect(out["id-1"]?.error).toBe("boom");
});

test("timeoutPending marks status=timed_out", () => {
  const start = createPending({}, baseInput({}));
  const out = timeoutPending(start, "id-1");
  expect(out["id-1"]?.status).toBe("timed_out");
});

test("transitions ignore already-resolved entries", () => {
  const start = createPending({}, baseInput({ status: "failed" }));
  const out = timeoutPending(start, "id-1");
  expect(out["id-1"]?.status).toBe("failed");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/pwa && bun test tests/pendingCommands.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helpers**

Create `packages/pwa/src/hooks/pendingCommands.ts`:

```typescript
export type PendingCommandKind =
  | "chat_send"
  | "start_session"
  | "request_history"
  | "permission_reply"
  | "kill_session";

export type PendingCommandStatus = "pending" | "failed" | "timed_out";

export interface PendingCommand {
  id: string;
  kind: PendingCommandKind;
  daemon_id: string;
  session_id?: string;
  started_at: number;
  status: PendingCommandStatus;
  label?: string;
  error?: string;
}

export type PendingCommands = Record<string, PendingCommand>;

export function createPending(
  prev: PendingCommands,
  cmd: PendingCommand,
): PendingCommands {
  return { ...prev, [cmd.id]: cmd };
}

export function confirmPending(
  prev: PendingCommands,
  id: string,
): PendingCommands {
  if (!prev[id]) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

export function failPending(
  prev: PendingCommands,
  id: string,
  error: string,
): PendingCommands {
  const cur = prev[id];
  if (!cur || cur.status !== "pending") return prev;
  return { ...prev, [id]: { ...cur, status: "failed", error } };
}

export function timeoutPending(
  prev: PendingCommands,
  id: string,
): PendingCommands {
  const cur = prev[id];
  if (!cur || cur.status !== "pending") return prev;
  return { ...prev, [id]: { ...cur, status: "timed_out" } };
}

export function dismissPending(
  prev: PendingCommands,
  id: string,
): PendingCommands {
  return confirmPending(prev, id);
}

export function findPending(
  pending: PendingCommands,
  predicate: (cmd: PendingCommand) => boolean,
): PendingCommand | undefined {
  for (const v of Object.values(pending)) {
    if (predicate(v)) return v;
  }
  return undefined;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/pwa && bun test tests/pendingCommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/pendingCommands.ts packages/pwa/tests/pendingCommands.test.ts
git commit -m "feat(pwa): pendingCommands pure helpers for outbound command lifecycle"
```

---

## Task 7: useHub — pendingCommands state + chat_send lifecycle

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Modify: `packages/pwa/tests/useHub.test.ts`

Wire the registry into `useHub` state, generate `client_message_id` in `sendChat`, mark pending on send, clear on `chat`, fail on `chat_error`, time out at 30s. Surface a `pendingChatSendFor(daemon_id, session_id)` selector.

- [ ] **Step 1: Read existing useHub patterns**

Re-read `packages/pwa/src/hooks/useHub.ts` lines 80–101 (state shape) and 426–438 (`sendChat`). Note the existing pattern: state is updated via `setState((prev) => ...)`, ws frames are sent via `wsRef.current.send(JSON.stringify(...))`.

- [ ] **Step 2: Write failing tests for chat_send lifecycle**

Append to `packages/pwa/tests/useHub.test.ts` a new section. The existing tests in that file mostly target `appendEventToBuffer` (a pure helper). Add new tests against the React hook using `renderHook` from `@testing-library/react` (already a transitive dep via `@testing-library/dom` — confirm it's present; if not, fall back to a test rig that simulates a WebSocket and exercises the apply reducer the same way `useDaemons.test.ts` does — read that file for the project's existing pattern and mirror it).

If `@testing-library/react` is unavailable, prefer extracting the reducer (the `apply` function inside the effect closure) into a top-level pure function and testing that. The plan below assumes the simpler reducer-extraction route — apply this in Step 3.

```typescript
import {
  reducer, initialHubState, type HubAction,
  type PendingCommands,
} from "../src/hooks/useHub";

test("chat_send creates a pending entry keyed by client_message_id", () => {
  const after = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  const cmd = after.pendingCommands["cm-1"];
  expect(cmd?.kind).toBe("chat_send");
  expect(cmd?.daemon_id).toBe("d");
  expect(cmd?.session_id).toBe("s");
  expect(cmd?.status).toBe("pending");
});

test("chat broadcast with matching client_message_id clears pending", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "chat",
      daemon_id: "d", session_id: "s",
      message_id: "m-1", from: "pwa", user: "alice",
      content: "hi", reply_to: null, ts: 0,
      client_message_id: "cm-1",
    },
  });
  expect(s.pendingCommands["cm-1"]).toBeUndefined();
});

test("chat_error with matching client_message_id marks pending failed", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "chat_error",
      daemon_id: "d", session_id: "s",
      reason: "daemon_offline",
      client_message_id: "cm-1",
    },
  });
  expect(s.pendingCommands["cm-1"]?.status).toBe("failed");
  expect(s.pendingCommands["cm-1"]?.error).toBe("daemon_offline");
});

test("timeout marks pending as timed_out", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  s = reducer(s, { type: "command_timeout", id: "cm-1" });
  expect(s.pendingCommands["cm-1"]?.status).toBe("timed_out");
});
```

- [ ] **Step 3: Refactor useHub to use a top-level reducer + extend state**

Edit `packages/pwa/src/hooks/useHub.ts`:

a) Add at top of file:

```typescript
import {
  createPending, confirmPending, failPending, timeoutPending,
  type PendingCommand, type PendingCommands,
} from "./pendingCommands";

export const COMMAND_TIMEOUT_MS = 30_000;
```

b) Extend `HubState`:
```typescript
export interface HubState {
  // ...existing fields...
  pendingCommands: PendingCommands;
}
```

c) Export an initial state factory:
```typescript
export function initialHubState(): HubState {
  return {
    connected: false, daemons: [], events: {}, pendingPermissions: {},
    completedCounts: {},
    chatMessages: {}, chatErrors: {},
    startSessionErrors: {},
    noMoreHistory: {},
    pendingCommands: {},
  };
}
```

d) Move the inner `apply` switch out into a top-level `reducer(state, action)` keyed off an action type. Define an `HubAction` union with at least:

```typescript
export type HubAction =
  | { type: "frame"; frame: HubToPwa }
  | { type: "ws_open" }
  | { type: "ws_close" }
  | {
      type: "outbound_chat_send";
      daemon_id: string; session_id: string;
      client_message_id: string;
      started_at: number;
    }
  | { type: "command_timeout"; id: string }
  | { type: "command_dismiss"; id: string }
  | { type: "clear_start_session_error"; daemon_id: string };
```

The `frame` case body is the existing `switch (frame.type)` block; only its return shape changes (it now must include `pendingCommands` carried-through and add the chat / chat_error transitions below).

In the `case "chat"` branch of frame handling, after the existing chat append, add:
```typescript
const cmid = frame.client_message_id;
const nextPending = cmid ? confirmPending(prev.pendingCommands, cmid) : prev.pendingCommands;
return {
  ...prev,
  chatMessages: { ...prev.chatMessages, [k]: trimmed },
  chatErrors: nextErrors,
  pendingCommands: nextPending,
};
```

In the `case "chat_error"` branch:
```typescript
const cmid = frame.client_message_id;
const nextPending = cmid ? failPending(prev.pendingCommands, cmid, frame.reason) : prev.pendingCommands;
return {
  ...prev,
  chatErrors: { ...prev.chatErrors, [k]: frame.reason },
  pendingCommands: nextPending,
};
```

For `outbound_chat_send`:
```typescript
case "outbound_chat_send": {
  const cmd: PendingCommand = {
    id: action.client_message_id,
    kind: "chat_send",
    daemon_id: action.daemon_id,
    session_id: action.session_id,
    started_at: action.started_at,
    status: "pending",
  };
  return { ...state, pendingCommands: createPending(state.pendingCommands, cmd) };
}
```

For `command_timeout`:
```typescript
case "command_timeout":
  return { ...state, pendingCommands: timeoutPending(state.pendingCommands, action.id) };
```

For `command_dismiss`:
```typescript
case "command_dismiss":
  return { ...state, pendingCommands: confirmPending(state.pendingCommands, action.id) };
```

`ws_open` → `{ ...state, connected: true }`. `ws_close` → `{ ...state, connected: false }`.

e) Replace the existing `useState<HubState>(...)` and `setState((prev) => ...)` flows so the hook's effect dispatches actions through `setState((prev) => reducer(prev, action))`. Add a `useRef<Map<string, ReturnType<typeof setTimeout>>>` to track per-id timeout handles, and a small helper:

```typescript
const armTimeout = (id: string) => {
  const h = setTimeout(() => {
    setState((prev) => reducer(prev, { type: "command_timeout", id }));
    timersRef.current.delete(id);
  }, COMMAND_TIMEOUT_MS);
  timersRef.current.set(id, h);
};
const clearTimer = (id: string) => {
  const h = timersRef.current.get(id);
  if (h) { clearTimeout(h); timersRef.current.delete(id); }
};
```

Whenever a frame transition resolves a pending entry (chat, chat_error, etc.), the effect handling that frame should also call `clearTimer(id)` outside the reducer (timers are side-effects). Implement this by checking, after dispatch, whether a pending entry was removed/changed-status — or by intercepting the same id list at action-creation time. The simplest approach: in `apply(frame)` — which now wraps `setState((prev) => reducer(prev, { type: "frame", frame }))` — capture `prev.pendingCommands` vs. the next state's, and `clearTimer` for any id that is no longer `pending`. Use a one-shot pattern:

```typescript
const apply = (frame: HubToPwa) => {
  setState((prev) => {
    const next = reducer(prev, { type: "frame", frame });
    // Schedule timer cleanup for any pending entry that resolved.
    for (const id of Object.keys(prev.pendingCommands)) {
      const before = prev.pendingCommands[id];
      const after = next.pendingCommands[id];
      if (before?.status === "pending" && (!after || after.status !== "pending")) {
        clearTimer(id);
      }
    }
    return next;
  });
};
```

f) Update `sendChat`:

```typescript
const sendChat = useCallback(
  (daemon_id: string, session_id: string, content: string, reply_to?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const client_message_id = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg: PwaToHub = {
      type: "chat_send",
      daemon_id, session_id, content,
      client_message_id,
      ...(reply_to ? { reply_to } : {}),
    };
    ws.send(JSON.stringify(msg));
    setState((prev) => reducer(prev, {
      type: "outbound_chat_send",
      daemon_id, session_id,
      client_message_id,
      started_at: Date.now(),
    }));
    armTimeout(client_message_id);
  },
  [],
);
```

g) Add a selector to the returned object:
```typescript
const pendingChatSendFor = useCallback(
  (daemon_id: string, session_id: string): PendingCommand | undefined => {
    for (const v of Object.values(state.pendingCommands)) {
      if (v.kind === "chat_send" && v.daemon_id === daemon_id && v.session_id === session_id) return v;
    }
    return undefined;
  },
  [state.pendingCommands],
);
```

Add `dismissPendingCommand: (id: string) => void` returning `setState((prev) => reducer(prev, { type: "command_dismiss", id }))`.

Extend `UseHubResult` with `pendingChatSendFor` and `dismissPendingCommand`, and surface `pendingCommands` directly on the result (so other selectors in later tasks can read).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pwa && bun test tests/useHub.test.ts tests/pendingCommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts packages/pwa/tests/useHub.test.ts
git commit -m "feat(pwa): chat_send pending lifecycle in useHub"
```

---

## Task 8: useHub — start_session lifecycle

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Modify: `packages/pwa/tests/useHub.test.ts`

`startSession` now generates a `request_id`, registers a pending entry, and the reducer clears it on `session_open` (matching `request_id`) or marks it failed on `start_session_rejected`.

- [ ] **Step 1: Write failing tests**

Append to `packages/pwa/tests/useHub.test.ts`:

```typescript
test("start_session pending cleared by matching session_open", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-1", started_at: 1,
  });
  expect(s.pendingCommands["rs-1"]?.kind).toBe("start_session");
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "session_open",
      daemon_id: "d",
      session: {
        session_id: "s", claude_session_id: null,
        tmux_session: null, tmux_pane: null,
        cwd: "/x", model: null, pid: 1, started_at: 0,
        claude_client_version: "v", plugin_version: "v",
        state: "idle",
      },
      request_id: "rs-1",
    },
  });
  expect(s.pendingCommands["rs-1"]).toBeUndefined();
});

test("start_session_rejected with matching request_id marks failed", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-1", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "start_session_rejected",
      daemon_id: "d", request_id: "rs-1",
      cwd: "/x", reason: "not_allowed", message: "nope",
    },
  });
  expect(s.pendingCommands["rs-1"]?.status).toBe("failed");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `packages/pwa/src/hooks/useHub.ts`:

a) Extend `HubAction`:
```typescript
| { type: "outbound_start_session"; daemon_id: string; request_id: string; started_at: number }
```

b) Add reducer case:
```typescript
case "outbound_start_session": {
  const cmd: PendingCommand = {
    id: action.request_id,
    kind: "start_session",
    daemon_id: action.daemon_id,
    started_at: action.started_at,
    status: "pending",
  };
  return { ...state, pendingCommands: createPending(state.pendingCommands, cmd) };
}
```

c) In the frame `case "session_open"` branch, after the existing `daemons` map update:
```typescript
const reqId = frame.request_id;
const nextPending = reqId ? confirmPending(prev.pendingCommands, reqId) : prev.pendingCommands;
return { ...prev, daemons: ..., pendingCommands: nextPending };
```

d) In the frame `case "start_session_rejected"` branch, also fail the pending entry if `request_id` is present:
```typescript
const reqId = frame.request_id ?? null;
const nextPending = reqId ? failPending(prev.pendingCommands, reqId, frame.message) : prev.pendingCommands;
return {
  ...prev,
  startSessionErrors: { ...prev.startSessionErrors, [frame.daemon_id]: frame },
  pendingCommands: nextPending,
};
```

e) Update `startSession` to always generate `request_id` and register pending:

```typescript
const startSession = useCallback(
  (daemon_id: string, cwd: string, name?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const request_id = `rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setState((prev) => {
      const cleared = prev.startSessionErrors[daemon_id]
        ? (() => { const n = { ...prev.startSessionErrors }; delete n[daemon_id]; return n; })()
        : prev.startSessionErrors;
      return reducer(
        { ...prev, startSessionErrors: cleared },
        { type: "outbound_start_session", daemon_id, request_id, started_at: Date.now() },
      );
    });
    const msg: PwaToHub = {
      type: "start_session",
      daemon_id, cwd, request_id,
      ...(name ? { name } : {}),
    };
    ws.send(JSON.stringify(msg));
    armTimeout(request_id);
  },
  [],
);
```

f) Add selector `pendingStartSessionFor(daemon_id)`:
```typescript
const pendingStartSessionFor = useCallback(
  (daemon_id: string): PendingCommand | undefined => {
    for (const v of Object.values(state.pendingCommands)) {
      if (v.kind === "start_session" && v.daemon_id === daemon_id) return v;
    }
    return undefined;
  },
  [state.pendingCommands],
);
```

Surface it on `UseHubResult`.

- [ ] **Step 4: Run tests**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`
Expected: PASS, including all prior cases.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts packages/pwa/tests/useHub.test.ts
git commit -m "feat(pwa): start_session pending lifecycle in useHub"
```

---

## Task 9: useHub — request_history lifecycle (with coalesce)

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Modify: `packages/pwa/tests/useHub.test.ts`

`requestHistory` writes a pending entry keyed by `request_id`. If a pending request_history already exists for the same (daemon_id, session_id), the new call is coalesced (no-op). The reducer clears the entry on a matching `history_chunk`, including empty chunks.

- [ ] **Step 1: Write failing tests**

```typescript
test("request_history coalesces while pending for same session", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-1", started_at: 1,
  });
  // Try to add another for same session — should be ignored.
  s = reducer(s, {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-2", started_at: 2,
  });
  expect(s.pendingCommands["rh-1"]).toBeDefined();
  expect(s.pendingCommands["rh-2"]).toBeUndefined();
});

test("history_chunk clears pending request_history (including empty)", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-1", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "history_chunk",
      daemon_id: "d", session_id: "s",
      request_id: "rh-1", events: [],
    },
  });
  expect(s.pendingCommands["rh-1"]).toBeUndefined();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`

- [ ] **Step 3: Implement**

In `useHub.ts`:

a) Extend `HubAction`:
```typescript
| { type: "outbound_request_history"; daemon_id: string; session_id: string; request_id: string; started_at: number }
```

b) Reducer:
```typescript
case "outbound_request_history": {
  // Coalesce: if there's already a pending history request for this
  // (daemon_id, session_id), drop this one.
  const existing = Object.values(state.pendingCommands).find(
    (c) => c.kind === "request_history"
        && c.daemon_id === action.daemon_id
        && c.session_id === action.session_id
        && c.status === "pending",
  );
  if (existing) return state;
  const cmd: PendingCommand = {
    id: action.request_id,
    kind: "request_history",
    daemon_id: action.daemon_id,
    session_id: action.session_id,
    started_at: action.started_at,
    status: "pending",
  };
  return { ...state, pendingCommands: createPending(state.pendingCommands, cmd) };
}
```

c) In the frame `case "history_chunk"` block (both empty- and non-empty-chunk return paths), include `pendingCommands: confirmPending(prev.pendingCommands, frame.request_id)` in the returned object.

d) Update `requestHistory`:

```typescript
const requestHistory = useCallback(
  (daemon_id: string, session_id: string, before_offset: number, limit: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Coalesce: if a request_history is already pending for this session, do nothing.
    const alreadyPending = Object.values(stateRef.current.pendingCommands).some(
      (c) => c.kind === "request_history"
          && c.daemon_id === daemon_id
          && c.session_id === session_id
          && c.status === "pending",
    );
    if (alreadyPending) return;
    const request_id = `rh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg: PwaToHub = {
      type: "request_history",
      daemon_id, session_id, request_id, before_offset, limit,
    };
    ws.send(JSON.stringify(msg));
    setState((prev) => reducer(prev, {
      type: "outbound_request_history",
      daemon_id, session_id, request_id,
      started_at: Date.now(),
    }));
    armTimeout(request_id);
  },
  [],
);
```

Add a `stateRef = useRef(state)` and update it in a `useEffect(() => { stateRef.current = state; }, [state])` so the callback can read the latest pending without depending on `state` (which would re-create the function on every render).

e) Add selector:
```typescript
const pendingHistoryFor = useCallback(
  (daemon_id: string, session_id: string): PendingCommand | undefined => {
    for (const v of Object.values(state.pendingCommands)) {
      if (v.kind === "request_history" && v.daemon_id === daemon_id && v.session_id === session_id) return v;
    }
    return undefined;
  },
  [state.pendingCommands],
);
```

- [ ] **Step 4: Run tests**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts packages/pwa/tests/useHub.test.ts
git commit -m "feat(pwa): request_history pending lifecycle with coalesce"
```

---

## Task 10: useHub — permission_reply lifecycle (no optimistic removal)

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Modify: `packages/pwa/tests/useHub.test.ts`

Currently `sendPermissionReply` optimistically removes the pending permission. Spec §5 / §3 requires removal only on `permission_resolved`. Move that removal to the reducer's `permission_resolved` handler (which already does it). Add a pending entry keyed by the permission's `request_id` that is cleared on `permission_resolved`.

- [ ] **Step 1: Write failing tests**

```typescript
test("permission_reply is NOT optimistically removed", () => {
  let s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_request",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      tool: "Bash", args_summary: "ls",
      expires_at: 1_700_000_000,
    },
  });
  s = reducer(s, {
    type: "outbound_permission_reply",
    daemon_id: "d", session_id: "s", request_id: "p-1",
    decision: "allow", started_at: 1,
  });
  expect(s.pendingPermissions["p-1"]).toBeDefined();
  expect(s.pendingCommands["p-1"]?.kind).toBe("permission_reply");
});

test("permission_resolved clears pending entry and pending command", () => {
  let s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_request",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      tool: "Bash", args_summary: "ls",
      expires_at: 1_700_000_000,
    },
  });
  s = reducer(s, {
    type: "outbound_permission_reply",
    daemon_id: "d", session_id: "s", request_id: "p-1",
    decision: "allow", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "permission_resolved",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      decision: "allow", decided_via: "pwa",
    },
  });
  expect(s.pendingPermissions["p-1"]).toBeUndefined();
  expect(s.pendingCommands["p-1"]).toBeUndefined();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`

- [ ] **Step 3: Implement**

In `useHub.ts`:

a) Extend `HubAction`:
```typescript
| { type: "outbound_permission_reply"; daemon_id: string; session_id: string; request_id: string; decision: "allow" | "deny"; started_at: number }
```

b) Reducer:
```typescript
case "outbound_permission_reply": {
  const cmd: PendingCommand = {
    id: action.request_id,
    kind: "permission_reply",
    daemon_id: action.daemon_id,
    session_id: action.session_id,
    started_at: action.started_at,
    status: "pending",
    label: action.decision,
  };
  return { ...state, pendingCommands: createPending(state.pendingCommands, cmd) };
}
```

c) In the frame `case "permission_resolved"` branch, also clear pendingCommands:
```typescript
case "permission_resolved": {
  if (!prev.pendingPermissions[frame.request_id]) {
    // Even if the request was not in our map, still clear pending command.
    return { ...prev, pendingCommands: confirmPending(prev.pendingCommands, frame.request_id) };
  }
  const next = { ...prev.pendingPermissions };
  delete next[frame.request_id];
  return {
    ...prev,
    pendingPermissions: next,
    pendingCommands: confirmPending(prev.pendingCommands, frame.request_id),
  };
}
```

d) Replace `sendPermissionReply` so it no longer removes from pendingPermissions; instead dispatches the outbound action:

```typescript
const sendPermissionReply = useCallback(
  (req: PwaPermissionRequest, decision: "allow" | "deny") => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: PwaToHub = {
      type: "permission_reply",
      daemon_id: req.daemon_id,
      session_id: req.session_id,
      request_id: req.request_id,
      decision,
    };
    ws.send(JSON.stringify(msg));
    setState((prev) => reducer(prev, {
      type: "outbound_permission_reply",
      daemon_id: req.daemon_id,
      session_id: req.session_id,
      request_id: req.request_id,
      decision,
      started_at: Date.now(),
    }));
    armTimeout(req.request_id);
  },
  [],
);
```

e) Add selector `pendingPermissionReplyFor(request_id)`:
```typescript
const pendingPermissionReplyFor = useCallback(
  (request_id: string): PendingCommand | undefined => state.pendingCommands[request_id],
  [state.pendingCommands],
);
```

- [ ] **Step 4: Run tests**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`
Expected: PASS, including the assertion that `pendingPermissions` survives until `permission_resolved`.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts packages/pwa/tests/useHub.test.ts
git commit -m "feat(pwa): permission_reply pending lifecycle, drop optimistic removal"
```

---

## Task 11: useHub — kill_session lifecycle

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Modify: `packages/pwa/tests/useHub.test.ts`

`kill_session` has no explicit ack frame. The matching `session_close` frame for the target session is the confirmation. Use a local id `kill-${daemon_id}-${session_id}` so a duplicate kill is naturally coalesced.

- [ ] **Step 1: Write failing tests**

```typescript
test("kill_session creates pending and is cleared by session_close", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s", started_at: 1,
  });
  expect(s.pendingCommands["kill-d-s"]?.kind).toBe("kill_session");
  s = reducer(s, {
    type: "frame",
    frame: { type: "session_close", daemon_id: "d", session_id: "s", reason: "killed" },
  });
  expect(s.pendingCommands["kill-d-s"]).toBeUndefined();
});

test("kill_session is coalesced for the same session", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s", started_at: 1,
  });
  const before = s.pendingCommands["kill-d-s"];
  s = reducer(s, {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s", started_at: 2,
  });
  expect(s.pendingCommands["kill-d-s"]).toBe(before);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`

- [ ] **Step 3: Implement**

In `useHub.ts`:

a) Helper id:
```typescript
function killCommandId(daemon_id: string, session_id: string): string {
  return `kill-${daemon_id}-${session_id}`;
}
```

b) Action:
```typescript
| { type: "outbound_kill_session"; daemon_id: string; session_id: string; started_at: number }
```

c) Reducer:
```typescript
case "outbound_kill_session": {
  const id = killCommandId(action.daemon_id, action.session_id);
  if (state.pendingCommands[id]) return state; // coalesce
  const cmd: PendingCommand = {
    id,
    kind: "kill_session",
    daemon_id: action.daemon_id,
    session_id: action.session_id,
    started_at: action.started_at,
    status: "pending",
  };
  return { ...state, pendingCommands: createPending(state.pendingCommands, cmd) };
}
```

d) In the frame `case "session_close"` branch (which currently filters the daemon's sessions), also clear `pendingCommands[killCommandId(...)]`:
```typescript
const id = killCommandId(frame.daemon_id, frame.session_id);
return {
  ...prev,
  daemons: prev.daemons.map((d) =>
    d.daemon_id === frame.daemon_id
      ? { ...d, sessions: d.sessions.filter((s) => s.session_id !== frame.session_id) }
      : d),
  pendingCommands: confirmPending(prev.pendingCommands, id),
};
```

e) Update `killSession`:
```typescript
const killSession = useCallback(
  (daemon_id: string, session_id: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = killCommandId(daemon_id, session_id);
    if (stateRef.current.pendingCommands[id]) return; // coalesce
    const msg: PwaToHub = { type: "kill_session", daemon_id, session_id };
    ws.send(JSON.stringify(msg));
    setState((prev) => reducer(prev, {
      type: "outbound_kill_session",
      daemon_id, session_id, started_at: Date.now(),
    }));
    armTimeout(id);
  },
  [],
);
```

f) Add selector:
```typescript
const pendingKillFor = useCallback(
  (daemon_id: string, session_id: string): PendingCommand | undefined =>
    state.pendingCommands[killCommandId(daemon_id, session_id)],
  [state.pendingCommands],
);
```

- [ ] **Step 4: Run tests**

Run: `cd packages/pwa && bun test tests/useHub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts packages/pwa/tests/useHub.test.ts
git commit -m "feat(pwa): kill_session pending lifecycle in useHub"
```

---

## Task 12: SessionView — pending row, send spinner, drop offline queue

**Files:**
- Modify: `packages/pwa/src/screens/SessionView.tsx`
- Modify: `packages/pwa/src/RealApp.tsx`
- Modify: `packages/pwa/tests/SessionView.test.tsx`

Per spec §5.1: clear input on send; disable composer + show spinner while pending; show a `Sending message...` row; on `chat_error` or timeout, show `Message not confirmed. Try again.` with a Retry / Dismiss action. Remove the local `queue` state and the connection-banner-with-queued-count text — replace banner copy with `Connection lost. Reconnect before sending.`.

- [ ] **Step 1: Write failing tests**

Append to `packages/pwa/tests/SessionView.test.tsx` (mirror existing patterns — `renderToStaticMarkup`):

```typescript
test("SessionView shows 'Sending message...' row while a chat send is pending", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      pendingChatSend={{
        id: "cm-1", kind: "chat_send",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "pending",
      }}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).toContain("Sending message");
  // composer disabled
  expect(markup).toMatch(/data-testid="chat-input"[^>]*disabled/);
});

test("SessionView shows timeout message when chat send timed out", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      pendingChatSend={{
        id: "cm-1", kind: "chat_send",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "timed_out",
      }}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).toContain("Message not confirmed");
});

test("SessionView no longer renders queued-count banner", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      connected={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).not.toContain("queued-count");
  expect(markup).toContain("Reconnect before sending");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/SessionView.test.tsx`

- [ ] **Step 3: Update SessionView**

Edit `packages/pwa/src/screens/SessionView.tsx`:

a) Update props:
```typescript
import type { PendingCommand } from "../hooks/pendingCommands";

export interface SessionViewProps {
  // ...existing fields...
  pendingChatSend?: PendingCommand;
  onDismissPendingCommand?: (id: string) => void;
}
```

b) Remove the local `queue` state and the `useEffect` that drains it. Remove the queue-related branch in `handleSend`:
```typescript
const handleSend = (e: React.FormEvent) => {
  e.preventDefault();
  const t = draft.trim();
  if (!t) return;
  onSendChat(t);
  setDraft("");
};
```

c) Compute pending flag and disabled state:
```typescript
const sending = pendingChatSend?.status === "pending";
const sendFailed = pendingChatSend?.status === "failed" || pendingChatSend?.status === "timed_out";
const composerDisabled = composerBlocked || !header.online || sending;
```

d) Replace the connection banner JSX with:
```tsx
{!connected && (
  <div
    className="bg-danger-subtle text-danger mb-2 rounded-md px-3 py-2 text-xs"
    data-testid="connection-banner"
  >
    Connection lost. Reconnect before sending.
  </div>
)}
```

e) Add a pending row above the form:
```tsx
{sending && (
  <div
    className="text-muted-foreground mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm"
    data-testid="chat-pending-row"
  >
    <span className="animate-pulse">●</span>
    <span>Sending message…</span>
  </div>
)}
{sendFailed && pendingChatSend && (
  <div
    className="bg-danger-subtle text-danger mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm"
    data-testid="chat-send-failure"
    role="alert"
  >
    <span>
      {pendingChatSend.status === "timed_out"
        ? "Message not confirmed. Try again."
        : `Message not confirmed: ${pendingChatSend.error ?? "send failed"}`}
    </span>
    {onDismissPendingCommand && (
      <Button
        onClick={() => onDismissPendingCommand(pendingChatSend.id)}
        size="sm"
        variant="ghost"
      >
        Dismiss
      </Button>
    )}
  </div>
)}
```

f) Update the input/button:
```tsx
<input
  className="..."
  data-testid="chat-input"
  disabled={composerDisabled}
  onChange={(e) => setDraft(e.target.value)}
  placeholder={
    composerBlocked
      ? "Waiting for permission"
      : header.online
        ? "Message Claude…"
        : "session offline"
  }
  value={draft}
/>
<Button
  disabled={composerDisabled || !draft.trim()}
  size="icon"
  type="submit"
  aria-label="Send"
>
  {sending ? (
    <span className="animate-spin" data-testid="send-spinner">…</span>
  ) : (
    <Send className="size-4" />
  )}
</Button>
```

- [ ] **Step 4: Wire RealApp.tsx**

Edit `packages/pwa/src/RealApp.tsx`:

a) Pull selectors:
```typescript
const { pendingChatSendFor, dismissPendingCommand /* ...others */ } = hub;
const pendingChatSend = selected ? pendingChatSendFor(selected.daemon_id, selected.session_id) : undefined;
```

b) Pass into `<SessionView>`:
```tsx
<SessionView
  ...
  pendingChatSend={pendingChatSend}
  onDismissPendingCommand={dismissPendingCommand}
/>
```

- [ ] **Step 5: Run tests**

Run: `cd packages/pwa && bun test tests/SessionView.test.tsx tests/App.test.tsx`
Expected: PASS. If `App.test.tsx` references the removed `queued-count` banner, update those assertions to match the new copy.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/SessionView.tsx packages/pwa/src/RealApp.tsx packages/pwa/tests/SessionView.test.tsx
git commit -m "feat(pwa): SessionView pending-send row, drop offline queue"
```

---

## Task 13: HomeScreen — start-session pending UI + timeout

**Files:**
- Modify: `packages/pwa/src/screens/HomeScreen.tsx`
- Modify: `packages/pwa/src/RealApp.tsx`
- Modify: `packages/pwa/tests/HomeScreen.test.tsx`

While a start_session is pending for a daemon: disable cwd input + plus button; show `Starting session…` inline; render the existing rejection banner on `failed`; show `Start not confirmed. Try again.` on `timed_out`.

- [ ] **Step 1: Write failing tests**

Append to `packages/pwa/tests/HomeScreen.test.tsx`:

```typescript
test("HomeScreen shows 'Starting session...' while pending", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[{
        daemon_id: "d", hostname: "host-1", online: true, sessions: [],
      }]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      pendingStartSessionByDaemon={{
        d: { id: "rs-1", kind: "start_session", daemon_id: "d",
             started_at: 0, status: "pending" },
      }}
      pendingKillByKey={{}}
    />,
  );
  expect(markup).toContain("Starting session");
  // cwd input disabled
  expect(markup).toMatch(/aria-label="Working directory[^"]*"[^>]*disabled/);
});

test("HomeScreen shows timeout copy when start_session timed_out", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[{
        daemon_id: "d", hostname: "host-1", online: true, sessions: [],
      }]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      pendingStartSessionByDaemon={{
        d: { id: "rs-1", kind: "start_session", daemon_id: "d",
             started_at: 0, status: "timed_out" },
      }}
      pendingKillByKey={{}}
    />,
  );
  expect(markup).toContain("Start not confirmed");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/HomeScreen.test.tsx`

- [ ] **Step 3: Implement**

Edit `packages/pwa/src/screens/HomeScreen.tsx`:

a) Update props:
```typescript
import type { PendingCommand } from "../hooks/pendingCommands";

export interface HomeScreenProps {
  // ...existing fields...
  pendingStartSessionByDaemon?: Record<string, PendingCommand>;
  pendingKillByKey?: Record<string, PendingCommand>;  // key: `${daemon_id}::${session_id}`
  onDismissPendingCommand?: (id: string) => void;
}
```

b) Pass `pendingStart={pendingStartSessionByDaemon?.[d.daemon_id]}` into `<DaemonCard>` and read it inside.

c) In `DaemonCard`, compute `starting = pendingStart?.status === "pending"`, `startTimedOut = pendingStart?.status === "timed_out"` and apply:
```tsx
<form className="mt-3 flex gap-2" onSubmit={submit}>
  <input
    aria-label={`Working directory for ${daemon.hostname}`}
    className="..."
    disabled={starting}
    onChange={(e) => setCwd(e.target.value)}
    placeholder="/path/to/project"
    value={cwd}
  />
  <Button
    aria-label="Start session"
    disabled={!cwd.trim() || starting}
    size="icon"
    type="submit"
  >
    {starting ? (
      <span className="animate-spin" data-testid="start-spinner">…</span>
    ) : (
      <Plus className="size-4" />
    )}
  </Button>
</form>
{starting && (
  <p
    className="text-muted-foreground mt-2 text-sm"
    data-testid={`start-session-pending-${daemon.daemon_id}`}
  >
    Starting session…
  </p>
)}
{startTimedOut && (
  <div
    className="bg-danger-subtle text-danger mt-2 rounded-md px-3 py-2 text-sm"
    data-testid={`start-session-timeout-${daemon.daemon_id}`}
    role="alert"
  >
    Start not confirmed. Try again.
  </div>
)}
```

d) For kill: in `SessionRow`, accept `pendingKill?: PendingCommand` prop and when `pendingKill?.status === "pending"`, replace the confirm strip with:
```tsx
<div
  className="bg-warning-subtle text-warning mt-2 flex items-center gap-2 rounded-md p-2 text-sm"
  data-testid={`kill-pending-${session.session_id}`}
>
  <span className="animate-pulse">●</span>
  <span>Killing session…</span>
</div>
```
And when `pendingKill?.status === "timed_out"`:
```tsx
<div
  className="bg-danger-subtle text-danger mt-2 rounded-md p-2 text-sm"
  role="alert"
>
  Kill not confirmed. Try again.
</div>
```

When pending, also force `setKillConfirm(null)` is not needed — the confirm UI is already replaced by the pending strip because we render based on `pendingKill` first.

e) In `RealApp.tsx`, build the maps and pass:
```typescript
const pendingStartSessionByDaemon = useMemo(() => {
  const out: Record<string, PendingCommand> = {};
  for (const v of Object.values(hub.pendingCommands)) {
    if (v.kind === "start_session") out[v.daemon_id] = v;
  }
  return out;
}, [hub.pendingCommands]);
const pendingKillByKey = useMemo(() => {
  const out: Record<string, PendingCommand> = {};
  for (const v of Object.values(hub.pendingCommands)) {
    if (v.kind === "kill_session" && v.session_id) {
      out[`${v.daemon_id}::${v.session_id}`] = v;
    }
  }
  return out;
}, [hub.pendingCommands]);
```

Pass to `<HomeScreen>`.

- [ ] **Step 4: Run tests**

Run: `cd packages/pwa && bun test tests/HomeScreen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/HomeScreen.tsx packages/pwa/src/RealApp.tsx packages/pwa/tests/HomeScreen.test.tsx
git commit -m "feat(pwa): HomeScreen start/kill session pending UI"
```

---

## Task 14: SessionTimeline — first-load and load-earlier states

**Files:**
- Modify: `packages/pwa/src/screens/timeline/SessionTimeline.tsx`
- Modify: `packages/pwa/src/hooks/useSessionTimeline.ts`
- Modify: `packages/pwa/src/RealApp.tsx`
- Modify: `packages/pwa/tests/SessionView.test.tsx` (or sibling test file for timeline)

Per spec §5.3: empty timeline + history pending = `Loading history...`; load-earlier button reads `Loading earlier events...` while pending; on timeout show `History load not confirmed.`. Coalescing is already enforced at useHub level (Task 9), so the existing 500ms `lastLoadAt` debounce becomes redundant — drop it.

- [ ] **Step 1: Write failing tests**

Add new test file `packages/pwa/tests/SessionTimeline.test.tsx` (or extend an existing timeline test):

```typescript
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTimeline } from "../src/screens/timeline/SessionTimeline";

test("SessionTimeline shows 'Loading history...' on empty + history pending", () => {
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[]}
      hasMoreEarlier={true}
      historyLoading={true}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("Loading history");
  expect(markup).not.toContain("Send a message to start");
});

test("SessionTimeline shows 'Loading earlier events...' button label while loading", () => {
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[{ tag: "agui", id: "x", ts: 0, event: { type: "RAW", event: {} } } as any]}
      hasMoreEarlier={true}
      historyLoading={true}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("Loading earlier events");
});

test("SessionTimeline shows timeout copy", () => {
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[]}
      hasMoreEarlier={true}
      historyTimedOut={true}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("History load not confirmed");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/SessionTimeline.test.tsx`

- [ ] **Step 3: Implement**

Edit `packages/pwa/src/screens/timeline/SessionTimeline.tsx`:

a) Add props:
```typescript
export interface SessionTimelineProps {
  // ...existing...
  historyLoading?: boolean;
  historyTimedOut?: boolean;
}
```

b) Replace the empty-state block:
```tsx
{items.length === 0 && (
  <p className="text-muted-foreground py-12 text-center text-sm">
    {historyLoading ? "Loading history…" : "Send a message to start."}
  </p>
)}
```

c) Replace the "Load earlier" button block:
```tsx
{hasMoreEarlier && items.length > 0 && (
  <div className="mb-3 flex justify-center">
    <Button
      onClick={onLoadEarlier}
      size="sm"
      variant="ghost"
      disabled={historyLoading}
    >
      {historyLoading ? "Loading earlier events…" : "Load earlier events"}
    </Button>
  </div>
)}
{historyTimedOut && (
  <div
    className="text-danger mb-3 text-center text-xs"
    role="alert"
  >
    History load not confirmed.
  </div>
)}
```

d) In `onScroll`, drop the `lastLoadAt` debounce; useHub coalescing replaces it:
```typescript
const onScroll = () => {
  const el = scrollRef.current;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  setAutoScroll(atBottom);
  if (hasMoreEarlier && el.scrollTop < 80 && items.length > 0) {
    onLoadEarlier();
  }
};
```

(Remove the `lastLoadAt = useRef(0)` and the time-based guard.)

- [ ] **Step 4: Wire useSessionTimeline + RealApp**

Edit `packages/pwa/src/hooks/useSessionTimeline.ts` to expose `historyLoading` and `historyTimedOut`:

```typescript
export interface UseSessionTimelineResult {
  // ...existing...
  historyLoading: boolean;
  historyTimedOut: boolean;
}
```

Inside the hook, after computing `selected`:
```typescript
const historyPending = selected ? hub.pendingHistoryFor(selected.daemon_id, selected.session_id) : undefined;
const historyLoading = historyPending?.status === "pending";
const historyTimedOut = historyPending?.status === "timed_out";
```

Return both fields. In `RealApp.tsx`, pass `historyLoading={sessionTimeline.historyLoading}` and `historyTimedOut={sessionTimeline.historyTimedOut}` through `<SessionView>` to `<SessionTimeline>` (add new pass-through props on `SessionViewProps` and forward).

- [ ] **Step 5: Run tests**

Run: `cd packages/pwa && bun test tests/SessionTimeline.test.tsx tests/SessionView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/timeline/SessionTimeline.tsx packages/pwa/src/hooks/useSessionTimeline.ts packages/pwa/src/RealApp.tsx packages/pwa/src/screens/SessionView.tsx packages/pwa/tests/SessionTimeline.test.tsx
git commit -m "feat(pwa): timeline first-load and load-earlier loading states"
```

---

## Task 15: PermissionSurface — submitting decision state

**Files:**
- Modify: `packages/pwa/src/screens/PermissionSurface.tsx`
- Modify: `packages/pwa/src/RealApp.tsx`
- Modify: `packages/pwa/tests/PermissionSurface.test.tsx`

When the active permission has a pending reply: disable both buttons, show `Submitting decision…`. On `permission_resolved` the parent unmounts the surface. On timeout: re-enable buttons and show `Decision not confirmed. Try again.`.

The optimistic `permissionQueue.advance()` after `sendPermissionReply` in `RealApp` must move to fire only when the request leaves `pendingPermissions` — i.e. wire `usePermissionQueue` to react to `pendingPermissions` changes.

- [ ] **Step 1: Write failing test**

Append to `packages/pwa/tests/PermissionSurface.test.tsx`:

```typescript
test("PermissionSurface shows 'Submitting decision...' while reply pending", () => {
  const markup = renderToStaticMarkup(
    <PermissionSurface
      request={{
        type: "permission_request",
        daemon_id: "d", session_id: "s", request_id: "p-1",
        tool: "Bash", args_summary: "ls",
        expires_at: 1_700_000_000,
      }}
      daemonHostname="host-1"
      queueIndex={1} queueSize={1}
      device="desktop"
      onAllow={() => {}}
      onDeny={() => {}}
      onClose={() => {}}
      pendingReply={{
        id: "p-1", kind: "permission_reply",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "pending", label: "allow",
      }}
    />,
  );
  expect(markup).toContain("Submitting decision");
  // both action buttons disabled
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Allow once/);
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Deny/);
});

test("PermissionSurface shows timeout copy when reply timed_out", () => {
  const markup = renderToStaticMarkup(
    <PermissionSurface
      request={{ type: "permission_request",
        daemon_id: "d", session_id: "s", request_id: "p-1",
        tool: "Bash", args_summary: "ls", expires_at: 0,
      }}
      daemonHostname="h"
      queueIndex={1} queueSize={1}
      device="desktop"
      onAllow={() => {}}
      onDeny={() => {}}
      onClose={() => {}}
      pendingReply={{
        id: "p-1", kind: "permission_reply",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "timed_out", label: "allow",
      }}
    />,
  );
  expect(markup).toContain("Decision not confirmed");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/pwa && bun test tests/PermissionSurface.test.tsx`

- [ ] **Step 3: Implement PermissionSurface**

Edit `packages/pwa/src/screens/PermissionSurface.tsx`:

a) Add prop:
```typescript
import type { PendingCommand } from "../hooks/pendingCommands";

export interface PermissionSurfaceProps {
  // ...existing...
  pendingReply?: PendingCommand;
}
```

b) Forward into `PermissionCard`. In the card body, compute `submitting = pendingReply?.status === "pending"` and `replyTimedOut = pendingReply?.status === "timed_out"` and replace the action block:

```tsx
<div className="mt-auto pt-5">
  {submitting && (
    <p
      className="text-muted-foreground mb-3 text-sm"
      data-testid="permission-submitting"
    >
      Submitting decision…
    </p>
  )}
  {replyTimedOut && (
    <p
      className="text-danger mb-3 text-sm"
      role="alert"
    >
      Decision not confirmed. Try again.
    </p>
  )}
  <div className="grid grid-cols-2 gap-3">
    <Button onClick={onDeny} size="lg" variant="secondary" disabled={submitting}>
      Deny
    </Button>
    <Button onClick={onAllow} size="lg" disabled={submitting}>
      Allow once
    </Button>
  </div>
</div>
```

- [ ] **Step 4: Update RealApp wiring**

Edit `packages/pwa/src/RealApp.tsx`:

a) Compute pending reply for the active surface:
```typescript
const pendingReply = permissionQueue.active
  ? hub.pendingCommands[permissionQueue.active.request_id]
  : undefined;
```

b) Remove the optimistic advance from the surface's `onAllow`/`onDeny`:
```tsx
<PermissionSurface
  ...
  pendingReply={pendingReply}
  onAllow={() => sendPermissionReply(active, "allow")}
  onDeny={() => sendPermissionReply(active, "deny")}
  ...
/>
```

c) Trigger queue advance off the `pendingPermissions` map. Add an effect:
```typescript
const activeRequestId = permissionQueue.active?.request_id;
useEffect(() => {
  if (!activeRequestId) return;
  if (!pendingPermissions[activeRequestId]) {
    permissionQueue.advance();
  }
}, [activeRequestId, pendingPermissions, permissionQueue]);
```

If `usePermissionQueue` doesn't expose a stable `advance`, ensure it does (memoized with `useCallback`).

- [ ] **Step 5: Run tests**

Run: `cd packages/pwa && bun test tests/PermissionSurface.test.tsx tests/usePermissionQueue.test.tsx tests/App.test.tsx`
Expected: PASS. If any usePermissionQueue test asserts the previous optimistic-removal behavior, update those assertions to match the new flow (resolved drives advance).

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/PermissionSurface.tsx packages/pwa/src/RealApp.tsx packages/pwa/tests/PermissionSurface.test.tsx
git commit -m "feat(pwa): PermissionSurface submitting state, drop optimistic advance"
```

---

## Task 16: Self-review pass and full-suite verification

**Files:** none new — verification only.

- [ ] **Step 1: Run all package test suites**

Run in parallel:
```bash
cd packages/proto && bun test
cd packages/hub && bun test
cd packages/daemon && bun test
cd packages/pwa && bun test
```

Expected: ALL PASS.

- [ ] **Step 2: Type-check**

Run: `bun run -w typecheck` (or, per package: `bun tsc --noEmit` if a typecheck script doesn't exist; consult the root `package.json` first).

Expected: 0 type errors.

- [ ] **Step 3: Spec coverage walk-through**

Manually walk through spec §3–§6, ensuring each row in the §4 table maps to:
- a useHub action that creates a pending entry,
- a frame branch that confirms or fails it,
- a 30s timeout (`COMMAND_TIMEOUT_MS`),
- visible UI per §5.

Specifically verify:
- `chat_send`: Task 1 + 3 + 7 + 12.
- `start_session`: Task 2 + 4 + 5 + 8 + 13.
- `request_history`: Task 9 + 14.
- `permission_reply`: Task 10 + 15.
- `kill_session`: Task 11 + 13 (kill UI lives in HomeScreen via SessionRow).

- [ ] **Step 4: Manual smoke (optional, encouraged)**

Run the app with the demo daemon (`docker compose -f e2e-real/docker-compose.demo.yml up`) and exercise:
- Send a chat message → see `Sending message…` row → confirms.
- Start a session in a daemon card → see `Starting session…` → success or rejection.
- Kill a session → see `Killing session…`.
- Approve / deny a permission → buttons disable + `Submitting decision…` appears → card unmounts on resolve.
- Force-disconnect (e.g. stop hub) and confirm composer disables and banner reads `Connection lost. Reconnect before sending.`

- [ ] **Step 5: Final commit (if any housekeeping needed)**

Only commit cleanup; otherwise this is a no-op task.

---

## Self-Review Notes

**Spec coverage:**
- §1 Goal: covered across all PWA tasks.
- §2 Principles (no optimistic insertion, 30s timeout, no offline queue): Tasks 7, 10, 12.
- §3 Architecture (registry in useHub): Tasks 6–11.
- §4 Confirmation Rules: each row has a frame-handler change in Tasks 7–11.
- §5 UI Behavior: §5.1 → 12; §5.2 → 13; §5.3 → 14; §5.4 → 15; §5.5 → 13 (kill subsection); §5.6 → 12 (banner copy).
- §6 Error handling: timeouts produce neutral copy (Tasks 12–15); failure frames carry specific copy (Tasks 12, 13).
- §7 Testing: every spec test maps to a Step 2 in Tasks 1–15.
- §8 Non-goals: nothing introduced here adds optimistic rendering or a new generic ack frame.

**Type consistency:**
- `client_message_id` (string), `request_id` (string) — used identically across proto, hub, daemon, useHub.
- `PendingCommand.id` is the `client_message_id` for chat, the `request_id` for start/history/permission, and `kill-${daemon}-${session}` for kill — explicitly stated where used.
- `pendingChatSendFor`, `pendingStartSessionFor`, `pendingHistoryFor`, `pendingKillFor`, `pendingCommands[request_id]` (for permission reply) — selectors named consistently.
- `dismissPendingCommand(id)` is the single dismissal API.

**No placeholders:** all TDD steps include the actual test code or implementation snippet.
