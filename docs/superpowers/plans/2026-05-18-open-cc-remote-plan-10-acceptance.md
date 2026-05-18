# open-cc-remote — Plan 10: Acceptance suite

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** Quantitative tests asserting the v1 acceptance criteria from the design spec §10.5: P95 permission round-trip < 1s; multi-daemon (3+ concurrent) verified.

**Architecture:** Add e2e benchmark-style tests. Repeat operations N times, capture timings, assert P95 < threshold. No new product code — just verification.

**Out of scope:** "30s offline detection" — current implementation has near-instant detection on WS close; turning that into a deterministic test would require fault injection that's complex for marginal value. Documented as a behavioral note.

---

## Tasks

### T1 — Permission round-trip latency benchmark

`e2e/perf-permission.test.ts`: spawn the same stack as the existing permission e2e, but trigger 20 permission requests in sequence (not parallel — to measure single round-trip latency, not throughput). For each, time from sending the `permission_request` to receiving the `permission_resolved` frame. Assert P95 (the 19th of 20 sorted) < 1000ms. Report median + P95 in test output.

### T2 — Multi-daemon concurrency

`e2e/multi-daemon.test.ts`: spawn one hub, three daemons (each with its own state dir + config.json + daemon_id), three fake-claude sessions (one per daemon). PWA-style WSS subscribes; assert snapshot/session_open frames cover all three daemons within 5s.

### T3 — README + tag

Add a "Verified acceptance" section. Tag `plan-10-acceptance`.
