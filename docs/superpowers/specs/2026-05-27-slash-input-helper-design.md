# Slash Input Helper — `/` Menu in PWA Composer

Date: 2026-05-27
Status: Draft (post-brainstorming)

## 1. Problem

The PWA composer (`packages/pwa/src/screens/SessionView.tsx:170`) is a plain `<input>` — anything typed becomes a `chat_send` carrying literal text. There is no discoverability for what the user could do beyond freeform chat, and no way to invoke the slash commands they already know from native Claude Code (`/clear`, `/compact`, `/context`), nor the custom commands and skills they have on their box (`~/.claude/commands/*.md`, `<cwd>/.claude/commands/*.md`, `~/.claude/skills/*/SKILL.md`, `<cwd>/.claude/skills/*/SKILL.md`).

The existing `chat_send` path can't substitute, because it uses `notifications/claude/channel` (`packages/plugin/src/chat.ts:46`) which delivers content as channel data — it does **not** flow through the CLI's interactive input handler, so a `/clear` typed into chat would just be a literal string the model sees.

## 2. Goals

- A user typing `/` in the PWA composer sees a filtered menu of available commands (built-in + user/project commands + skills), with description and argument hint.
- Selecting a command and submitting causes the **same** behavior as typing it directly in the Claude Code CLI on the daemon's host: built-in slashes mutate CLI state, custom commands expand markdown templates, skills load. The model's response (when any) appears in the PWA timeline through the existing JSONL pipeline.
- Daemon owns the inventory and the injection mechanism. PWA stays UI-only — no markdown parsing, no `$ARGUMENTS` substitution, no skill loading.

## 3. Non-Goals

