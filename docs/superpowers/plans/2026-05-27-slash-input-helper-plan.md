# Slash Input Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/`-triggered command menu in the PWA composer that mirrors Claude Code's own slash UX. Selecting any item (built-in `/clear` `/compact` `/context`, or any `~/.claude/commands/*.md` / project commands / skills) injects the literal slash text into the daemon's tmux pane via `send-keys`. Output flows back through the existing JSONL pipeline — no new output frames.

**Architecture:** Two new wire frames. `slash_inventory` (daemon→hub→PWA, pushed once after JSONL bind) carries a flat list of available slashes scanned from the daemon's filesystem. `cli_command` (PWA→hub→daemon, free-form text payload) is handled in the daemon by `tmux send-keys` against the session's pane (read from the existing `SessionSnapshot.tmux_pane`). PWA never parses markdown; daemon never expands templates — the Claude Code CLI does both, just like when the user types into it directly.

**Tech Stack:** Bun + TypeScript across all packages. Vitest-style `bun test` for unit tests. Playwright + docker compose for e2e-real.

**Spec reference:** `docs/superpowers/specs/2026-05-27-slash-input-helper-design.md`

---

## File map

| Path | What |
|---|---|
| `packages/proto/src/frames.ts` | add `SlashEntry`, `DaemonSlashInventory`, `PwaSlashInventory`, `PwaToHubCliCommand`, `HubToDaemonCliCommand`; extend `DaemonToHub`, `HubToPwa`, `PwaToHub`, `HubToDaemon` unions |
| `packages/proto/tests/frames.test.ts` | extend — JSON round-trip for the new frames |
| `packages/daemon/src/slash-inventory.ts` | **new** — `scanInventory({cwd, homeDir})`: globs four dirs + builtin list, parses YAML frontmatter, returns `SlashEntry[]` |
| `packages/daemon/tests/slash-inventory.test.ts` | **new** — fixtures with custom commands + skills + malformed frontmatter |
| `packages/daemon/src/index.ts` | call `scanInventory` after JSONL bind, emit `slash_inventory`; add `cli_command` frame handler that calls `tmux send-keys` |
| `packages/daemon/tests/cli-command.test.ts` | **new** — `cli_command` invokes child_process.spawn with the right args |
| `packages/hub/src/router.ts` | route `slash_inventory` daemon→PWA broadcasts; new `onPwaCliCommand` that wraps payload as `HubToDaemonCliCommand` |
| `packages/hub/src/routes.ts` | dispatch `cli_command` from PWA WS handler |
| `packages/hub/tests/router.test.ts` | extend — new tests for both new frames |
| `packages/pwa/src/hooks/useSlashInventory.ts` | **new** — subscribes to `slash_inventory` broadcasts via `useHub`; exposes `entries(daemonId, sessionId)` |
| `packages/pwa/src/hooks/useSlashInventory.test.ts` | **new** — frame in → state populated, scoped per session |
| `packages/pwa/src/screens/primitives/SlashMenu.tsx` | **new** — presentational filter+keyboard menu |
| `packages/pwa/src/screens/primitives/SlashMenu.test.tsx` | **new** — filter, keyboard, selection |
| `packages/pwa/src/screens/SessionView.tsx` | composer: render menu when draft starts with `/`; on submit, route to `cli_command` or `chat_send` |
| `packages/pwa/src/screens/SessionView.test.tsx` | extend — submit routing branch |
| `packages/pwa/src/hooks/useHub.ts` | add `outbound_cli_command` action + frame plumbing |
| `e2e-real/tests/22-slash-helpers.test.ts` | **new** — `/clear` round-trip via the demo daemon |

---

## Task 1: Proto frames

**Files:**
- Modify: `packages/proto/src/frames.ts`
- Modify: `packages/proto/tests/frames.test.ts`

- [ ] **Step 1: Add the new interfaces and extend the unions**

Append to `packages/proto/src/frames.ts` (after the existing `chat_error` block, before the permission section):

```ts
// ─── slash inventory + cli_command (PWA `/` helper) ───────────────────

export interface SlashEntry {
  /** Stable id within this session, `<source>:<basename>` (basename has no
   *  leading "/"). React key + selection target. */
  id: string;
  /** Includes the leading "/", e.g. "/clear", "/brainstorming". */
  name: string;
  description?: string;
  argument_hint?: string;
  source: "builtin" | "user" | "project" | "skill";
}

export interface DaemonSlashInventory {
  type: "slash_inventory";
  session_id: string;
  entries: SlashEntry[];
}

export interface PwaSlashInventory {
  type: "slash_inventory";
  daemon_id: string;
  session_id: string;
  entries: SlashEntry[];
}

export interface PwaToHubCliCommand {
  type: "cli_command";
  daemon_id: string;
  session_id: string;
  /** Verbatim string to inject (with leading "/"), e.g. "/brainstorming todo". */
  text: string;
}

export interface HubToDaemonCliCommand {
  type: "cli_command";
  session_id: string;
  text: string;
  /** Bearer subject of the PWA user, for daemon log audit. */
  user: string;
}
```

Then extend the union types (lines ~110-167):

```ts
// In DaemonToHub union, add:
| DaemonSlashInventory

// In HubToPwa union, add:
| PwaSlashInventory

// In PwaToHub union, add:
| PwaToHubCliCommand

// In HubToDaemon union, add:
| HubToDaemonCliCommand
```

