# Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax. The terminal validation is the e2e in Task 8.

**Goal:** Cross-process OpenTelemetry traces + logs (SigNoz backend) for one user round-trip in the local demo. The e2e in Task 8 — sending one chat message and asserting the trace tree shape in SigNoz — is the definition of done.

**Spec:** `docs/superpowers/specs/2026-05-28-observability-design.md`

**Tech:** Bun + TypeScript. Vitest-style `bun test`. Playwright + docker compose. `@opentelemetry/*` packages.

---

## File map

| Path | What |
|---|---|
| `packages/observability/package.json` | **new** — declares OTel deps |
| `packages/observability/src/init.ts` | **new** — `initOtel({ serviceName })`; no-op when env unset |
| `packages/observability/src/logger.ts` | **new** — `log.info/warn/error`; stderr + OTLP |
| `packages/observability/src/session-map.ts` | **new** — daemon's `Map<session_id, ActiveTrace[]>` with TTL |
| `packages/observability/src/propagator.ts` | **new** — `injectFrame(span)` / `extractFrame(frame)` helpers |
| `packages/observability/src/web.ts` | **new** — PWA-side lazy init (sdk-trace-web) |
| `packages/observability/tests/*.test.ts` | **new** — unit tests |
| `packages/proto/src/frames.ts` | extend — add `TraceCtx` and optional `trace?` on 5 frames |
| `packages/proto/tests/frames.test.ts` | extend — JSON round-trip including `trace` |
| `packages/daemon/src/index.ts` | wrap handlers in spans; `sessionMap` lifecycle; migrate stderr→log |
| `packages/daemon/src/hub-client.ts` | migrate stderr; emit DPoP span on send if active |
| `packages/daemon/src/jsonl-watcher.ts` (or wherever bind/tail lives) | `daemon.jsonlEvent` span via sessionMap lookup |
| `packages/hub/src/router.ts` (or `index.ts`) | `hub.routeFrame` span around forward; migrate stderr |
| `packages/plugin/src/index.ts` | `plugin.dispatch` span on tools/call; per-tool child |
| `packages/pwa/src/main.tsx` | conditional `import('./otel')` chunk on `VITE_OTEL_ENABLED` |
| `packages/pwa/src/otel/index.ts` | **new** — registers web tracer + helpers |
| `packages/pwa/src/hooks/useHub.ts` | wrap chat send in `pwa.user.sendChat`; emit `pwa.render.<type>` on inbound |
| `e2e-real/docker-compose.signoz.yml` | **new** — SigNoz stack |
| `e2e-real/helpers/signoz.ts` | **new** — query helpers (`waitForTrace`, `getTraceTree`) |
| `e2e-real/tests/30-otel-trace.test.ts` | **new** — the validation test |
| `tools/demo-channel.sh` | add `--otel` flag |

---

## Task 1 — `packages/observability` foundation (TDD)

**Files:**
- Create: `packages/observability/package.json`
- Create: `packages/observability/src/{init,logger,session-map,propagator}.ts`
- Create: `packages/observability/tests/{logger,session-map,propagator}.test.ts`

- [ ] **Step 1: Tests first**
  - `propagator.test.ts`: round-trip — span context → `injectFrame()` produces W3C `traceparent` ; `extractFrame()` returns equivalent span context.
  - `session-map.test.ts`: push/pop semantics; TTL sweep ends abandoned root spans; concurrent same-session pushes form a stack.
  - `logger.test.ts`: with OTLP disabled, `log.info("x", {a:1})` writes `info <service>: x {"a":1}\n` to stderr exactly once and never imports the OTel SDK.

- [ ] **Step 2: Implement `init.ts`**
  - When `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` is unset, return `{ tracer: noopTracer, shutdown: () => {} }` and skip SDK import.
  - When set, register `NodeTracerProvider` + `OTLPTraceExporter` + `BatchSpanProcessor` with `Resource{ "service.name": serviceName }`, plus `LoggerProvider` + `OTLPLogExporter` for logs. Always-on sampler (or read `CC_OBS_SAMPLE_RATIO`).
  - `shutdown()` flushes both providers; daemon/plugin/hub call this on `SIGTERM`.

