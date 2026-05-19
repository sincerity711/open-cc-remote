> **DEPRECATED 2026-05-19** — Superseded by `docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md`. Do not implement this plan; it was based on an incomplete reading of Claude Code 2.1.143's plugin contract.

# Plugin MCP modernization — Plan

> **Prerequisite work** before resuming `2026-05-19-real-e2e-plan.md`. Source: `docs/superpowers/research/channel-permission-protocol.md` (T0 findings, commit 6ad49d9 + bfda5b7).

**Goal:** Rewrite `packages/plugin/` so that real Claude Code (v2.1.143+) can load it via `claude --plugin-dir packages/plugin -p "..."`. The plugin participates in the channel-permission protocol per the wire format observed in the official telegram/discord plugins: declare `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }`, handle inbound `notifications/claude/channel/permission_request`, and emit outbound `notifications/claude/channel/permission` when the user (via daemon) decides.

**Architecture:** Plugin gains a dual transport: MCP stdio (to/from Claude Code) plus the existing Unix socket (to/from daemon). It bridges. Existing fake-claude harness keeps working because Unix-socket-only mode is preserved when stdio doesn't show MCP framing within ~1s of startup.

**Tech additions:**
- `@modelcontextprotocol/sdk` ^1.0 in plugin deps
- `package.json` "bin" field pointing at the stdio entry (already there)

**Out of scope (kept honest):**
- "Marketplace registration" via `claude plugin install` — we use ad-hoc `--plugin-dir` for tests; production marketplace flow is a separate concern
- TLS certificates, signing, distribution — the plugin runs locally only

---

## Tasks

### T1 — Add MCP SDK + manifest verification

`packages/plugin/package.json`:
- Confirm/add: `"bin": { "cc-remote-plugin": "./src/index.ts" }` and top-level `"bin": "./src/index.ts"` (telegram has both; matches loader expectations)
- Add dep: `"@modelcontextprotocol/sdk": "^1.0.0"`
- Run `bun install` from repo root

No tests — package metadata only.

### T2 — Plugin MCP scaffold (dual transport)

Modify `packages/plugin/src/index.ts`:
- Detect MCP mode: stdin is a pipe + first byte arrives within `MCP_DETECT_TIMEOUT_MS=500`. If yes → MCP path. If no → existing fallback (current behavior unchanged for fake-claude).
- In MCP mode: instantiate `Server` from `@modelcontextprotocol/sdk/server/index.js` with `StdioServerTransport`. Declare capabilities: `experimental: { "claude/channel": {}, "claude/channel/permission": {} }`. Empty `tools` list (we don't expose tools yet).
- Connect to daemon Unix socket as before.

Test: `packages/plugin/tests/mcp-mode.test.ts` — spawn the plugin with `Server` + `StdioServerTransport` glue from a test harness, assert MCP handshake completes (initialize → initialize_response with our declared capabilities).

### T3 — Inbound permission_request handler

Plugin registers a notification handler for method `notifications/claude/channel/permission_request`:
- Body: `{ request_id, tool_name, description, input_preview }` per T0 research
- Plugin forwards to daemon as existing `PluginPermissionRequest` frame: `{ type: "permission_request", request_id, tool: tool_name, args_summary: input_preview ?? description, expires_at: Date.now() + 5*60_000 }`

Test: `packages/plugin/tests/inbound-permission.test.ts` — spawn plugin in MCP mode, deliver a notification with the wire shape, assert daemon-side socket receives the right frame.

### T4 — Outbound permission notification

When daemon sends `permission_reply` to plugin (existing path), plugin emits MCP notification `notifications/claude/channel/permission` with `{ request_id, behavior: decision === "allow" ? "allow" : "deny" }`.

Test: `packages/plugin/tests/outbound-permission.test.ts` — fake daemon, fake MCP client, drive a roundtrip: client sends `permission_request`, daemon responds with `permission_reply`, client observes the outbound `permission` notification.

### T5 — Smoke test against real Claude Code

`packages/plugin/tests/smoke.test.ts` (skipped if `ANTHROPIC_API_KEY` or `claude` not present):
```ts
test.skipIf(!hasClaudeAndKey)("real claude --plugin-dir loads our plugin and registers a session", async () => {
  // Start daemon (no JWT / unauth mode)
  // Spawn `claude --plugin-dir packages/plugin -p "echo hi"`
  // Watch the daemon's Unix socket: assert `register` frame within 10s
  // Wait for claude to exit
});
```

If daemon never gets a register, the manifest or capability declaration is wrong → fail with clear diagnostic (claude stderr).

### T6 — Existing tests still pass

Run `bun test` and verify the 164+ existing tests (especially plugin/daemon-client.test.ts and the e2e snapshot test) still pass. The dual-mode detection must not break the existing standalone-spawn path.

If any failure: detection threshold (`MCP_DETECT_TIMEOUT_MS`) likely needs tuning, or fake-claude needs a quick env var to force standalone (e.g., `CC_REMOTE_PLUGIN_FORCE_STANDALONE=1`).

### T7 — README + tag

- Update `packages/plugin/README.md` (create if missing) describing dual-mode behavior and `--plugin-dir packages/plugin` usage.
- Tag `plan-plugin-mcp`.