- [ ] **Step 2: Write failing round-trip tests**

Append to `packages/proto/tests/frames.test.ts`:

```ts
import { test, expect } from "bun:test";
import type {
  DaemonSlashInventory,
  PwaSlashInventory,
  PwaToHubCliCommand,
  HubToDaemonCliCommand,
  SlashEntry,
} from "../src/frames.ts";

test("slash_inventory daemon→hub round-trips through JSON", () => {
  const entry: SlashEntry = {
    id: "skill:brainstorming",
    name: "/brainstorming",
    description: "Turn an idea into a design",
    source: "skill",
  };
  const f: DaemonSlashInventory = {
    type: "slash_inventory",
    session_id: "s1",
    entries: [entry],
  };
  const parsed = JSON.parse(JSON.stringify(f)) as DaemonSlashInventory;
  expect(parsed.type).toBe("slash_inventory");
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.entries[0]!.source).toBe("skill");
});

test("slash_inventory hub→pwa carries daemon_id", () => {
  const f: PwaSlashInventory = {
    type: "slash_inventory",
    daemon_id: "d-1",
    session_id: "s1",
    entries: [],
  };
  const parsed = JSON.parse(JSON.stringify(f)) as PwaSlashInventory;
  expect(parsed.daemon_id).toBe("d-1");
});

test("cli_command pwa→hub round-trips with verbatim text", () => {
  const f: PwaToHubCliCommand = {
    type: "cli_command",
    daemon_id: "d-1",
    session_id: "s1",
    text: "/brainstorming todo app",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as PwaToHubCliCommand;
  expect(parsed.text).toBe("/brainstorming todo app");
});

test("cli_command hub→daemon includes user for audit", () => {
  const f: HubToDaemonCliCommand = {
    type: "cli_command",
    session_id: "s1",
    text: "/clear",
    user: "alice@example.com",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToDaemonCliCommand;
  expect(parsed.user).toBe("alice@example.com");
});
```

- [ ] **Step 3: Run tests — verify pass**

Run: `bun test packages/proto/tests/frames.test.ts`
Expected: all tests pass (the types compile-time-only; JSON.parse(stringify) is a structural sanity check).

- [ ] **Step 4: Typecheck**

Run: `bun run --filter='@cc-remote/proto' typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/proto/src/frames.ts packages/proto/tests/frames.test.ts
git commit -m "proto: add slash_inventory + cli_command frames"
```

---

## Task 2: Daemon — inventory scanner module

**Files:**
- Create: `packages/daemon/src/slash-inventory.ts`
- Create: `packages/daemon/tests/slash-inventory.test.ts`

The scanner is pure: given paths in, returns entries out. No network, no daemon coupling.

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/tests/slash-inventory.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInventory } from "../src/slash-inventory.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "slash-inv-"));
}

test("returns the three built-in entries when no .claude dirs exist", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const entries = await scanInventory({ cwd, homeDir: home });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["/clear", "/compact", "/context"]);
    expect(entries.every((e) => e.source === "builtin")).toBe(true);
    expect(entries.every((e) => e.id.startsWith("builtin:"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scans user commands with frontmatter description and argument-hint", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const cmdDir = join(home, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "review.md"),
      "---\n" +
      "description: Review the current diff\n" +
      "argument-hint: \"[paths]\"\n" +
      "---\n\nBody here.\n",
    );
    const entries = await scanInventory({ cwd, homeDir: home });
    const review = entries.find((e) => e.name === "/review");
    expect(review).toBeDefined();
    expect(review!.source).toBe("user");
    expect(review!.id).toBe("user:review");
    expect(review!.description).toBe("Review the current diff");
    expect(review!.argument_hint).toBe("[paths]");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scans project commands separately from user commands", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "deploy.md"), "---\ndescription: Project-only deploy\n---\nBody\n");
    const entries = await scanInventory({ cwd, homeDir: home });
    const deploy = entries.find((e) => e.name === "/deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe("project");
    expect(deploy!.id).toBe("project:deploy");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scans skills as <home>/.claude/skills/<dir>/SKILL.md", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const skillDir = join(home, ".claude", "skills", "brainstorming");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Idea → design\n---\nbody\n");
    const entries = await scanInventory({ cwd, homeDir: home });
    const skill = entries.find((e) => e.name === "/brainstorming");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("skill");
    expect(skill!.id).toBe("skill:brainstorming");
    expect(skill!.description).toBe("Idea → design");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed frontmatter file is skipped, others returned", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const cmdDir = join(home, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "ok.md"), "---\ndescription: fine\n---\n");
    writeFileSync(join(cmdDir, "bad.md"), "---\nthis is: : not yaml :::\n---\n");
    const entries = await scanInventory({ cwd, homeDir: home });
    const names = entries.map((e) => e.name);
    expect(names).toContain("/ok");
    // bad.md still parses as a name even if frontmatter is malformed —
    // the description is just absent.
    expect(names).toContain("/bad");
    const bad = entries.find((e) => e.name === "/bad")!;
    expect(bad.description).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test packages/daemon/tests/slash-inventory.test.ts`
Expected: fails — `scanInventory` not found.

- [ ] **Step 3: Implement `scanInventory`**

```ts
// packages/daemon/src/slash-inventory.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SlashEntry } from "@cc-remote/proto";

const BUILTIN: SlashEntry[] = [
  {
    id: "builtin:clear",
    name: "/clear",
    description: "Clear conversation history (keeps memory)",
    source: "builtin",
  },
  {
    id: "builtin:compact",
    name: "/compact",
    description: "Summarize the conversation to free context",
    argument_hint: "[focus instructions]",
    source: "builtin",
  },
  {
    id: "builtin:context",
    name: "/context",
    description: "Show current context window usage",
    source: "builtin",
  },
];

export interface ScanInput {
  cwd: string;
  homeDir: string;
}

export async function scanInventory(input: ScanInput): Promise<SlashEntry[]> {
  const out: SlashEntry[] = [...BUILTIN];

  await Promise.all([
    scanCommandDir(join(input.homeDir, ".claude", "commands"), "user", out),
    scanCommandDir(join(input.cwd, ".claude", "commands"), "project", out),
    scanSkillDir(join(input.homeDir, ".claude", "skills"), out),
    scanSkillDir(join(input.cwd, ".claude", "skills"), out),
  ]);

  return out;
}

async function scanCommandDir(
  dir: string,
  source: "user" | "project",
  out: SlashEntry[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const basename = f.slice(0, -3);
    if (!isValidName(basename)) continue;
    const meta = await readFrontmatter(join(dir, f));
    out.push(makeEntry(source, basename, meta));
  }
}

async function scanSkillDir(dir: string, out: SlashEntry[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const dirName of names) {
    if (!isValidName(dirName)) continue;
    const skillFile = join(dir, dirName, "SKILL.md");
    let s;
    try {
      s = await stat(skillFile);
      if (!s.isFile()) continue;
    } catch {
      continue;
    }
    const meta = await readFrontmatter(skillFile);
    out.push(makeEntry("skill", dirName, meta));
  }
}

function makeEntry(
  source: SlashEntry["source"],
  basename: string,
  meta: { description?: string; argument_hint?: string },
): SlashEntry {
  const e: SlashEntry = {
    id: `${source}:${basename}`,
    name: `/${basename}`,
    source,
  };
  if (meta.description) e.description = meta.description;
  if (meta.argument_hint) e.argument_hint = meta.argument_hint;
  return e;
}

function isValidName(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(s);
}

interface Meta { description?: string; argument_hint?: string }

async function readFrontmatter(path: string): Promise<Meta> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = text.slice(4, end);
  const meta: Meta = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!;
    const val = stripQuotes(raw);
    if (key === "description") meta.description = val;
    else if (key === "argument-hint" || key === "argument_hint") meta.argument_hint = val;
  }
  return meta;
}