- [ ] **Step 3: Implement `logger.ts`**
  - `log.{info,warn,error}(msg, attrs?)`: write `${level} ${service}: ${msg}${attrs ? " " + JSON.stringify(attrs) : ""}\n` to stderr; if OTel enabled, emit OTLP log record (SDK auto-injects `trace_id`/`span_id` from active context).

- [ ] **Step 4: Implement `propagator.ts`**
  - `injectFrame(spanCtx) -> TraceCtx`: use `@opentelemetry/api`'s `propagation.inject` with `W3CTraceContextPropagator` into a plain object, return `{ traceparent, tracestate? }`.
  - `extractFrame(trace?: TraceCtx) -> Context`: returns parent context if present, else `ROOT_CONTEXT`.

- [ ] **Step 5: Implement `session-map.ts`**
  - `class SessionMap`: `push(session_id, ActiveTrace)`, `peek(session_id)`, `pop(session_id)`, internal `Map<string, ActiveTrace[]>`. Per-entry `lastActivityMs` is bumped on `peek`. Background `setInterval(sweepFn, 60_000)` ends + evicts entries with `lastActivityMs < now - 5*60_000`.

- [ ] **Step 6: Run `bun test packages/observability`** — all green.

---

## Task 2 — Proto extension

**Files:**
- Modify: `packages/proto/src/frames.ts`
- Modify: `packages/proto/tests/frames.test.ts`

- [ ] **Step 1: Test** — extend an existing JSON round-trip test for `chat_in` to include a `trace: { traceparent: "00-..." }` and assert it round-trips.

- [ ] **Step 2: Implement** — export `TraceCtx`. Add optional `trace?: TraceCtx` to:
  - `PwaToHubChatIn` (and the corresponding `HubToDaemonChatIn`)
  - `PwaToHubStartSession` / `HubToDaemonStartSession`
  - `PwaToHubKillSession` / `HubToDaemonKillSession`
  - `PwaToHubAskUserQuestionAnswer` / `HubToDaemonAskUserQuestionAnswer`
  - `PwaToHubPermissionDecision` / `HubToDaemonPermissionDecision`
  - And the daemon→hub→PWA notifications: `tool_use`, `assistant_message`, `permission_request`, `ask_user_question_request`. (These get `trace?` populated by the daemon when active.)

- [ ] **Step 3: Run `bun test packages/proto`** — green.

---

## Task 3 — Daemon instrumentation

**Files:**
- Modify: `packages/daemon/src/index.ts`, `packages/daemon/src/hub-client.ts`, `packages/daemon/src/chat.ts`
- Modify (or scan watcher): existing JSONL handling code
- Add: `packages/daemon/tests/otel.test.ts`

- [ ] **Step 1: Test** — fake hub frame `chat_in` with synthetic `trace` arrives at daemon's handler; with a stubbed in-memory exporter, assert exactly one span named `daemon.handleChat` is exported with parent set to the synthetic traceparent.

- [ ] **Step 2: Wire `initOtel`** at daemon bootstrap (top of `bin/cc-remote.ts` daemon command, before any business code). Service name `"daemon"`. Register `SIGTERM` flush.

- [ ] **Step 3: Instantiate one shared `SessionMap`** and pass to all relevant call sites.

- [ ] **Step 4: Wrap handlers**
  - `chat_in`: `tracer.startActiveSpan("daemon.handleChat", { kind: SERVER, parent: extractFrame(frame.trace) }, span => { sessionMap.push(session_id, { rootCtx, rootSpan: span }); … existing handler … })`. Span ends inside the `chat_in` handler; the root stays alive in `sessionMap` until `stop_reason`.
  - Equivalent for `start_session`, `kill_session`, `ask_user_question_answer`, `permission_decision`.

- [ ] **Step 5: JSONL watcher**
  - On each new JSONL line for session X, `peek(X)` → if active, `tracer.startSpan("daemon.jsonlEvent", { parent: active.rootCtx })`. Add attrs `event_type`, `tool_name?`. End immediately after constructing/sending the corresponding outbound frame (which carries `trace = injectFrame(span)`).
  - On `event_type === "assistant_message"` with `stop_reason` set: `pop(session_id)` and `active.rootSpan.end()`.

