# Observability — Cross-Process OTel Tracing + Logs (SigNoz)

Date: 2026-05-28
Status: Draft (post-brainstorming)

## 1. Problem

Debugging a single user-visible issue today requires looking at four
disjoint stderr streams (PWA browser console, daemon, hub, plugin/MCP).
Logs are unstructured `process.stderr.write` strings with no shared
correlation key, no causal ordering, and no way to tell whether a frame
the daemon emitted and a frame the PWA rendered came from the same
round-trip. A user reporting "I sent a message and the reply never
showed up" forces a manual grep + timestamp-merge across files.

`request_id` exists per RPC frame in `packages/proto/src/frames.ts`,
but it does not span the whole chain (PWA click → … → CC reply).

## 2. Goals

- One root-spanned **trace** per user round-trip in a session: a chat
  send (or any user action) and *all* downstream activity it causes —
  hub routing, daemon handling, plugin MCP dispatch, CC's tool calls,
  JSONL-driven render-back, AskUserQuestion sub-loops — collapse into
  a single tree visible as a time-waterfall in SigNoz.
- All four processes emit OTel **traces + logs** to a local SigNoz
  stack started by `tools/demo-channel.sh`.
- Existing `process.stderr.write` lines are preserved as-is locally
  (muscle memory for `tail -f`), and *additionally* shipped to SigNoz
  with `trace_id`/`span_id` auto-injected when inside an active span.
- Disable path is a no-op: when `OTEL_*` env vars are absent the SDK
  init returns early and PWA never loads the OTel chunk.

## 3. Non-Goals

- Production deployment of SigNoz / public hub instrumentation. Step 1
  is local debug only; production is a future step that will reuse the
  same SDK code with different exporter config.
- Metrics signal. Only traces + logs.
- Auto-instrumentation of `fetch`, `http`, file system, etc. We pick
  span boundaries by hand to keep the surface small.
- Sampling. Local default = 100%. `CC_OBS_SAMPLE_RATIO` knob exists for
  future production use but is not exercised in step 1.
- Replacing existing `request_id` fields on frames. They stay; OTel
  context is additive.
- Web Vitals / RUM features.

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                      SigNoz (docker-compose profile)               │
│  signoz-otel-collector  •  clickhouse  •  query-svc  •  frontend   │
└──────────────▲────────────────▲──────────────▲──────────────▲──────┘
               │ OTLP/HTTP      │ OTLP/HTTP    │ OTLP/HTTP    │ OTLP/HTTP
               │  :4318         │  :4318       │  :4318       │  :4318
   ┌───────────┴────┐  ┌────────┴────┐  ┌──────┴──────┐  ┌────┴──────┐
   │ PWA (browser)  │  │ hub         │  │ daemon      │  │ plugin    │
   │ web SDK chunk  │  │ node SDK    │  │ node SDK    │  │ node SDK  │
   │ (lazy import)  │  │             │  │ + sessionMap│  │           │
   └────────┬───────┘  └──────┬──────┘  └──────┬──────┘  └────┬──────┘
            │ trace ctx        │                │              │
            └─► WS frame ──────► hub ──────────► daemon ◄──────┘
                                                  ▲
                                  JSONL tail / hook socket
                                  (attach by session_id)