function stripQuotes(s: string): string {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test packages/daemon/tests/slash-inventory.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/slash-inventory.ts packages/daemon/tests/slash-inventory.test.ts
git commit -m "daemon: scan slash command + skill inventory"
```

---

## Task 3: Daemon — emit `slash_inventory` after JSONL bind

**Files:**
- Modify: `packages/daemon/src/index.ts`

The emit point: end of `bindAndStream` (around line 323), or wherever JSONL bind successfully completes. We want one emit per session bind.

- [ ] **Step 1: Locate the bind site**

Open `packages/daemon/src/index.ts` and find the function that handles JSONL bind completion (search `bind_resolved`). The `slash_inventory` emit goes immediately after the `bind_resolved` send — same trigger.

- [ ] **Step 2: Add emit logic**

At the top of the file, add the import:

```ts
import { scanInventory } from "./slash-inventory.ts";
import { homedir } from "node:os";
```

After the `bind_resolved` send completes (find the `hub.send({ type: "bind_resolved", ... })` line), add:

```ts
// Push the slash command inventory once per session bind.
scanInventory({ cwd: s.cwd, homeDir: homedir() })
  .then((entries) => {
    hub.send({ type: "slash_inventory", session_id: s.session_id, entries });
  })
  .catch((e) => {
    process.stderr.write(`daemon: slash inventory scan failed for ${s.session_id}: ${(e as Error).message}\n`);
  });
```

- [ ] **Step 3: Manually verify**

Run: `bun run --filter='@cc-remote/daemon' typecheck`
Expected: clean.

(Behavioural test deferred to e2e — covered by Task 9.)

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "daemon: emit slash_inventory after JSONL bind"
```

---

## Task 4: Daemon — handle `cli_command` via tmux send-keys

**Files:**
- Modify: `packages/daemon/src/index.ts`
- Create: `packages/daemon/tests/cli-command.test.ts`

- [ ] **Step 1: Write failing test (extract handler into a small pure function)**

The cleanest way to test this is to extract the dispatch into a helper that takes an injectable spawn and a session lookup. Create the helper alongside the main file later; for now the test:

```ts
// packages/daemon/tests/cli-command.test.ts
import { test, expect } from "bun:test";
import { handleCliCommand } from "../src/cli-command.ts";

test("invokes tmux send-keys with the pane id when present", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (cmd: string, args: string[]) => { calls.push({ cmd, args }); };
  handleCliCommand(
    { type: "cli_command", session_id: "s1", text: "/clear", user: "u@x" },
    {
      lookupPane: (id) => id === "s1" ? { tmux_pane: "%5", tmux_session: "demo" } : null,
      spawn,
      log: () => {},
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.cmd).toBe("tmux");
  expect(calls[0]!.args).toEqual(["send-keys", "-t", "%5", "/clear", "Enter"]);
});

test("falls back to session name when pane is null", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  handleCliCommand(
    { type: "cli_command", session_id: "s1", text: "/compact", user: "u@x" },
    {
      lookupPane: () => ({ tmux_pane: null, tmux_session: "demo-claude" }),
      spawn: (cmd, args) => { calls.push({ cmd, args }); },
      log: () => {},
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(["send-keys", "-t", "demo-claude", "/compact", "Enter"]);
});

test("logs and skips if both pane and session are null", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const logs: string[] = [];
  handleCliCommand(
    { type: "cli_command", session_id: "s1", text: "/clear", user: "u@x" },
    {
      lookupPane: () => ({ tmux_pane: null, tmux_session: null }),
      spawn: (cmd, args) => { calls.push({ cmd, args }); },
      log: (m) => { logs.push(m); },
    },
  );
  expect(calls).toHaveLength(0);
  expect(logs.some((l) => l.includes("no tmux target"))).toBe(true);
});

test("logs and skips when session unknown", () => {
  const logs: string[] = [];
  const calls: Array<unknown> = [];
  handleCliCommand(
    { type: "cli_command", session_id: "missing", text: "/clear", user: "u@x" },
    {
      lookupPane: () => null,
      spawn: () => { calls.push(true); },
      log: (m) => { logs.push(m); },
    },
  );
  expect(calls).toHaveLength(0);
  expect(logs.some((l) => l.includes("unknown session"))).toBe(true);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `bun test packages/daemon/tests/cli-command.test.ts`
Expected: fails — `cli-command.ts` not found.

- [ ] **Step 3: Implement the helper**

```ts
// packages/daemon/src/cli-command.ts
import type { HubToDaemonCliCommand } from "@cc-remote/proto";

export interface CliCommandDeps {
  lookupPane(session_id: string): { tmux_pane: string | null; tmux_session: string | null } | null;
  spawn(cmd: string, args: string[]): void;
  log(msg: string): void;
}

export function handleCliCommand(frame: HubToDaemonCliCommand, deps: CliCommandDeps): void {
  const target = deps.lookupPane(frame.session_id);
  if (!target) {
    deps.log(`cli_command: unknown session ${frame.session_id}`);
    return;
  }
  const t = target.tmux_pane ?? target.tmux_session;
  if (!t) {
    deps.log(`cli_command: no tmux target for session ${frame.session_id} (pane=null, session=null)`);
    return;
  }
  deps.spawn("tmux", ["send-keys", "-t", t, frame.text, "Enter"]);
  deps.log(`cli_command: sent "${frame.text}" to ${t} (user=${frame.user})`);
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `bun test packages/daemon/tests/cli-command.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Wire into the daemon's hub frame handler**

In `packages/daemon/src/index.ts`, find the chain of `else if (frame.type === "...")` for hub-to-daemon frames (the same place `chat_send` is handled). Add at the end:

```ts
else if (frame.type === "cli_command") {
  handleCliCommand(frame, {
    lookupPane: (id) => {
      const s = sessions.get(id);
      if (!s) return null;
      return { tmux_pane: s.tmux_pane, tmux_session: s.tmux_session };
    },
    spawn: (cmd, args) => { childSpawn(cmd, args, { stdio: "ignore" }); },
    log: (m) => { process.stderr.write(`daemon: ${m}\n`); },
  });
}
```

Add the import at the top:

```ts
import { handleCliCommand } from "./cli-command.ts";
```

(`childSpawn` is already imported from `node:child_process`.)

- [ ] **Step 6: Typecheck**

Run: `bun run --filter='@cc-remote/daemon' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/cli-command.ts packages/daemon/src/index.ts packages/daemon/tests/cli-command.test.ts
git commit -m "daemon: handle cli_command via tmux send-keys"
```

---

## Task 5: Hub — route the new frames

**Files:**
- Modify: `packages/hub/src/router.ts`
- Modify: `packages/hub/src/routes.ts`
- Modify: `packages/hub/tests/router.test.ts`

- [ ] **Step 1: Find where DaemonToHub frames are dispatched in router.ts**

Search for `onDaemonFrame` in `packages/hub/src/router.ts`. The new `slash_inventory` daemon frame attaches a `daemon_id` and broadcasts to all PWAs in the same shape as `task_completed` / `idle` / `session_state`.

- [ ] **Step 2: Write failing tests in router.test.ts**

Append:

```ts
import { test, expect } from "bun:test";
// ...existing imports + setup helpers...

test("forwards daemon slash_inventory to all PWAs with daemon_id added", () => {
  const t = setupTest(); // reuse existing helper that sets up router + 1 daemon + 1 PWA
  const recv: any[] = [];
  t.subscribe((f) => recv.push(f));
  t.router.onDaemonFrame(t.daemonKey, {
    type: "slash_inventory",
    session_id: "s1",
    entries: [{ id: "builtin:clear", name: "/clear", source: "builtin" }],
  });
  const inv = recv.find((r) => r.type === "slash_inventory");
  expect(inv).toBeDefined();
  expect(inv.daemon_id).toBe(t.daemon_id);
  expect(inv.session_id).toBe("s1");
  expect(inv.entries).toHaveLength(1);
});

test("routes pwa cli_command to the addressed daemon with user attached", () => {
  const t = setupTest();
  const sent: any[] = [];
  t.daemonReg.onSend(t.daemon_id, (f) => sent.push(f));
  t.router.onPwaCliCommand(
    { type: "cli_command", daemon_id: t.daemon_id, session_id: "s1", text: "/clear" },
    { user: "alice@x", user_id: "alice" },
  );
  const out = sent.find((s) => s.type === "cli_command");
  expect(out).toBeDefined();
  expect(out.session_id).toBe("s1");
  expect(out.text).toBe("/clear");
  expect(out.user).toBe("alice@x");
});

test("cli_command for unknown daemon is silently dropped (no throw)", () => {
  const t = setupTest();
  expect(() =>
    t.router.onPwaCliCommand(
      { type: "cli_command", daemon_id: "nobody", session_id: "s1", text: "/clear" },
      { user: "alice@x", user_id: "alice" },
    ),
  ).not.toThrow();
});
```

(Adapt `setupTest`/`onSend` etc. to whatever existing helpers `router.test.ts` already has — match the patterns in tests for `chat_send`.)

- [ ] **Step 3: Run tests — verify failure**

Run: `bun test packages/hub/tests/router.test.ts`
Expected: fails on the new tests — methods missing.

- [ ] **Step 4: Implement router changes**

In `packages/hub/src/router.ts`'s `onDaemonFrame` switch (or chained `if`), add a case alongside the other broadcast-with-daemon_id frames:

```ts
} else if (frame.type === "slash_inventory") {
  this.pwaReg.broadcast({
    type: "slash_inventory",
    daemon_id: daemonId,
    session_id: frame.session_id,
    entries: frame.entries,
  });
}
```

Add a new method on the `Router` class, mirroring `onPwaChatSend`:

```ts
onPwaCliCommand(
  frame: PwaToHubCliCommand,
  auth: { user: string; user_id: string },
): void {
  if (!this.daemonReg.has(frame.daemon_id)) {
    // No live daemon connection — silently drop. (PWA can re-emit later.)
    return;
  }
  const out: HubToDaemonCliCommand = {
    type: "cli_command",
    session_id: frame.session_id,
    text: frame.text,
    user: auth.user,
  };
  this.daemonReg.send(frame.daemon_id, out);
}
```

Add to the imports at the top of `router.ts`:

```ts
import type { PwaToHubCliCommand, HubToDaemonCliCommand } from "@cc-remote/proto";
```

- [ ] **Step 5: Wire it into the WS handler**

In `packages/hub/src/routes.ts`, find the existing PWA WS message handler (line ~395). Add a branch for `cli_command`:

```ts
} else if (pf.type === "cli_command") {
  router.onPwaCliCommand(
    pf,
    { user: ws.data.user ?? "anonymous", user_id: ws.data.user_id ?? "anonymous" },
  );
}
```

- [ ] **Step 6: Run tests — verify pass**

Run: `bun test packages/hub/tests/router.test.ts`
Expected: all router tests (existing + 3 new) pass.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter='@cc-remote/hub' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/router.ts packages/hub/src/routes.ts packages/hub/tests/router.test.ts
git commit -m "hub: route slash_inventory + cli_command frames"
```