- [ ] **Step 6: Migrate stderr to `log.*`** — replace every `process.stderr.write("daemon: ...")` with `log.info(...)`. Tests in `packages/daemon` keep passing (they assert stderr substrings; logger writes to stderr too, so OK — verify by running).

- [ ] **Step 7: Run `bun test packages/daemon`** — green.

---

## Task 4 — Hub instrumentation

**Files:**
- Modify: `packages/hub/src/router.ts` (or wherever frame routing lives)
- Modify: `packages/hub/src/index.ts` for bootstrap
- Modify: `packages/hub/src/push.ts` and others using stderr
- Add: `packages/hub/tests/otel.test.ts`

- [ ] **Step 1: Test** — feed an inbound PWA frame with `trace`, route it through router; assert exported span `hub.routeFrame` with parent matching, and that the outbound frame to daemon carries the **child** span's traceparent (not the parent's).

- [ ] **Step 2: Wire `initOtel({ serviceName: "hub" })`** at server bootstrap. SIGTERM flush.

- [ ] **Step 3: Wrap forward routing**
  - In `router.routeFrameDaemonToPwa` and `routeFramePwaToDaemon` (whichever methods exist), wrap the body: `extractFrame(frame.trace)` → `startActiveSpan("hub.routeFrame", { parent }, span => { … set frame.trace = injectFrame(span); send … })`.
  - Add attrs: `frame_type`, `daemon_id`, `session_id?`.

- [ ] **Step 4: Instrument WS auth and pair routes** — `hub.wsAuth`, `hub.pairIssue`, `hub.pairRefresh` with simple `tracer.startActiveSpan` wraps.

- [ ] **Step 5: Migrate stderr to `log.*`** — all hub stderr sites.

- [ ] **Step 6: Run `bun test packages/hub`** — green.

---

## Task 5 — Plugin instrumentation

**Files:**
- Modify: `packages/plugin/src/index.ts` and `packages/plugin/src/chat.ts`
- Add: `packages/plugin/tests/otel.test.ts`

- [ ] **Step 1: Test** — fake an MCP `tools/call` for `cc_remote_chat`; assert `plugin.dispatch` span and a child span `plugin.cc_remote_chat`.

- [ ] **Step 2: Wire `initOtel({ serviceName: "plugin" })`** at plugin bootstrap. Use the daemon-socket message's `trace` field as parent context when the daemon forwards one (extend the local socket protocol minimally if needed; otherwise plugin starts its own root, which is acceptable for step 1).

- [ ] **Step 3: Wrap MCP handler** — every `tools/call` enters `tracer.startActiveSpan("plugin.dispatch", …)`; resolved tool dispatch is a child `plugin.<toolName>`.

- [ ] **Step 4: Migrate stderr to `log.*`**.

- [ ] **Step 5: Run `bun test packages/plugin`** — green.

---

## Task 6 — PWA instrumentation (lazy chunk)

**Files:**
- Add: `packages/pwa/src/otel/index.ts`
- Modify: `packages/pwa/src/main.tsx`
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Add: `packages/pwa/src/otel/index.test.ts` (or extend existing `useHub.test.ts`)

- [ ] **Step 1: Test (vitest/bun-test in pwa package)** — when `VITE_OTEL_ENABLED` unset, `import("./otel")` is never called and `useHub.sendChat` does not produce a span. With `VITE_OTEL_ENABLED=1`, sending a chat results in a frame whose `trace.traceparent` is non-empty.

- [ ] **Step 2: `otel/index.ts`** — exports `initWebOtel({ collectorUrl })` and `tracer`. Uses `@opentelemetry/sdk-trace-web` + `OTLPTraceExporter` (HTTP). Public function `startUserSpan(name, fn)` is the helper for hooks/components.

- [ ] **Step 3: `main.tsx` bootstrap**

  ```ts
  if (import.meta.env.VITE_OTEL_ENABLED === "1") {
    const { initWebOtel } = await import("./otel");
    initWebOtel({ collectorUrl: import.meta.env.VITE_OTEL_COLLECTOR_URL ?? "http://localhost:4318" });
  }
  ```

- [ ] **Step 4: Wrap user actions in `useHub.ts`** — `sendChat`, `startSession`, `submitQuestionAnswer`, `permissionDecide`. Each starts an active span and sets `frame.trace = injectFrame(span)` before send. Span ends immediately after `ws.send()` (transport-only span; downstream completion is not awaited).

