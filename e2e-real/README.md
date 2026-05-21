# @cc-remote/e2e-real

Real-component end-to-end test suite for open-cc-remote. Exercises the v1 acceptance checklist against real components: real hub binary in docker compose, real `cc-remote daemon` on host, real `claude` driven through tmux interactive mode, and a scripted PWA-equivalent client.

This complements but does not replace the in-process `e2e/` suite, which remains the merge gate.

## What runs

- `fake-ias` + `hub` — docker compose containers (`docker-compose.yml`, Dockerfiles in `fixtures/`)
- `cc-remote daemon` — spawned per scenario from the local source on the host
- `claude` (real) — driven through tmux + `--mcp-config` + `--dangerously-load-development-channels`
- PWA — a real chromium browser driven by Playwright against the production `vite preview` build (per scenario)
- `pwa-client` — a scripted HTTP+WSS client retained only for the protocol-only p95 perf scenario

See `docs/superpowers/specs/2026-05-19-real-e2e-design.md` and `docs/superpowers/plans/2026-05-21-pwa-integration-6-real-e2e.md` for the full design.

## Prerequisites

| Tool | Why |
|---|---|
| docker daemon | hub + fake-ias containers |
| `claude` on PATH (Claude Code 2.1.144+) | real Claude Code under tmux |
| `tmux` on PATH | drives the interactive Claude Code session |
| `ANTHROPIC_API_KEY` | real model invocation |

`helpers/preflight.ts` checks all four before any compose starts.

## Run

```bash
bun install
cd e2e-real

# Default: 14 browser-driven scenarios on chromium / desktop viewport.
bunx playwright test --project=desktop

# 1 protocol-only perf scenario (bun:test — Playwright's ESM loader can't
# load `bun:test`, so it runs separately):
bun test e2e-real/tests/10-perm-p95.test.ts
```

First run builds the docker images (1–3 min). Subsequent runs reuse cached images. Each test file calls `upCompose` in `beforeAll` and `downCompose -v` in `afterAll`, so state is wiped between files.

### Multi-viewport (typical-path scenarios)

The Playwright config reads `RUN_VIEWPORTS=mobile,tablet,desktop` and runs the same test against each project. The `makeScenarioContext` helper writes step PNGs as `${seq}-${slug}.${projectName}.png`, so mobile/tablet/desktop runs of the same scenario don't collide.

```bash
RUN_VIEWPORTS=mobile,tablet,desktop bunx playwright test \
  --project=mobile --project=tablet --project=desktop \
  tests/01-pair-and-snapshot.test.ts \
  tests/02-permission-relay.test.ts \
  tests/12-chat-roundtrip.test.ts \
  tests/16-demo-cards.test.ts
```

Note: the `iPhone 14` and `iPad Mini` device presets default to `webkit`. Mobile/tablet runs will fail at fixture-instantiation time unless WebKit is installed (`bunx playwright install webkit`). Once installed, the 4 typical-path scenarios above are expected to cover responsive bugs in the SessionView / AppShell layout chain.

### Visual regression workflow

`e2e-real/screenshots/<scenarioSlug>/` contains the committed baseline PNGs. After every passing run, `helpers/sync-screenshots.ts` (called from `test.afterEach` in each scenario) copies the test's `outputDir/*.png` over the baseline. Failed runs do NOT sync, so a broken UI cannot poison the baseline.

Before merging, run `git diff e2e-real/screenshots/` — any byte change is either a deliberate visual update (commit it with the code change) or an unintended regression (fix it). Diffing on `.png` files is binary, so use a visual diff tool or open both frames; the per-step file naming (`01-sign-in-screen.desktop.png`, etc.) makes it obvious which step regressed.

Manual cleanup if a run is interrupted:

```bash
docker compose -f e2e-real/docker-compose.yml down -v
tmux ls 2>/dev/null | awk -F: '/^ccr-/ {print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null
```

## Cost

~$0.20 per full suite at default Haiku (`claude-haiku-4-5`). Permission scenarios add a small premium.

## Acceptance baseline

`bunx playwright test --project=desktop` should produce **15 pass / 0 fail in ~6.5 min** wall time on this hardware (14 browser scenarios + 1 demo-cards UI scenario; the protocol-only `10-perm-p95` runs separately under `bun test`). Spec §8 budget is < 7 min. If you see longer, suspect a stale docker container / volume — run the manual cleanup above first.

A global `_summary.json` artifact aggregating per-scenario timing/cost is deferred — Playwright's HTML reporter (`e2e-real/playwright-report/index.html`) covers most of what an aggregate summary would surface.

## Why the unusual `claude` flags

`helpers/claude-tmux.ts` invokes claude as:

```
claude --mcp-config <file> \
       --dangerously-load-development-channels server:cc-remote \
       --model claude-haiku-4-5 \
       --setting-sources project,local
```

Each flag matters:

- **`--mcp-config <file>` (instead of `--plugin-dir`)** — `--plugin-dir` does NOT engage channel notifications in the current Claude Code; only an MCP config does. See `docs/superpowers/research/2026-05-20-p-mode-permission-spike.md` for empirical evidence.
- **`--dangerously-load-development-channels server:cc-remote`** — opts the test plugin into the channel-permission relay. Hidden flag, not in `--help`. Subject to drift — check spike doc when CC version changes.
- **`--setting-sources project,local`** — excludes the user's `~/.claude/settings.json`. Without this, dev-machine overrides like `permissions.defaultMode: bypassPermissions` leak into the test and tools auto-allow without consulting the plugin.
- Tmux interactive mode (no `-p`) — `-p` mode skips the channel-permission UI by design; only interactive engages the full protocol.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `bun test e2e-real/` hangs in scenario 11's `beforeAll` | stale compose volume from prior crashed run | `docker compose -f e2e-real/docker-compose.yml down -v` then retry |
| Scenario fails at `dismissDialog` with `Enter to confirm not seen in 20s` | Claude Code dialog text changed in a new CC version | inspect last `capturePane()` output in error; widen the regex in `helpers/claude-tmux.ts` |
| Permission scenario waits 30s for `permission_request` then times out | `--dangerously-load-development-channels` flag changed/removed in CC update | re-run the spike (`docs/superpowers/research/2026-05-20-p-mode-permission-spike.md`) to find the new mechanism |
| `which tmux` empty in preflight | tmux not installed | `brew install tmux` |
| `Container e2e-real-hub-1 Error while Removing` | docker compose teardown race | already handled in `helpers/compose.ts` (retry + port-free wait); persistent failure means docker daemon misbehaving — restart Docker Desktop |
| `ccr-*` orphan tmux sessions accumulating | scenario crashed mid-boot | `helpers/compose.ts:sweepCcrTmuxSessions` runs before every up + down; manually: `tmux ls 2>/dev/null \| awk -F: '/^ccr-/ {print $1}' \| xargs -I{} tmux kill-session -t {} 2>/dev/null` |

## Boundary

What is in scope vs. out of scope is documented in spec §10 (`docs/superpowers/specs/2026-05-19-real-e2e-design.md`). Notably out of scope: real Web Push delivery (file-log stub), real SAP IAS, real TLS, real macOS Keychain, real browser PWA via Playwright, marketplace plugin install.