---

## Task 6: PWA — `useSlashInventory` hook

**Files:**
- Create: `packages/pwa/src/hooks/useSlashInventory.ts`
- Create: `packages/pwa/src/hooks/useSlashInventory.test.ts`
- Modify: `packages/pwa/src/hooks/useHub.ts` (state + reducer entry)

- [ ] **Step 1: Write failing test**

```ts
// packages/pwa/src/hooks/useSlashInventory.test.ts
import { test, expect } from "bun:test";
import { reducer, type HubState } from "./useHub.ts";

const empty: HubState = {
  // ...minimal shape used by reducer; fill in based on the existing initial
  // state in useHub.ts. The point is to start from a known empty state.
} as HubState;

test("inbound slash_inventory frame is stored under (daemon_id, session_id)", () => {
  const after = reducer(empty, {
    type: "frame",
    frame: {
      type: "slash_inventory",
      daemon_id: "d-1",
      session_id: "s-1",
      entries: [
        { id: "builtin:clear", name: "/clear", source: "builtin" },
        { id: "skill:brainstorming", name: "/brainstorming", source: "skill" },
      ],
    },
  });
  expect(after.slashInventory["d-1:s-1"]).toHaveLength(2);
});

test("slash_inventory does not leak across sessions", () => {
  const a = reducer(empty, {
    type: "frame",
    frame: {
      type: "slash_inventory", daemon_id: "d-1", session_id: "s-1",
      entries: [{ id: "builtin:clear", name: "/clear", source: "builtin" }],
    },
  });
  const b = reducer(a, {
    type: "frame",
    frame: {
      type: "slash_inventory", daemon_id: "d-1", session_id: "s-2",
      entries: [],
    },
  });
  expect(b.slashInventory["d-1:s-1"]).toHaveLength(1);
  expect(b.slashInventory["d-1:s-2"]).toHaveLength(0);
});
```