- [ ] **Step 5: Inbound render spans** — when a frame with `trace` arrives, briefly start a child `pwa.render.<frame_type>` span around the React state update path (or just record-and-end with `start_time` from frame receipt — simplest is fine).

- [ ] **Step 6: Run `bun test packages/pwa`** — green.

---

## Task 7 — Local infra (`--otel`)

**Files:**
- Add: `e2e-real/docker-compose.signoz.yml`
- Modify: `tools/demo-channel.sh`
- Add: `e2e-real/helpers/signoz.ts`

- [ ] **Step 1: Compose file** — minimal SigNoz stack (`signoz/signoz-otel-collector`, `signoz/query-service`, `signoz/frontend`, `clickhouse/clickhouse-server`, `signoz/zookeeper-temp`). Use `signoz/signoz` reference compose as a starting point but trim alertmanager. Publish `:4318` (OTLP HTTP), `:3301` (UI), `:8080` (query API).

- [ ] **Step 2: `demo-channel.sh --otel`** — when set, `docker compose -f e2e-real/docker-compose.signoz.yml up -d`, wait until `:4318` returns 200/empty for OPTIONS, then export `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, `VITE_OTEL_ENABLED=1` before spawning daemon/PWA dev server.

- [ ] **Step 3: `helpers/signoz.ts`**
  - `waitForTrace({ rootName, timeoutMs })`: polls `GET /api/v1/traces?rootSpanName=<rootName>&limit=1` (or `query-service`'s analog) until a result returns.
  - `getTraceTree(trace_id)`: returns array of spans for assertion.
  - `clearTraces()`: pre-test reset (drop ClickHouse table or filter by start time).

---

## Task 8 — End-to-end validation (THE TERMINAL TEST)

**Files:**
- Add: `e2e-real/tests/30-otel-trace.test.ts`
- Modify: `e2e-real/docker-compose.demo.yml` if needed for SigNoz networking

- [ ] **Step 1: Test scaffolding**
  - `beforeAll`: bring up SigNoz compose (in addition to existing demo compose), set OTel env on every spawn.
  - Reuse `pairAndStartDaemon`, `openPwa` from existing harness with extra env.

- [ ] **Step 2: The flow**
  1. Pair daemon, sign in PWA, start a session (using `fake-claude --auto-reply` so we get a deterministic assistant message with `stop_reason`).
  2. Send one chat message.
  3. Wait for the assistant reply bubble in the PWA timeline (existing helper).
  4. `await waitForTrace({ rootName: "pwa.user.sendChat", timeoutMs: 30_000 })` → grab `trace_id`.
  5. `getTraceTree(trace_id)` → array of spans.

- [ ] **Step 3: Assertions**
  - Exactly one root span: `pwa.user.sendChat`.
  - All spans share the same `trace_id`.
  - The tree (by `parent_span_id` linkage) MUST contain at least:
    - `pwa.user.sendChat`
      - `hub.routeFrame` (forward, frame_type=`chat_in`)
        - `daemon.handleChat`
          - `plugin.dispatch` (≥1)
      - `daemon.jsonlEvent` (≥1, attr `event_type` ∈ {assistant_message, tool_use})
        - `hub.routeFrame` (backward)
          - `pwa.render.assistantMessage` (or `pwa.render.toolUse`)
  - No span has `status_code = ERROR` (smoke check).

- [ ] **Step 4: Run** `cd e2e-real && bun playwright test 30-otel-trace.test.ts`. Iterate on instrumentation gaps until green.

---

## Definition of Done

- All `bun test` packages green.
- `tools/demo-channel.sh up --otel` starts SigNoz, demo runs, manual chat shows one trace tree in `http://localhost:3301`.
- `e2e-real/tests/30-otel-trace.test.ts` passes — this is the goal-required validation.
- Existing e2e tests pass with `--otel` absent (no regressions).
- Spec updated with anything we learn during implementation.

## YAGNI confirmed

- No metrics. No tail sampling. No fetch auto-instrumentation.
- No PWA log shipping.
- No production hub deploy.
- No redaction. No auth on local SigNoz.
