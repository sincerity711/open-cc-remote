# Claude Code JSONL — schema reference

This file documents the on-disk JSONL format Claude Code writes to
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. The PWA's daemon tails
these files and forwards each line as an `event` frame; the PWA's
`mergeTimeline` parses the relevant fields into TimelineEvents.

## Two layers, two stability models

### Inner layer — Anthropic Messages API content blocks (OFFICIAL, STABLE)

The `assistant.message.content[]` and `user.message.content[]` arrays carry
exactly the same content-block shapes as the Anthropic Messages API request
and response payloads. This is the contract we rely on for tool-use rendering.

**Authoritative refs:**
- Messages API — https://platform.claude.com/docs/en/api/messages
- Tool use — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Extended thinking — https://platform.claude.com/docs/en/build-with-claude/extended-thinking

**Block types:**

| `type` | Required fields | Optional fields | Where allowed |
|---|---|---|---|
| `text` | `text: string` | — | both |
| `thinking` | `thinking: string` | `signature: string` (encrypted, must round-trip verbatim) | assistant only |
| `redacted_thinking` | `data: string` (base64-encoded encrypted body) | — | assistant only |
| `tool_use` | `id: string` (toolu_…), `name: string`, `input: object` | — | assistant only |
| `tool_result` | `tool_use_id: string`, `content: string \| Array<text\|image>` | `is_error: boolean` | user only |
| `image` | `source: { type, media_type?, data? }` | — | both |

**Pairing rule:** every `tool_use` from an assistant message must be answered
by exactly one `tool_result` block (matching `tool_use_id`) in the next user
message. Out-of-order results are tolerated by the API but break our
`toolsById` map walk in `mergeTimeline`.

**Thinking signature:** the encrypted `signature` on a thinking block MUST
round-trip verbatim if the client replays history. Our fixtures use the
literal placeholder `"MOCK"` — never assert byte-equality on the signature
in tests, only its presence + string type.

### Outer layer — Claude Code JSONL envelope (INTERNAL, REVERSE-ENGINEERED)

This layer wraps each conversational message and adds protocol-internal
entries that have no counterpart in the Messages API. **Anthropic does not
publish a stability guarantee on this layer** — it changes between Claude
Code releases. Sources:

- Community-reverse-engineered: https://liambx.com/blog/claude-code-log-analysis-with-duckdb
- Claude Code GitHub issues for ad-hoc behavior changes (e.g. parentUuid
  semantics across `/clear` are not always physical; see anthropics/claude-code#60845).

**Conversational lines (`type: "user" | "assistant"`):**

| Field | Type | Notes |
|---|---|---|
| `type` | `"user" \| "assistant"` | discriminator |
| `uuid` | UUID string | this line's id |
| `parentUuid` | UUID \| null | previous line's `uuid`; chain pointer |
| `sessionId` | UUID | matches the JSONL filename |
| `timestamp` | ISO-8601 | when CC wrote the line |
| `message` | `{ role, content, [api fields] }` | wraps the inner-layer payload |
| `cwd` | string | working dir |
| `version` | string | Claude Code semver, e.g. `"2.1.146"` |
| `gitBranch` | string | usually populated for repo cwds |
| `userType` | `"external" \| ...` | observed values: `"external"` |
| `entrypoint` | string | observed: `"cli"` |
| `promptId` | UUID | groups multiple lines that came from one user prompt (assistant + tool_uses + tool_results) |
| `isSidechain` | boolean | sub-agent / branch lines |
| `isMeta` | boolean (optional) | for system-injected commands |

For assistant lines, `message` carries the full Anthropic API response
envelope: `{model, id, type:"message", role:"assistant", content:[…],
stop_reason, stop_sequence, usage}`.

For user lines responding to a `tool_use`, the line also carries:
- `toolUseResult: { stdout, stderr, interrupted, isImage, noOutputExpected }` — CC-only metadata
- `sourceToolAssistantUUID: UUID` — points back to the assistant line whose tool_use this answers

**Protocol-internal top-level types** (not part of conversation):
- `file-history-snapshot` — snapshot of tracked files at message N
- `system` — internal status / hook output
- `summary` — auto-summarization of older context
- `attachment` — `{attachment: {type, content, ...}}` (e.g. skill_listing)
- `queue-operation` — sidechain queue state
- `mcp_instructions_data` — MCP plugin connection metadata
- `ai-title` — model-generated session title
- `last-prompt` — bookkeeping for `/last`
- `permission-mode` — current permission mode (default/acceptEdits/etc.)
- `pr-link` — git PR URL when `/pr` is run

The validator (`index.ts PASSTHROUGH_TOP_LEVEL`) accepts these types as
valid lines without enforcing inner-shape because they're Claude-Code-only.

## Drift detection

`tools/jsonl-schema/jsonl-schema.test.ts` does three things:

1. **Fixture lock-in** — every line of every `.jsonl` under
   `e2e-real/fixtures/jsonl-tapes/` validates. If you add a new fixture, a
   shape mistake fails this test.

2. **Real-CC roundtrip** — if `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
   exists for the running developer, every line of the most recent file is
   validated. Skips with a console note when no file is present (CI without
   local Claude). If a future Claude Code release changes the inner-layer
   API shape (e.g. drops a required field on `tool_result`), this fails
   loudly with the offending line.

3. **Last-3-by-type drift** — collects the last 3 lines for each top-level
   type observed in the local sample and validates them. This is the canonical
   "did Anthropic change the API or did CC introduce a new top-level
   envelope" check. New top-level types fall through to forward-compat;
   API-layer changes inside `assistant`/`user` messages fail.

## Mock fixture authoring rules

When you add a new tape under `e2e-real/fixtures/jsonl-tapes/`:

- **Inner-layer fields** (content blocks): copy verbatim from a real CC
  recording. Don't invent shapes — it'll diverge from the real API.
- **Envelope fields**: synthetic values are fine. `version: "2.1.146"`,
  `userType: "external"`, `entrypoint: "cli"`, made-up but valid UUIDs.
- **Thinking signatures**: use the literal `"MOCK"` — never paste a real
  encrypted signature; it'd be misleading and the validator can't verify it
  anyway.
- **Tool ids**: use the `toolu_` prefix for visual familiarity but the
  bytes-after can be arbitrary.
- **Pairing**: every fixture tape that contains an assistant `tool_use` must
  also contain a matching user `tool_result` line, otherwise the PWA
  timeline shows the tool stuck in `running` forever.

## How CC version drift surfaces

If you upgrade Claude Code locally and the validator tests fail:

1. Look at the failure message — it'll point at the line + field.
2. If the Anthropic Messages API shape changed: update `validateContentBlock`,
   refresh fixtures (re-record from a real CC session into the relevant tape),
   bump the validator's reference comment.
3. If a new top-level envelope type appeared: add it to `PASSTHROUGH_TOP_LEVEL`
   (or strict-validate it if mergeTimeline starts using it).
4. Update this `SCHEMA.md` so the next maintainer doesn't repeat the work.