- [ ] **Step 2: Run test — verify failure**

Run: `bun test packages/pwa/src/hooks/useSlashInventory.test.ts`
Expected: fails — state shape lacks `slashInventory`.

- [ ] **Step 3: Add state + reducer branch in useHub.ts**

In `packages/pwa/src/hooks/useHub.ts`:

(a) Extend `HubState`:

```ts
export interface HubState {
  // ...existing fields...
  slashInventory: Record<string, SlashEntry[]>;  // key = `${daemon_id}:${session_id}`
}
```

Initial state — set `slashInventory: {}`.

(b) Add `import type { SlashEntry } from "@cc-remote/proto";` at the top.

(c) In the `case "frame":` switch (line ~267), add:

```ts
case "slash_inventory": {
  const key = `${frame.daemon_id}:${frame.session_id}`;
  return {
    ...state,
    slashInventory: { ...state.slashInventory, [key]: frame.entries },
  };
}
```

- [ ] **Step 4: Implement the hook**

```ts
// packages/pwa/src/hooks/useSlashInventory.ts
import type { SlashEntry } from "@cc-remote/proto";
import { useHub } from "./useHub.ts";

export function useSlashInventory(daemonId: string, sessionId: string): SlashEntry[] {
  const { state } = useHub();
  return state.slashInventory[`${daemonId}:${sessionId}`] ?? [];
}
```