```

New shared package: `packages/observability/`. Each process imports
`initOtel({ serviceName })` once at startup.

The two load-bearing mechanisms:

1. **Frame-carried W3C trace context** — forward path. Frames that
   trigger downstream work carry an optional `trace: { traceparent,
   tracestate? }` field. Receivers `propagator.extract()` to continue
   the trace.
2. **Daemon `sessionMap`** — backward path. Daemon keeps
   `Map<session_id, ActiveTrace>`. Forward frames populate it. JSONL
   tail / hook socket / permission relay look up the active trace by
   `session_id` and create child spans on it. Final `stop_reason` (or
   5-minute TTL) ends the root span and removes the entry.

## 5. Protocol

Add to `packages/proto/src/frames.ts`:

```ts
export type TraceCtx = {
  traceparent: string;          // W3C: "00-<trace_id>-<span_id>-<flags>"
  tracestate?: string;
};
```

Frames that carry an optional `trace?: TraceCtx`:

- `chat_in`
- `start_session`
- `kill_session`
- `ask_user_question_answer`
- `permission_decision`

Notification frames *not* extended (their span is created by the
emitter via `sessionMap`):

- `session_started`, `session_closed`, `tool_use`, `assistant_message`,
  `bind_resolved`, `start_session_rejected`, `permission_request`,
  `ask_user_question_request`.

Receivers MUST tolerate the field being absent (older clients, opt-out
case): when missing, the receiver creates a root span itself, so the
trace simply starts further downstream.

## 6. Spans

Coarse list — names are stable identifiers, not freeform strings.

### daemon (`packages/daemon/src/`)

| span | trigger | attrs |
|---|---|---|
| `daemon.handleChat` | `chat_in` frame | session_id, daemon_id, message_len |
| `daemon.handleStartSession` | `start_session` frame | cwd, has_spawn_command |
| `daemon.handleKillSession` | `kill_session` frame | session_id |
| `daemon.bindJsonl` | `bindJsonl()` call | path, wait_ms_total |
| `daemon.jsonlEvent` | watcher emits | event_type, tool_name?, line_byte_size |
| `daemon.askUserRelay` | hook socket inbound | tool_use_id |
| `daemon.permissionRelay` | plugin permission_request | tool_name |

### hub (`packages/hub/src/`)

| span | trigger |
|---|---|
| `hub.routeFrame` | every cross-direction forward |
| `hub.pairIssue` | `POST /pair/issue` |
| `hub.pairRefresh` | `POST /pair/refresh` |
| `hub.wsAuth` | DPoP verify on `/ws/daemon` |

### plugin (`packages/plugin/src/`)

| span | trigger |
|---|---|
| `plugin.dispatch` | MCP `tools/call` entry |
| `plugin.<toolName>` | per resolved tool |

### PWA (`packages/pwa/src/`)

| span | trigger |
|---|---|
| `pwa.user.sendChat` | composer Send |
| `pwa.user.startSession` | new-session button |
| `pwa.user.answerQuestion` | AskUserQuestion submit |
| `pwa.user.permissionDecide` | allow/deny click |
| `pwa.render.<frame_type>` | inbound frame carrying trace ctx |

## 7. Data Flow — One Round-Trip

### Forward (user → CC)

```
PWA Send click
 └ tracer.startActiveSpan("pwa.user.sendChat")              [root]
    │ attrs: { session_id, daemon_id, message_len }
    ├ ws.send({ type:"chat_in", trace: W3C(currentSpan), … })
    │
hub recv
 └ propagator.extract(frame.trace) → ctx
    └ startSpan("hub.routeFrame", { parent: ctx })
       └ ws.send to daemon (with trace ctx forwarded)
          │
daemon recv
 └ extract → startSpan("daemon.handleChat", { parent })
    │ sessionMap.set(session_id, { rootCtx, rootSpan })     [pin]
    └ socket.send to plugin (with ctx forwarded)
       │
