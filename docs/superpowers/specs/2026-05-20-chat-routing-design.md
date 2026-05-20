# Chat routing — Design Spec

**Date:** 2026-05-20
**Status:** Approved (continuation of plugin MCP rework which deferred this layer)
**Project:** open-cc-remote
**Scope:** Close the chat loop end-to-end: PWA can send a free-form message to a paired Claude session, and Claude's `reply` tool output flows back to the PWA. Plugin↔Daemon frames already exist (from `plan-plugin-mcp-rework`); this plan wires the missing layers (Daemon↔Hub, Hub↔PWA, and PWA UI).

## 1. Goal

Make the cc-remote PWA usable as a real "remote Claude" interface. User should be able to:
1. Open the PWA, see a paired session.
2. Type a message in a per-session input box, hit Enter.
3. The message arrives in Claude as a `<channel source="cc-remote" ...>` injection.
4. Claude responds via the `reply` tool; the response shows up in the PWA's chat panel.
5. Multiple PWA tabs see the same chat history (broadcast to all subscribers of that user).

## 2. Non-goals

- File / image attachments in the chat (`reply` tool's `files` parameter stays out per rework spec §5.4).
- Rich threading UI; `reply_to` field is plumbed through but visualization is plain inline.
- Chat persistence beyond the session lifetime (chat history is in-memory on the hub for v1; reload of the PWA after a daemon disconnect loses messages).
- Multi-user chat (only the PWA owner sees their own session's messages).

## 3. Components & flow

```
            PWA (browser)                    Hub (docker)              Daemon (host)             Plugin (MCP)              Claude
            ──────────                       ────────                  ─────────                 ───────────              ──────
type & enter ─→ chat_send(daemon_id,        WS                        UnixSocket                  stdio
                   session_id, content) ──────────→ chat_send ──────────→ chat_in ───────────────→ notifications/         channel injection
                                                  (looks up daemon, gen   (forwards verbatim)      claude/channel
                                                   message_id, attaches
                                                   user/user_id)
                ←── chat (echo, from:"pwa")  Hub broadcasts to all PWA subs
                                                                                                                          claude calls reply tool
                                                                                                  ←── chat_out
                                                  ←── chat_out ───────────
                ←── chat (from:"claude")    Hub broadcasts to all PWA subs
                                                  (gen message_id, ts)
```

## 4. Frame types (proto changes)

Adds 4 new frames in `packages/proto/src/frames.ts`:

```ts
// PWA → Hub
export interface PwaToHubChatSend {
  type: "chat_send";
  daemon_id: string;
  session_id: string;
  content: string;
  reply_to?: string;
}

// Hub → Daemon (forwarded chat_send; daemon_id stripped, hub-generated message_id, user/user_id from bearer)
export interface HubToDaemonChatSend {
  type: "chat_send";
  session_id: string;
  message_id: string;          // ULID, hub-generated
  user: string;                // bearer subject (email)
  user_id: string;             // bearer sub claim
  content: string;
  reply_to: string | null;
  ts: number;                  // unix seconds
}

// Hub → PWA (broadcast for both directions; multiple PWA tabs see the same chat)
export interface PwaChatBroadcast {
  type: "chat";
  daemon_id: string;
  session_id: string;
  message_id: string;
  from: "pwa" | "claude";
  user: string | null;          // populated when from = "pwa" (echo of sender), null for "claude"
  content: string;
  reply_to: string | null;
  ts: number;
}
```

`HubToDaemon` union extends with `HubToDaemonChatSend`. `DaemonToHub` union extends with the existing `PluginChatOut` (the daemon forwards plugin's chat_out verbatim, just replacing `daemon → hub` direction in the union). `PwaToHub` extends with `PwaToHubChatSend`. `HubToPwa` extends with `PwaChatBroadcast`.

The plugin↔daemon frames (`PluginChatOut`, `DaemonChatIn`) are already defined and unchanged.

## 5. Hub routing logic

In `packages/hub/src/router.ts`:

**Inbound from PWA — `chat_send`:**
1. Authenticate bearer → resolve `user` (email) + `user_id` (sub).
2. Look up the daemon connection by `frame.daemon_id`. If not online: emit error `chat_error` to source PWA.
3. Generate `message_id` (ULID) + `ts` (Date.now() / 1000).
4. Send `HubToDaemonChatSend` to the daemon over its WS.
5. Broadcast `PwaChatBroadcast` to ALL PWA subscribers of this user with `from: "pwa"` (echo).

**Inbound from daemon — `chat_out`:**
1. Generate `message_id` + `ts` if missing (daemon supplies ts; hub generates message_id since plugin doesn't).
2. Broadcast `PwaChatBroadcast` to ALL PWA subscribers with `from: "claude"`.

The hub keeps no chat persistence in v1 — purely pub/sub. (PWA reload sees nothing until next message.)

## 6. Daemon translation

In `packages/daemon/src/index.ts` (or a new `chat.ts` module):

**Inbound from hub — `chat_send`:**
1. Look up plugin connection for `session_id` (existing session→socket map).
2. Translate to `DaemonChatIn` and write over the Unix socket. (Field shapes match exactly except the daemon doesn't add anything — pass `message_id`, `user`, `user_id`, `content`, `ts` straight through.)

**Inbound from plugin — `chat_out`:**
1. Translate field-for-field to `DaemonToHub` direction (just forward the frame with `type: "chat_out"`, same fields).

The daemon is mostly a pipe; both translations are field-rename / no-op routing.

## 7. PWA UI minimal surface

`packages/pwa/src/SessionPane.tsx` already shows the session's event stream. Add at the bottom:

```tsx
<form onSubmit={handleSend}>
  <input
    type="text"
    placeholder="Send a message to Claude…"
    value={draft}
    onChange={(e) => setDraft(e.target.value)}
    disabled={!sessionOnline}
  />
  <button type="submit" disabled={!draft.trim()}>Send</button>
</form>
<div className="chat-log">
  {chatMessages.map((m) => (
    <div className={`chat-msg from-${m.from}`} key={m.message_id}>
      <span className="from">{m.from === "pwa" ? (m.user ?? "you") : "claude"}</span>
      <span className="content">{m.content}</span>
      <span className="ts">{new Date(m.ts * 1000).toLocaleTimeString()}</span>
    </div>
  ))}
</div>
```

`useHub.ts` extends:
- New `chatMessages: Record<string, PwaChatBroadcast[]>` keyed by `eventKey(daemon_id, session_id)`.
- New `sendChat(daemon_id, session_id, content, reply_to?)` function that emits `PwaToHubChatSend`.
- WS frame handler appends incoming `chat` frames to the right bucket.

Styling intentionally minimal — match existing event-stream look.

## 8. Tests

**proto-level (unit):** add to `packages/proto/tests/frames.test.ts` — type discriminator coverage for the 3 new frames.

**daemon (unit):** new test file `packages/daemon/tests/chat.test.ts`. Mock plugin socket, mock hub WS. Send `chat_send` from mock hub → assert plugin socket receives `chat_in` with same fields. Send `chat_out` from mock plugin → assert mock hub WS receives forwarded chat_out.

**hub (unit):** extend `packages/hub/tests/router.test.ts` — chat_send → daemon receives + PWA echo broadcast; chat_out from daemon → all PWA broadcasts get it; chat_send to offline daemon → chat_error returned.

**in-process e2e (`e2e/`):** new `chat.test.ts` — end-to-end via fake-claude (uses the existing in-process harness). PWA-equivalent client sends chat_send → fake-claude receives chat_in → fake-claude emits chat_out → PWA-equivalent receives broadcast.

**real e2e (`e2e-real/`):** new `12-chat-roundtrip.test.ts` — tmux + real claude. PWA-equivalent sends chat_send to a real claude session, asserts hub broadcasts the echo + claude's `reply` tool result.

**Existing 154 unit tests + 12 real-e2e:** must remain green.

## 9. Open questions

1. **Persistence on PWA reload.** v1 does no replay; if the user reloads the PWA mid-conversation, they lose chat history. Out of scope; tracked as future enhancement.
2. **Rate limiting / abuse.** No per-session rate limit on chat_send. Single-user system; out of scope.
3. **`chat_error` frame shape.** v1: `{ type: "chat_error", daemon_id, session_id, reason }`. Add to `HubToPwa` union but PWA UI just toasts/console-logs in v1.
4. **Multi-tab race.** Two PWA tabs sending simultaneously — both messages get distinct message_ids, both echo to both tabs. No ordering guarantee beyond per-tab order. Acceptable.

## 10. Out of scope (v2+ candidates)

- File attachments
- Chat history persistence (DB-backed)
- Searchable chat
- Per-message edit / delete
- Threading UI for `reply_to`
- Read-receipts
- Typing indicators