(`useHub` already exposes the `state` — match the existing hook surface; if the hook returns `state` differently, follow that pattern.)

- [ ] **Step 5: Run test — verify pass**

Run: `bun test packages/pwa/src/hooks/useSlashInventory.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Run full PWA tests, fix any reducer-shape regressions**

Run: `bun test packages/pwa/`
Expected: clean (state shape changes shouldn't break existing tests as long as `slashInventory: {}` is added to initial state everywhere it's constructed).

- [ ] **Step 7: Commit**

```bash
git add packages/pwa/src/hooks/useSlashInventory.ts packages/pwa/src/hooks/useSlashInventory.test.ts packages/pwa/src/hooks/useHub.ts
git commit -m "pwa: useSlashInventory hook + reducer integration"
```

---

## Task 7: PWA — `SlashMenu` component

**Files:**
- Create: `packages/pwa/src/screens/primitives/SlashMenu.tsx`
- Create: `packages/pwa/src/screens/primitives/SlashMenu.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// packages/pwa/src/screens/primitives/SlashMenu.test.tsx
import { test, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SlashMenu } from "./SlashMenu.tsx";
import type { SlashEntry } from "@cc-remote/proto";

const ENTRIES: SlashEntry[] = [
  { id: "builtin:clear", name: "/clear", source: "builtin", description: "clear" },
  { id: "builtin:compact", name: "/compact", source: "builtin", description: "compact" },
  { id: "skill:brainstorming", name: "/brainstorming", source: "skill", description: "brainstorm" },
];

test("filters entries by case-insensitive prefix on name (excluding leading /)", () => {
  const { queryByTestId } = render(
    <SlashMenu entries={ENTRIES} draft="/cl" onSelect={() => {}} />,
  );
  expect(queryByTestId("slash-row-builtin:clear")).not.toBeNull();
  expect(queryByTestId("slash-row-builtin:compact")).toBeNull();
  expect(queryByTestId("slash-row-skill:brainstorming")).toBeNull();
});

test("ArrowDown moves highlight, Enter calls onSelect with highlighted entry", () => {
  const picks: SlashEntry[] = [];
  const { container } = render(
    <SlashMenu entries={ENTRIES} draft="/" onSelect={(e) => picks.push(e)} />,
  );
  fireEvent.keyDown(container.firstChild!, { key: "ArrowDown" });
  fireEvent.keyDown(container.firstChild!, { key: "Enter" });
  expect(picks).toHaveLength(1);
  expect(picks[0]!.id).toBe("builtin:compact");
});

test("renders nothing if no entries match", () => {
  const { container } = render(
    <SlashMenu entries={ENTRIES} draft="/zzz" onSelect={() => {}} />,
  );
  expect(container.firstChild).toBeNull();
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test packages/pwa/src/screens/primitives/SlashMenu.test.tsx`
Expected: fails — component missing.

- [ ] **Step 3: Implement SlashMenu**

```tsx
// packages/pwa/src/screens/primitives/SlashMenu.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { SlashEntry } from "@cc-remote/proto";

export interface SlashMenuProps {
  entries: SlashEntry[];
  draft: string;
  onSelect(entry: SlashEntry): void;
}

export function SlashMenu({ entries, draft, onSelect }: SlashMenuProps): JSX.Element | null {
  const filtered = useMemo(() => filterEntries(entries, draft), [entries, draft]);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Reset selection when filter changes.
  useEffect(() => { setActive(0); }, [draft]);

  // Listen on the menu node so tests / users get arrow + enter routing
  // even though the input keeps focus. The menu is rendered next to the
  // input, but key events bubble from the document.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        setActive((a) => (a + 1) % filtered.length);
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive((a) => (a - 1 + filtered.length) % filtered.length);
        e.preventDefault();
      } else if (e.key === "Enter") {
        const pick = filtered[active];
        if (pick) {
          onSelect(pick);
          e.preventDefault();
        }
      }
    }
    const node = ref.current;
    if (node) node.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);
    return () => {
      if (node) node.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onKey);
    };
  }, [filtered, active, onSelect]);

  if (filtered.length === 0) return null;

  return (
    <div ref={ref} tabIndex={-1} data-testid="slash-menu" className="border-border bg-background absolute bottom-full left-0 mb-1 max-h-64 w-full overflow-auto rounded-md border shadow">
      {filtered.map((e, i) => (
        <div
          key={e.id}
          data-testid={`slash-row-${e.id}`}
          aria-selected={i === active}
          className={`px-3 py-2 text-sm ${i === active ? "bg-muted" : ""}`}
          onMouseDown={(ev) => { ev.preventDefault(); onSelect(e); }}
          onMouseEnter={() => setActive(i)}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono">{e.name}</span>
            <span className="text-muted-foreground text-xs">{e.source}</span>
            {e.argument_hint && <span className="text-muted-foreground text-xs">{e.argument_hint}</span>}
          </div>
          {e.description && <div className="text-muted-foreground text-xs">{e.description}</div>}
        </div>
      ))}
    </div>
  );
}

