// Scenario 23 — AskUserQuestion remote relay round-trip.
//
// Workaround for anthropics/claude-code#59245 (no channel notification for
// AskUserQuestion yet). The PreToolUse hook (.claude/hooks/ask-user-relay.ts)
// is supposed to:
//   1. Read CC stdin → connect to daemon socket → send ask_user_question_request.
//   2. Daemon resolves session by claude_session_id → forwards to hub.
//   3. Hub broadcasts → PWA renders the AskQuestionSurface card.
//   4. User picks options + Submit → ask_user_question_answer flows back.
//   5. Hook stdout = `{ hookSpecificOutput: { permissionDecision: "deny",
//      permissionDecisionReason: <answers as text> } }`.
//
// We exercise that path end-to-end here by spawning the hook script as a child
// process (the same way CC would) with a test stdin payload, registering a
// fake session via fake-claude so the daemon recognizes the
// claude_session_id, then driving the PWA in a real browser.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fakeClaudeBin = resolve(repoRoot, "tools", "fake-claude", "fake-claude.ts");
const hookBin = resolve(repoRoot, ".claude", "hooks", "ask-user-relay.ts");

let preview: PreviewHandle;

test.beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
  preview = await startPreview();
});

test.afterAll(async () => {
  await preview?.stop();
  await downCompose();
});

test.afterEach(async ({}, testInfo) => {
  await syncIfPassed(testInfo, "23-ask-user-question");
});

function encodeCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, "") || "/").replace(/\//g, "-");
}

interface HookExitInfo {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runHook(
  hookPath: string,
  socket: string,
  payload: object,
): { proc: ChildProcess; finished: Promise<HookExitInfo> } {
  const proc = spawn("bun", [hookPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CC_REMOTE_SOCKET: socket },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  proc.stdin?.write(JSON.stringify(payload));
  proc.stdin?.end();
  const finished = new Promise<HookExitInfo>((res) => {
    proc.on("close", (code) => res({ exitCode: code, stdout, stderr }));
  });
  return { proc, finished };
}

test("ask-user-question relay: hook → daemon → PWA → answer round-trip", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `auq-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-auq-projects-"));
  const sessionCwd = "/private/tmp/cc-remote-mock-auq";
  const sessionId = "mock-auq-session";

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    extra_env: { CLAUDE_PROJECTS_DIR: projectsRoot },
  });

  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "23-ask-user-question",
    projectName: testInfo.project.name,
  });

  // Pre-create the JSONL file so daemon's bind watcher attaches.
  const sessionDir = join(projectsRoot, encodeCwd(sessionCwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, "");

  let fakeClaude: ChildProcess | undefined;
  let hook: { proc: ChildProcess; finished: Promise<HookExitInfo> } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("daemon-card-visible", async () => {
      await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
    });

    // Spawn fake-claude to register the session so daemon knows about it.
    // Same claude_session_id will be sent by the hook.
    fakeClaude = spawn(
      "bun",
      [
        fakeClaudeBin,
        "--session-id", sessionId,
        "--claude-session-id", sessionId,
        "--cwd", sessionCwd,
        "--socket", handle.socket_path,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );

    await sc.step("session-row-appears", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.getByTestId("session-row").first().waitFor({ timeout: 30_000 });
      // Open the session BEFORE the hook fires. Since commit 7114777
      // (May 28), the PWA only renders AskQuestionSurface for the
      // currently-selected session — the right drawer no longer pops on
      // the daemons-list view. So the test must open the matching
      // session first; otherwise pendingQuestions never resolves into a
      // visible surface and we time out on `ask-question-surface`.
      await sessionsList.getByTestId("session-row").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("hook-fires", async () => {
      // Spawn the PreToolUse hook with a CC-style stdin payload. claude_session_id
      // matches the fake-claude registration so daemon can resolve it.
      hook = runHook(hookBin, handle.socket_path, {
        session_id: sessionId,
        tool_name: "AskUserQuestion",
        cwd: sessionCwd,
        tool_input: {
          questions: [
            {
              question: "Where should the file go?",
              header: "Location",
              multiSelect: false,
              options: [
                { label: "docs/", description: "next to other docs" },
                { label: "src/", description: "alongside source" },
              ],
            },
          ],
        },
      });
    });

    await sc.step("ask-question-surface-appears", async () => {
      const surface = session.page.getByTestId("ask-question-surface");
      await surface.waitFor({ timeout: 30_000 });
      await expect(surface).toBeVisible();
    });

    await sc.step("user-picks-option", async () => {
      await session.page.getByTestId("ask-option-0-0").click();
    });

    await sc.step("user-submits", async () => {
      await session.page.getByTestId("ask-question-submit").click();
      await expect(session.page.getByTestId("ask-question-surface")).toHaveCount(0, { timeout: 10_000 });
    });

    await sc.step("hook-returns-with-answer", async () => {
      const r = await hook!.finished;
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = out.hookSpecificOutput?.permissionDecisionReason as string;
      expect(reason).toContain("docs/");
      expect(reason).toContain("Q1:");
    });
  } finally {
    if (fakeClaude && fakeClaude.exitCode === null) {
      try { fakeClaude.kill("SIGTERM"); } catch {}
    }
    if (hook && hook.proc.exitCode === null) {
      try { hook.proc.kill("SIGTERM"); } catch {}
    }
    await session.close();
    await handle.cleanup();
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch {}
  }
});
