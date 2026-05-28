# Observability — How to look at logs and traces

The cc-remote stack is four processes (PWA browser, daemon, hub-in-docker,
plugin under CC). When something goes wrong, the question is usually
"which step in the round-trip broke?" — that's a tracing question, not a
log-grep question. This doc is the playbook.

## TL;DR

```bash
# Bring up the demo with tracing on:
./tools/demo-channel.sh --otel up

# Open Jaeger UI (waterfall view of every chat round-trip):
open http://localhost:16686

# Quick stderr (kept as before — `log.*` writes here too):
tail -f /tmp/cc-remote-demo/daemon.log
docker logs -f $(docker ps -q --filter ancestor=e2e-real-hub)

# When done, stop everything (Jaeger included):
./tools/demo-channel.sh stop
```

`--otel` is **off by default**. Without it the SDK is a complete no-op
(no SDK packages loaded, no extra HTTP) — the demo is unchanged.

## What you get with `--otel`

A single user round-trip (PWA send → CC reply → PWA render) becomes one
trace tree in Jaeger:

```
pwa: pwa.user.sendChat (root)
 └ hub.routeFrame                          ← chat_send forward
   └ daemon.handleChat
     ├ daemon.jsonlEvent (assistant_message)
     │  └ hub.routeFrame                   ← event broadcast back
     │    └ pwa.render.event
     └ daemon.jsonlEvent (tool_use, ...)
        └ hub.routeFrame
          └ pwa.render.event
```

Three services (`pwa`, `hub`, `daemon`), one `trace_id`. In the UI you
get a time-waterfall — durations, attributes (`session_id`,
`message_id`, `event_type`), and any exceptions stamped on the relevant
span.

The plugin emits `plugin.dispatch` spans when CC is actually loaded; the
fake-claude harness skips that.

## How to read a problem

Pick the workflow that matches your symptom.

### "I sent a message and the reply never showed up"

1. In the PWA composer, send the failing message.
2. Open Jaeger UI → **Search** → service: `pwa` → operation:
   `pwa.user.sendChat` → click the most recent trace.
3. Walk the waterfall top-down:
   - **No `hub.routeFrame` child** → frame never reached the hub. Check
     PWA WS state, hub logs.
   - **No `daemon.handleChat` grandchild** → hub didn't forward (daemon
     offline?).
   - **`daemon.handleChat` is there but no `daemon.jsonlEvent`** → CC
     isn't writing JSONL, OR the watcher didn't see the line. Check
     `daemon: watcher start ...` in stderr.
   - **`daemon.jsonlEvent` present but no `pwa.render.event`** → hub
     didn't broadcast back, or PWA isn't subscribed to the right
     daemon's events.
4. Click any span to see attributes (`session_id`, etc.) and any error
   that was attached.

### "Latency feels off"

The waterfall shows wall-clock duration of every span. Hover for ms.
Common patterns:

- Long `daemon.handleChat` with no children → daemon stuck waiting on
  the plugin socket.
- Long `daemon.jsonlEvent` → AGUI adapter is doing something slow on
  one specific row.
- Gap between root end and first child start → PWA → hub WS latency.

### "I don't know what session this is for"

Every span has a `session_id` attribute. In Jaeger search, **Tags** field:

```
session_id="mock-session-1"
```

Returns every trace touching that session, regardless of root.

### "Where's the actual log line?"

The original `process.stderr.write(...)` lines are still there for every
process — the new `log.info/warn/error` helper writes to stderr first,
then (when OTel is on) ships an OTLP log record too. So:

- Local file `tail -f`:
  - daemon → `/tmp/cc-remote-demo/daemon.log`
  - PWA → browser DevTools console
  - hub → `docker logs <container>` (the demo's hub container has the
    same name regardless of demo run)
- Inside Jaeger we don't ship logs — Jaeger is traces-only. If you want
  log↔trace pivoting, swap the backend (see "Switching backends").

## Where things live