function filterEntries(entries: SlashEntry[], draft: string): SlashEntry[] {
  if (!draft.startsWith("/")) return [];
  const q = draft.slice(1).split(/\s/, 1)[0]!.toLowerCase();
  return entries
    .filter((e) => e.name.slice(1).toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `bun test packages/pwa/src/screens/primitives/SlashMenu.test.tsx`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/primitives/SlashMenu.tsx packages/pwa/src/screens/primitives/SlashMenu.test.tsx
git commit -m "pwa: SlashMenu primitive with filter + keyboard nav"
```

---

## Task 8: PWA — wire menu into composer + outbound routing

**Files:**
- Modify: `packages/pwa/src/screens/SessionView.tsx`
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Modify: `packages/pwa/src/screens/SessionView.test.tsx`

- [ ] **Step 1: Add an `outbound_cli_command` action to useHub**

In `packages/pwa/src/hooks/useHub.ts`'s `HubAction` union, add:

```ts
| { type: "outbound_cli_command"; daemon_id: string; session_id: string; text: string }
```

In the reducer, the action just sends a frame — there's no pending state to track (no ack, no completion). Match the simpler outbound actions (e.g. permission_reply if it has no pending entry); if all outbound actions track pending, add a minimal pending entry (mirror chat_send but kind: "cli_command") — the e2e tests will tell you if this matters. Simplest: emit the WS frame and keep state unchanged.

In the WS-send dispatch (search for the existing `outbound_chat_send` handler — it converts the action into `{ type: "chat_send", ... }` and calls the WebSocket send), add:

```ts
case "outbound_cli_command": {
  ws.send(JSON.stringify({
    type: "cli_command",
    daemon_id: action.daemon_id,
    session_id: action.session_id,
    text: action.text,
  }));
  return state;
}
```

- [ ] **Step 2: Update composer in SessionView.tsx**

Replace the bare `<input>` (around line 170) with:

```tsx
import { SlashMenu } from "./primitives/SlashMenu.tsx";
import { useSlashInventory } from "../hooks/useSlashInventory.ts";

// ...inside the component...
const slashEntries = useSlashInventory(daemon_id, session_id);
const [draft, setDraft] = useState("");

const submit = (text: string) => {
  if (text.startsWith("/") && slashEntries.some((e) => firstToken(text) === e.name)) {
    dispatch({ type: "outbound_cli_command", daemon_id, session_id, text });
  } else {
    dispatch({ type: "outbound_chat_send", daemon_id, session_id, content: text /* + existing fields */ });
  }
  setDraft("");
};

// ...in the JSX where the form lives...
<form className="flex gap-2 relative" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) submit(draft.trim()); }}>
  <SlashMenu
    entries={slashEntries}
    draft={draft}
    onSelect={(entry) => {
      // Append entry name + space; user types args (or hits Enter to submit).
      setDraft(entry.name + " ");
    }}
  />
  <input
    className="..."
    data-testid="chat-input"
    disabled={composerDisabled}
    onChange={(e) => setDraft(e.target.value)}
    placeholder={...}
    value={draft}
  />
  ...existing button...
</form>
```

Where `firstToken(text)` is `text.split(/\s+/, 1)[0] ?? ""`.

(The exact wiring to `dispatch` and `daemon_id` / `session_id` follows the surrounding code's existing pattern — pass them as props or read from context, matching how `chat_send` is dispatched today.)

- [ ] **Step 3: Write the routing test**

In `packages/pwa/src/screens/SessionView.test.tsx`, add a test that mocks the dispatch and verifies submit-routing:

```tsx
test("submitting '/clear' with /clear in inventory dispatches cli_command", () => {
  // ... render SessionView with an inventory containing /clear ...
  // ... fire change event setting draft to "/clear" ...
  // ... fire submit ...
  // ... expect dispatch was called with action.type === "outbound_cli_command" ...
});

test("submitting plain text dispatches chat_send", () => {
  // ... draft = "hello" → outbound_chat_send ...
});

test("submitting '/unknown' falls through to chat_send (not in inventory)", () => {
  // ... ensures we don't accidentally turn typos into cli_command ...
});
```

(Match the surrounding patterns — there are existing SessionView tests using a mock dispatch.)

- [ ] **Step 4: Run all PWA tests**

Run: `bun test packages/pwa/`
Expected: all green.

- [ ] **Step 5: Typecheck PWA**

Run: `bun run --filter='@cc-remote/pwa' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/
git commit -m "pwa: slash menu + cli_command routing in composer"
```

---

## Task 9: e2e-real scenario 22 — `/clear` round-trip

**Files:**
- Create: `e2e-real/tests/22-slash-helpers.test.ts`
- Possibly modify: `e2e-real/helpers/pwa-client.ts` (small helper if needed)

- [ ] **Step 1: Read existing scenario 12 (chat) for the harness pattern**

Run: `head -120 e2e-real/tests/12-chat-roundtrip.test.ts`

Observe how the test pairs daemon, opens session, sends chat, asserts on the timeline. The slash helper test follows the same shape but submits a slash + asserts daemon-side state via `tmux capture-pane`.

- [ ] **Step 2: Write the failing test**

```ts
// e2e-real/tests/22-slash-helpers.test.ts
import { test, expect } from "bun:test";
import { setupRealStack, teardown } from "../helpers/real-stack.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { tmuxCapture } from "../helpers/daemon-host.ts";  // see step 4