plugin recv (CC's MCP tools/call)
 └ extract → startSpan("plugin.dispatch", { parent })
    └ child spans per tool
```

### Backward attachment (CC → user)

```
daemon JSONL watcher reads new line for session X
 └ active = sessionMap.get(X)                               [revive]
    └ startSpan("daemon.jsonlEvent", { parent: active.rootCtx })
       └ ws.send({ type:"tool_use" or "assistant_message",
                   trace: W3C(currentSpan), … })
          ↓ hub.routeFrame (child) ↓
          PWA recv → startSpan("pwa.render.toolUse", { parent })
                     UI renders, span ends.

AskUserQuestion (PreToolUse hook → daemon socket)
 └ active = sessionMap.get(X)
    └ startSpan("daemon.askUserRelay", { parent }) — kept open until
      ask_user_question_answer arrives carrying its own ctx, which
      becomes a sibling under the same parent.

permission_request (plugin → daemon)
 └ plugin's current ctx is still plugin.dispatch's child — the frame
   carries it; daemon attaches naturally without sessionMap lookup.
```

### Round-trip end

daemon's JSONL watcher detects a final `assistant` message with
`stop_reason` set:

```
active = sessionMap.get(X)
active.rootSpan.end()
sessionMap.delete(X)
```

Fallback: each `sessionMap` entry stamps a TTL (5 min). A periodic
sweep ends and evicts entries whose last activity exceeds TTL, so a
missed `stop_reason` cannot leak unbounded.

### Edge cases

- **Two messages in one session before first finishes**: CC
  serializes, but to be safe `sessionMap` value is a stack
  `ActiveTrace[]`. New `chat_in` pushes; `stop_reason` pops top. JSONL
  events attach to the top of stack.
- **PWA opt-out (no chunk loaded)**: `chat_in` arrives without `trace`
  field. hub creates root span itself → the trace starts at hub. PWA
  side simply has no UI spans.
- **No session_id on event** (daemon startup, idle ticks): emit as a
  log only, no span.

## 8. Logs

`packages/observability/src/logger.ts` exports:

```ts
export const log = {
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
};
```

Implementation:

1. Always write `${level} ${service}: ${msg}\n` to `process.stderr`
   (preserves existing `tail -f` workflow).
2. If OTel is enabled, also emit an OTLP log record. The OTel SDK
   automatically injects `trace_id` + `span_id` from the active
   context, so SigNoz's UI can pivot from a log line to the parent
   trace.

All `process.stderr.write` call sites in `packages/daemon/src`,
`packages/hub/src`, `packages/plugin/src` are migrated to `log.*` as
part of this work.

PWA does not ship logs to OTLP in step 1 (chunk size + browser CORS
hassle). PWA spans alone are sufficient; the browser's own console
output is fine for the rare PWA-internal log.

## 9. Configuration

| env var | default | meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset → disabled) | collector URL, e.g. `http://localhost:4318` |
| `OTEL_SERVICE_NAME` | per-process literal (`daemon`, `hub`, `plugin`, `pwa`) | service identity in SigNoz |
| `CC_OBS_SAMPLE_RATIO` | `1.0` | always-on sampler; reserved for production |
| `CC_OBS_LOG_LEVEL` | `info` | filter for OTLP log emission |
| `VITE_OTEL_ENABLED` | unset → no chunk | flips the dynamic import in PWA bootstrap |

`packages/observability/src/init.ts` short-circuits and returns a no-op
tracer/logger when `OTEL_EXPORTER_OTLP_ENDPOINT` is absent. SDK
failures (`onError`) downgrade silently to that same no-op.

## 10. Local Startup

`tools/demo-channel.sh` gains `--otel`:

```
./tools/demo-channel.sh up           # unchanged, no SigNoz
./tools/demo-channel.sh up --otel    # spins up SigNoz + sets env vars
```

When `--otel` is on:

1. `docker compose -f e2e-real/docker-compose.signoz.yml up -d`
   (5 services; isolated profile; persists nothing — `tmpfs`
   ClickHouse for fast teardown).
2. Daemon, hub, plugin spawn with
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
3. PWA dev server gets `VITE_OTEL_ENABLED=1`.
4. Script prints `SigNoz UI: http://localhost:3301` and waits for
   collector readiness (HTTP 200 on `/v1/traces` with empty body) before
   spawning daemon.

`down --otel` tears the SigNoz stack down too.

## 11. Testing

### Unit (`packages/observability/`)

- W3C propagator round-trip (extract→inject yields the same
  traceparent).
- `sessionMap` push/pop semantics under concurrent stack ops.
- `sessionMap` TTL sweep ends abandoned root spans.
- `log.*` no-op path: no OTLP exporter calls, stderr still written.
- `initOtel` short-circuits when env unset.

### Integration

- daemon test: feed a fake `chat_in` with `trace`, assert
  `daemon.handleChat` span has `traceparent`'s trace_id as parent.
- daemon test: simulate JSONL line for a session whose `sessionMap`
  has an active trace; assert the emitted frame's `trace` field
  references that trace_id.

### End-to-End (the goal-required validation)

`e2e-real/scenarios/30-otel-trace.test.ts`:

1. Start SigNoz + demo stack via the existing harness with `--otel`.
2. Pair daemon, sign in PWA, start a session, send one chat message.
3. Wait for the assistant reply to render in the PWA (existing helper).
4. Query SigNoz's trace API
   (`GET /api/v1/traces?serviceName=pwa&limit=10`), find the trace
   whose root span name is `pwa.user.sendChat`.
5. Assert the trace contains, *in this child relationship*:
   - `pwa.user.sendChat`
     - `hub.routeFrame`
       - `daemon.handleChat`
         - `plugin.dispatch` (≥1)
     - `daemon.jsonlEvent` (≥1, `event_type=assistant_message`)
       - `hub.routeFrame`
         - `pwa.render.assistantMessage`
6. Assert all spans share one `trace_id`. Assert no orphan span exists
   for that session.

This single test validates: (a) frame propagation works,
(b) `sessionMap` revives the trace from JSONL, (c) round-trip ends
correctly. It is the definition of "trace is correct" for step 1.

### Disable path

Existing test scenarios run unchanged with `--otel` absent —
`initOtel()` is a no-op, `log.*` falls back to stderr, no SDK
side-effects.

## 12. Migration of Existing `process.stderr.write` Calls

In-scope replacements (auto-grep list, ~30 sites):

- `packages/daemon/src/index.ts` — all `daemon: …` startup, register,
  spawn, watcher, ask_user_question lines.
- `packages/daemon/src/hub-client.ts` — DPoP / WS error lines.
- `packages/daemon/src/chat.ts` — `log` parameter default.
- `packages/hub/src/push.ts` — `fileLogHelper` mkdir error.
- Other callers using stderr in hub.

Mechanical:
`process.stderr.write(`daemon: msg ${x}\n`)` →
`log.info("msg", { x })`. Service name comes from `initOtel`. The
human-readable stderr line is reconstructed inside `log.*`.

## 13. Risks & Open Questions

- **Plugin runs as a child of CC's MCP host process** — exit handling
  must flush exporter on `SIGTERM` so spans aren't lost. Use
  `forceFlush()` in the existing graceful-shutdown handler.
- **Browser SDK chunk size** — `@opentelemetry/sdk-trace-web` plus the
  OTLP HTTP exporter is ~80KB gzipped. Acceptable as a lazy chunk;
  flagged here so anyone touching PWA bundle budgets sees it.
- **OTLP endpoint inside docker for hub** — hub container must be on
  the same docker network as the SigNoz collector, or the collector
  must expose `:4318` on host. Demo compose will publish the port.
- **Schema drift on `event_type` strings** — `daemon.jsonlEvent` attrs
  use the JSONL line's `type` field verbatim. If CC changes that
  vocabulary, the e2e assertion above needs updating; acceptable.
- Future production deploy: collector endpoint, sampling, redaction of
  `message_len` / tool args, and auth on SigNoz's UI are deferred.

## 14. Out of Scope (Explicit)

- Replacing `request_id` with trace context.
- Auto-instrumenting `fetch` / `http` / `fs`.
- Metrics signal.
- PWA log shipping.
- Production hub deploy of SigNoz.
- Trace context on push notifications (web-push payload size).
- Redaction / PII handling on attributes.