- `!`shell-injection`` inline directives in custom-command bodies (CLI handles it; daemon doesn't need to know).
- `allowed-tools` frontmatter validation (CLI enforces).
- Plugin-bundled commands (`~/.claude/plugins/.../commands/*.md`).
- Live FS watching of the inventory — one scan per session bind is enough; user can restart session to pick up new commands.
- Busy-state guard: send-keys fires regardless of whether Claude is mid-generation. Behavior matches what the user gets typing into the CLI directly under the same circumstance.
- Web search helper, `@mention` autocompletes, file pickers, or any other input affordance not covered above.

## 4. Architecture

```
┌──────────── PWA ────────────┐                 ┌─────── Hub ───────┐         ┌─────────── Daemon ──────────┐
│                             │                 │                   │         │                             │
│  SessionView composer       │                 │                   │         │  on session bind:           │
│  ┌───────────────────────┐  │                 │                   │         │   scanInventory()           │
│  │ "/" → SlashMenu        │ │ slash_inventory │                   │         │   → emit slash_inventory ──▶│──┐
│  │   filter, ↑↓, Enter   │ │ ◀───────────────│ ◀─────────────────│ ◀───────│                             │  │
│  └─────────────┬─────────┘  │                 │                   │         │  on cli_command frame:      │  │
│                │            │                 │                   │         │   tmux send-keys -t <name>  │  │
│                ▼            │   cli_command   │                   │         │     '<text>' Enter          │  │
│  on submit (text starts /): ├────────────────▶│ ─────────────────▶│ ──────▶ │                             │  │
│   send cli_command          │                 │                   │         │  Claude CLI receives keys,  │  │
│  else: send chat_send       │                 │                   │         │  parses slash, executes;    │  │
│                             │                 │                   │         │  user msg + model output    │  │
│                             │                 │                   │         │  land in JSONL              │  │
│                             │                 │                   │         │       │                     │  │
│                             │                 │                   │         │       ▼                     │  │
│  Timeline (unchanged)       │ ◀─── event ─────│ ◀──── event ──────│ ◀───── jsonl_watcher tail │           │  │
└─────────────────────────────┘                 └───────────────────┘         └─────────────────────────────┘  │
                                                                                                                │
The slash_inventory frame is per-session and pushed once on bind; PWA caches it. ◀──────────────────────────────┘
```

Key invariants:
- Daemon is the single source of truth for "what slashes exist on this host".
- PWA never reads filesystem and never parses command markdown. Inventory is a flat list of metadata entries.
- The chat path (`chat_send` → channel notification) is unchanged. The new path (`cli_command` → tmux send-keys) is purely additive.
- All output reaches the PWA via the existing JSONL → daemon watcher → hub events → `useSessionTimeline` pipeline. No new output frames.

## 5. Protocol

Two new frames added to `packages/proto/src/frames.ts`:

### 5.1 `slash_inventory` (Daemon → Hub → PWA)

Pushed once per session, after JSONL bind completes (alongside the existing `bind_resolved` work).

```ts
export interface SlashEntry {
  /** Stable id within this session — `<source>:<basename>`, where basename is
   *  the command name without the leading "/", e.g. "skill:brainstorming",
   *  "user:review-code", "builtin:clear". Used as React key + selection target. */
  id: string;
  /** Includes the leading "/", e.g. "/clear", "/brainstorming". */
  name: string;
  /** Short one-line description for the menu, when known. */
  description?: string;
  /** Hint for the args portion, e.g. "[target-file]" or "<instructions>". */
  argument_hint?: string;
  /** Where this command came from. Drives icon + sort group in the menu. */
  source: "builtin" | "user" | "project" | "skill";
}

export interface DaemonSlashInventory {
  type: "slash_inventory";
  session_id: string;
  entries: SlashEntry[];
}

// Hub→PWA broadcast wraps in `daemon_id` like other session frames.
export interface PwaSlashInventory {
  type: "slash_inventory";
  daemon_id: string;
  session_id: string;
  entries: SlashEntry[];
}
```

The hardcoded built-in subset for v1: `["/clear", "/compact", "/context"]` with curated descriptions. Adding more later is metadata-only.

### 5.2 `cli_command` (PWA → Hub → Daemon)

```ts
// PWA → Hub
export interface PwaToHubCliCommand {
  type: "cli_command";
  daemon_id: string;
  session_id: string;
  /** Verbatim string to inject, e.g. "/brainstorming todo app" or "/clear". */
  text: string;
}

// Hub → Daemon
export interface HubToDaemonCliCommand {
  type: "cli_command";
  session_id: string;
  text: string;
  /** Bearer subject of the PWA user, for daemon log audit. */
  user: string;
}
```

No ack frame. If tmux send-keys fails (session gone), daemon writes to its log; UI feedback is "no JSONL update for a few seconds" — same surface as any session-dead failure.

## 6. Daemon

### 6.1 Inventory scan — new module `packages/daemon/src/slash-inventory.ts`

Triggered after `bindJsonl` resolves the session's cwd + claude_session_id (exact insertion point: end of `bindAndStream` in `packages/daemon/src/index.ts:303-323`).

```ts
export interface ScanInput {
  cwd: string;             // session's cwd → for project-scoped scans
  homeDir: string;         // os.homedir()
}
export async function scanInventory(input: ScanInput): Promise<SlashEntry[]>;
```

Sources, in order:
1. **Built-in.** Hardcoded array, three entries.
2. **User commands.** `<homeDir>/.claude/commands/*.md`. Glob, read frontmatter (YAML between `---` fences), extract `description` + `argument-hint`. Filename without `.md` → command name.
3. **Project commands.** Same as (2), rooted at `<cwd>/.claude/commands/`.
4. **User skills.** `<homeDir>/.claude/skills/*/SKILL.md` — directory name is the skill name; SKILL.md may carry frontmatter.
5. **Project skills.** `<cwd>/.claude/skills/*/SKILL.md`.

Each entry produces `id = "<source>:<basename>"` (e.g. `"user:review-code"`, `"skill:brainstorming"`, `"builtin:clear"`). On collision (same name across sources), keep all entries — PWA renders them all and disambiguates by source label. (Claude Code's own collision precedence is project > user > builtin; we don't need to enforce that here because the user picks from the menu.)

Errors during scan are logged and skipped; one bad markdown file shouldn't blank the whole inventory.

### 6.2 Inventory emit

After scan completes, daemon sends `slash_inventory` for that session over the hub WebSocket. Hub forwards to all PWA subscribers of that session. New session → new scan → new emit.

### 6.3 `cli_command` handling

In `packages/daemon/src/index.ts`'s frame handler (next to `chat_send`):

```ts
else if (frame.type === "cli_command") {
  const tmuxName = sessionTmuxName(frame.session_id);
  if (!tmuxName) { /* log and drop */ return; }
  childSpawn("tmux", ["send-keys", "-t", tmuxName, frame.text, "Enter"], { stdio: "ignore" });
}
```

`sessionTmuxName` is recovered from the `pendingStarts` / session-tracking map populated when daemon spawns the session. If we don't already track the tmux name per `session_id`, we need to: extend the start_session bookkeeping so the name is retrievable later. (Spec callout for plan to confirm during implementation.)

The send-keys invocation passes `text` as a single arg followed by literal `Enter`. tmux quotes the text correctly without us having to escape; multi-arg form is shell-injection-safe.

## 7. PWA

### 7.1 New hook `packages/pwa/src/hooks/useSlashInventory.ts`

Subscribes to `slash_inventory` frames coming through `useHub`. Stores `Map<session_id, SlashEntry[]>`. Default `[]` until the first frame arrives. No fetch on demand — daemon pushes.

### 7.2 Composer changes — `SessionView.tsx`

Replace the bare `<input>` with a thin wrapper that:

1. Tracks `draft` as today.
2. When `draft.startsWith("/")` and the user is typing (focused + draft length > 0), render an absolutely-positioned `<SlashMenu>` above the input.
3. `<SlashMenu>` filters entries by prefix match on `name` (case-insensitive), groups by `source` (Built-in / User / Project / Skill), shows description on the right.
4. Keyboard: ↑↓ moves selection (visual only), Enter accepts and inserts the command name + space (cursor stays for arg typing) OR if draft already has a space (i.e. command + args), submits.
5. Submit handler:
   - If first space-delimited token matches an inventory entry's `name`: send `cli_command { text: draft }`.
   - Otherwise: send `chat_send` as today.

### 7.3 Component layout

```
packages/pwa/src/screens/
  SessionView.tsx                ← composer wiring
  primitives/
    SlashMenu.tsx                 ← NEW: filter + keyboard + render
    SlashMenu.module.css          ← NEW (or Tailwind in same file, match repo style)
```

The menu is a presentational component; `useSlashInventory` lives in the parent and passes filtered entries down.

## 8. Tests

### 8.1 Daemon unit (`packages/daemon/tests/`)

- `slash-inventory.test.ts`:
  - empty .claude dirs → only built-in entries
  - one user command + one project command with frontmatter → entries with correct description/argument_hint
  - skill dir with SKILL.md → skill entry with directory name
  - malformed markdown frontmatter → entry skipped, others present
- `cli-command.test.ts`:
  - frame received → `tmux send-keys` invoked with correct args (mock `child_process.spawn`)
  - unknown session_id → no spawn, no throw

### 8.2 PWA unit (`packages/pwa/src/`)

- `useSlashInventory.test.ts`: frame in → state populated for matching session_id only.
- `SlashMenu.test.tsx`:
  - prefix filter narrows list
  - ↑↓ moves highlight, Enter on highlight emits selection
  - empty match → menu hidden

### 8.3 e2e-real (new scenario `e2e-real/tests/22-slash-helpers.test.ts`)

1. Pair daemon + PWA, start session.
2. PWA opens session → assert `slash_inventory` arrives, includes `/clear`.
3. PWA picks `/clear` from menu, submits.
4. `tmux capture-pane` on the daemon's session shows the post-clear state (e.g. only the prompt visible).
5. PWA timeline reflects (no further messages — `/clear` produces no model output).

If e2e setup makes a custom `.claude/commands/` mountable, also test one custom-command roundtrip; otherwise keep that to unit + manual.

## 9. Rollout

Single plan, single PR (or two if size demands: split protocol+daemon from PWA). No feature flag — additive, backward compatible. Existing PWAs that haven't reloaded will simply ignore the unknown `slash_inventory` frame; existing daemons that haven't upgraded won't emit it, and the new PWA shows an empty menu (built-in stays empty too, since builtins come from the daemon scan output, not a PWA-side hardcode). This is intentional: PWA shouldn't need to know hub/daemon version.

## 10. Open Questions

1. **Tmux session name lookup by session_id** — confirmed during implementation that `pendingStarts` or an equivalent map tracks `(session_id → tmux_name)` long-term, not just during boot dialog dismissal. If not, extend it.
2. **JSONL representation of `/clear`** — does Claude Code clear the JSONL file on `/clear`, or write a sentinel and continue? The PWA's timeline reducer needs to handle whichever it is. Verify in spike during plan execution; behavior is the same as a CLI user invokes /clear, so we inherit whatever Claude Code does.