test("PWA can submit /clear and tmux pane reflects the cleared state", async () => {
  const stack = await setupRealStack();
  try {
    const pwa = await loginAndConnect(stack);
    await pwa.startSession();

    // Wait for slash inventory to land.
    await pwa.waitFor(() => pwa.state.slashInventory.length > 0, 5_000);
    expect(pwa.state.slashInventory.find((e) => e.name === "/clear")).toBeDefined();

    // Take a baseline pane snapshot, then submit /clear.
    const beforePane = await tmuxCapture(stack.daemonHost, stack.tmuxName);
    await pwa.submitChat("/clear");

    // Within a few seconds, the pane should differ (Claude Code re-renders
    // its prompt screen on /clear).
    await pwa.waitFor(async () => {
      const after = await tmuxCapture(stack.daemonHost, stack.tmuxName);
      return after !== beforePane;
    }, 8_000);
  } finally {
    await teardown(stack);
  }
}, 60_000);
```

- [ ] **Step 3: If `pwa.state.slashInventory` / `pwa.submitChat` accessors don't exist, add them in `e2e-real/helpers/pwa-client.ts`**

Match the existing helper patterns (look for `chat-input` / `data-testid` selectors). Submit by typing into the `chat-input` input and clicking the Send button or pressing Enter.

- [ ] **Step 4: Add `tmuxCapture` helper if missing**

```ts
// e2e-real/helpers/daemon-host.ts (extend or create)
import { spawnSync } from "node:child_process";

export function tmuxCapture(host: "local" | { ssh: string }, tmuxName: string): string {
  // Local-only for now — the demo stack runs daemon on the host.
  const r = spawnSync("tmux", ["capture-pane", "-t", tmuxName, "-p"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tmux capture-pane failed: ${r.stderr}`);
  return r.stdout;
}
```

- [ ] **Step 5: Run the scenario**

Run: `bun test e2e-real/tests/22-slash-helpers.test.ts`

Expected: passes (with all preceding tasks merged) within ~30s.

If it fails because the daemon doesn't track `tmux_pane` for the demo session: confirm that `TMUX_PANE` is being passed through the spawn env. Within the daemon's spawn, the spawned shell inherits `TMUX_PANE`, but the plugin reads `i.env.TMUX_PANE` (`packages/plugin/src/session.ts:20`). If the plugin's process env lacks it, fall back to using `tmux_session` from the snapshot — the cli-command helper from Task 4 already does that.

- [ ] **Step 6: Run the full e2e-real suite**

Run: `bun test e2e-real/`
Expected: all 22 scenarios pass (21 prior + new). Wall time ≤ 7 min (spec §8 budget).

- [ ] **Step 7: Run the full unit-test suite**

Run: `bun test packages/`
Expected: clean. Tally previous count + new tests (~12 additions across packages).

- [ ] **Step 8: Typecheck everything**

Run: `bun run typecheck`
Expected: clean across all 6 packages.

- [ ] **Step 9: Commit + tag**

```bash
git add e2e-real/tests/22-slash-helpers.test.ts e2e-real/helpers/
git commit -m "e2e: scenario 22 — /clear round-trip via PWA slash menu"
git tag plan-slash-input-helper
```

- [ ] **Step 10: Update docs/TODO.md**

Add an entry under the most recent "Plan completed" section recording the new tag and test counts. Match the style of existing completed-plan entries.

```bash
git add docs/TODO.md
git commit -m "docs: mark slash-input-helper plan done"
```

---

## Self-review notes

Spec coverage:
- Spec §5.1 SlashEntry / DaemonSlashInventory / PwaSlashInventory → Task 1 ✓
- Spec §5.2 PwaToHubCliCommand / HubToDaemonCliCommand → Task 1 ✓
- Spec §6.1 scanInventory module → Task 2 ✓
- Spec §6.2 inventory emit → Task 3 ✓
- Spec §6.3 cli_command handling → Task 4 (factored into testable helper) ✓
- Spec §7.1 useSlashInventory → Task 6 ✓
- Spec §7.2 composer changes → Task 8 ✓
- Spec §7.3 SlashMenu file layout → Task 7 ✓
- Spec §8.1 daemon unit tests → Tasks 2 + 4 ✓
- Spec §8.2 PWA unit tests → Tasks 6 + 7 + 8 ✓
- Spec §8.3 e2e scenario 22 → Task 9 ✓
- Spec §10 open question 1 (tmux name lookup): resolved by using `SessionSnapshot.tmux_pane` (preferred) with `tmux_session` fallback — already populated by the plugin in `packages/plugin/src/session.ts:19-20`.

Type consistency: `SlashEntry.id` format is `<source>:<basename>` everywhere; `name` always carries the leading `/`. Built-in subset is the same three commands across spec, scanner, and tests.

No placeholders.