| | Source | What you read |
|---|---|---|
| trace SDK init | `packages/observability/src/init.ts` | OTLP HTTP exporter at `OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces` |
| span definitions | `packages/{daemon,hub,plugin}/src/otel.ts`, `packages/pwa/src/otel/index.ts` | the operation names you see in Jaeger |
| frame trace ctx | `packages/proto/src/frames.ts` `TraceCtx` | optional `trace?` field on `chat_send`, `chat_in`, `event`, `start_session`, `kill_session`, `permission_decision`, `ask_user_question_answer` |
| backward-attach by session_id | `packages/observability/src/session-map.ts` | how a `daemon.jsonlEvent` lands on the right round-trip's tree |
| compose for Jaeger | `e2e-real/docker-compose.otel.yml` | jaegertracing/all-in-one:1.62.0, OTLP HTTP on :4318, UI on :16686 |
| hub container env override | `e2e-real/docker-compose.otel-hub.yml` | wires `host.docker.internal:4318` for the in-container hub |
| script flag | `tools/demo-channel.sh` `--otel` | sets `OTEL_EXPORTER_OTLP_ENDPOINT` for daemon, `VITE_OTEL_ENABLED=1` for PWA |
| spec + plan | `docs/superpowers/specs/2026-05-28-observability-design.md`, `docs/superpowers/plans/2026-05-28-observability-plan.md` | design rationale, what's deliberately YAGNI |

## Configuration knobs

| env var | default | meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset → SDK is no-op) | OTLP HTTP base URL, e.g. `http://localhost:4318` |
| `OTEL_SERVICE_NAME` | per-process literal | `daemon` / `hub` / `plugin` / `pwa` |
| `VITE_OTEL_ENABLED` | unset → no chunk loaded | flips the dynamic import in `packages/pwa/src/main.tsx` |
| `VITE_OTEL_COLLECTOR_URL` | `http://localhost:4318` | PWA-side exporter target (**must** be reachable from the **browser**, not from inside docker) |
| `CC_OBS_SAMPLE_RATIO` | `1.0` | reserved for production; not exercised yet |

When OTel is **off**, the codepath collapses: `initOtel()` returns
immediately, `log.*` only writes stderr, all the `*.otel.ts` helpers
short-circuit through OTel's no-op tracer.

## Troubleshooting `--otel`

| Symptom | Likely cause |
|---|---|
| `Jaeger services` only shows `daemon` and `hub`, never `pwa` | Browser CORS preflight failed. Check `COLLECTOR_OTLP_HTTP_CORS_ALLOWED_ORIGINS` includes the PWA's origin (`http://localhost:15173` in the demo, `:4173` in e2e). |
| `Jaeger services` is empty after a chat round-trip | Either OTel env isn't reaching the spawned daemon (verify with `cat /proc/$(pgrep -f cc-remote)/environ \| tr '\0' '\n' \| grep OTEL`), or the OTLP exporter can't reach the collector (firewall, wrong host). |
| Trace exists, but no `pwa.user.sendChat` root | PWA bundle was built without `VITE_OTEL_ENABLED=1`. The conditional in `main.tsx` is dead-code-eliminated by vite. Rebuild after exporting the env var. |
| Hub spans missing | The in-container hub can't reach the host-published collector. Confirm `docker-compose.otel-hub.yml` is in the up command and that `host.docker.internal` resolves inside the container. |
| Spans appear but parents are wrong | The frame layer dropped the `trace?` field. Frame extensions are listed above; if you added a new RPC frame and want it in the trace, you must add `trace?: TraceCtx` and forward it on the receiving end. |

## Switching backends (Jaeger → SigNoz, Tempo, …)

Nothing about the producer side cares about Jaeger specifically. Point
`OTEL_EXPORTER_OTLP_ENDPOINT` (and `VITE_OTEL_COLLECTOR_URL`) at any
OTLP-HTTP-compatible collector and you're done. The two practical asks:

1. The collector must be reachable from **all four processes** —
   browser via JS fetch, daemon on host, hub inside docker, plugin under
   CC. The CORS allowlist for the browser is the only piece that needs
   per-tool tuning.
2. If you want logs and traces in one UI (SigNoz, HyperDX), enable both
   pipelines on the collector. The `logger.ts` already emits OTLP log
   records when SDK is active; nothing to change in app code.

## Running the e2e validation

```bash
cd e2e-real
bun playwright test 30-otel-trace.test.ts
```

The scenario brings up Jaeger + the demo stack, runs one chat
round-trip, queries the Jaeger API for the trace tree, screenshots the
Jaeger UI for visual confirmation, and asserts the PWA → hub → daemon
parent-child linkages. Artifacts land in
`e2e-real/test-results/30-otel-trace.../`:

- `jaeger-search.png` — search page showing the trace listed under
  service=pwa.
- `jaeger-trace-waterfall.png` — the waterfall view with all three
  services.

If this scenario goes red, the API output (logged in the test) is
usually enough to triage. If it can't even find the trace, walk the
"Troubleshooting" table above.
