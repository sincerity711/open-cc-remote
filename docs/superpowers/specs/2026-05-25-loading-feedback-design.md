# Loading Feedback Design

Date: 2026-05-25
Status: Draft for user review

## 1. Goal

The PWA should show clear loading feedback after the user sends a request, without pretending that the requested work has succeeded before the hub or daemon confirms it.

This design covers six outbound paths:

- Send a chat message.
- Start a workspace session.
- Load earlier session history.
- Reply to a permission request.
- Kill a session.
- Connect and reconnect behavior that affects whether commands can be sent.

## 2. User Experience Principles

The interaction model is **strict confirmation**:

- A click immediately shows local loading feedback.
- The UI does not insert successful business output until a confirming frame arrives.
- Loading clears only when a matching confirmation, failure, disconnect, or timeout is observed.
- The timeout is **30 seconds** for every command type.
- When a command times out, the UI says the confirmation was not received and lets the user retry. A timeout does not claim the daemon failed to act.

Offline behavior follows the same rule. The composer and command buttons are disabled while disconnected. The current local message queue behavior should be removed for chat sending, because queuing a message locally conflicts with strict confirmation and makes the message look more sent than it is.

## 3. Architecture

`packages/pwa/src/hooks/useHub.ts` becomes the source of truth for outbound command loading state.

Add an outbound pending registry to the hub state. Components call existing `sendX` methods, and `useHub` records a pending command before sending the websocket frame.

Example shape:

```ts
type PendingCommandKind =
  | "chat_send"
  | "start_session"
  | "request_history"
  | "permission_reply"
  | "kill_session";

type PendingCommandStatus = "pending" | "failed" | "timed_out";

interface PendingCommand {
  id: string;
  kind: PendingCommandKind;
  daemon_id: string;
  session_id?: string;
  started_at: number;
  status: PendingCommandStatus;
  label?: string;
  error?: string;
}
```

Confirmed commands are removed from the registry. Failed and timed-out commands remain long enough for components to render an inline error and offer retry or dismissal.

Consumers should not scan the registry manually. `useHub` should expose small selectors or derived helpers for common lookups, for example:

- pending chat send for a session.
- pending start for a daemon.
- pending history load for a session.
- pending permission reply by request id.
- pending kill for a session.

## 4. Confirmation Rules

| Command | Pending id | Confirmation | Failure | Timeout |
|---|---|---|---|---|
| `chat_send` | PWA-generated `client_message_id` | `chat` frame with matching `client_message_id` | `chat_error` with matching `client_message_id` | 30 seconds |
| `start_session` | PWA-generated `request_id` | `session_open` with matching `request_id` | `start_session_rejected` with matching `request_id` | 30 seconds |
| `request_history` | Existing `request_id` | `history_chunk` with matching `request_id`, including empty chunks | none in v1 | 30 seconds |
| `permission_reply` | Existing permission `request_id` | `permission_resolved` with matching `request_id` | none in v1 | 30 seconds |
| `kill_session` | Local id keyed to daemon/session | `session_close` for the target session | none in v1 | 30 seconds |

The first implementation should add the smallest protocol changes needed for reliable matching:

- Add `client_message_id` to PWA `chat_send`.
- Preserve `client_message_id` on `chat` and `chat_error` frames broadcast back to the PWA.
- Make PWA always send `request_id` on `start_session`; the protocol already allows it.
- Add optional `request_id` to `session_open` on the daemon-to-hub and hub-to-PWA frames. It is present only when the session was spawned from a PWA `start_session` command. Existing plugin registration flows can keep omitting it.

For `kill_session`, there is no explicit rejection frame today. The UI relies on `session_close` or timeout.

## 5. UI Behavior

### Send Message

When the user submits a message:

- Clear the input after the command is sent to the websocket.
- Disable the composer while the matching send is pending.
- Show the send button as a spinner.
- Show a lightweight timeline row at the bottom: `Sending message...`.
- Remove the pending row when the matching `chat` frame arrives.
- On `chat_error` or timeout, restore the composer and show `Message not confirmed. Try again.`

Do not insert a user message into the timeline until the hub broadcasts the confirmed chat event.

### Start Workspace Session

When the user starts a session from a daemon card:

- Disable the cwd input and plus button.
- Show the plus button as a spinner.
- Show inline text under the form: `Starting session...`.
- Clear loading when `session_open` confirms success.
- On `start_session_rejected`, show the existing start-session error area.
- On timeout, show `Start not confirmed. Try again.`

The pending state is scoped to the daemon card, not global.

### Load Earlier History

When history is requested:

- For first-load into an empty timeline, replace the empty state with `Loading history...`.
- For load-earlier, turn the top button into `Loading earlier events...` with a spinner.
- Clear loading when `history_chunk` arrives, including an empty chunk.
- Hide the button when the empty chunk marks no more history.
- On timeout, restore the button and show `History load not confirmed.`

Multiple history requests for the same session should be coalesced while one is pending.

### Permission Reply

When the user clicks Allow or Deny:

- Keep the permission card visible.
- Disable both decision buttons.
- Show the clicked action as loading.
- Show card text: `Submitting decision...`.
- Remove the card only when `permission_resolved` arrives.
- On timeout, re-enable the buttons and show `Decision not confirmed. Try again.`

The current optimistic removal in `sendPermissionReply` should be removed.

### Kill Session

When the user confirms kill:

- Keep the session row visible.
- Replace the confirmation strip with `Killing session...`.
- Disable Cancel and Kill.
- Remove the row when `session_close` arrives.
- On timeout, restore the confirmation UI and show `Kill not confirmed. Try again.`

### Connect And Reconnect

When disconnected:

- Disable all websocket-backed actions.
- Keep existing timeline and session data readable.
- Show the existing connection banner, with copy aligned to strict confirmation: `Connection lost. Reconnect before sending.`
- Do not auto-resend timed-out commands after reconnect.
- Do not queue new chat messages locally while disconnected.

Reconnect only restores command availability. It does not imply that an old timed-out command succeeded or failed.

## 6. Error Handling

Timeouts produce a neutral "not confirmed" message. This wording is intentional because the daemon may still complete the work after the PWA misses the confirmation.

Failure frames produce specific error copy where available:

- `chat_error.reason`
- `start_session_rejected.reason` and `message`

For v1, `request_history`, `permission_reply`, and `kill_session` have no explicit failure frame. Their failure path is timeout or disconnect.

If the websocket is closed while commands are pending, those commands should remain visible until they either hit the 30-second timeout or the user dismisses the local error. They should not be silently removed on disconnect.

## 7. Testing

Add focused tests around the state model and visible UI:

- `useHub`: creates pending commands, clears on confirmation, marks failure, marks 30-second timeout.
- `useHub`: no optimistic permission removal after `permission_reply`.
- `SessionView`: send pending row, disabled composer, timeout error, and no offline local queue.
- `HomeScreen`: start-session spinner, `session_open` cleanup, rejection display, timeout display.
- `SessionTimeline`: first history load and load-earlier loading states.
- `PermissionSurface` or permission inline card: submitting decision state and timeout recovery.
- `SessionRow`: kill pending state, `session_close` cleanup, timeout recovery.

Protocol tests should cover:

- `chat_send.client_message_id` round-trips through hub `chat` and `chat_error`.
- PWA-generated `start_session.request_id` is forwarded to daemon and returned on both `session_open` and `start_session_rejected` when applicable.

## 8. Non-Goals

This design does not introduce optimistic rendering.

This design does not require a generic `command_ack` protocol in v1.

This design does not add explicit rejection frames for every command. Missing rejection paths are handled by the 30-second timeout.

This design does not change daemon session state semantics (`idle`, `working`, `waiting`, `offline`) except where those states are used to disable command entry points.
