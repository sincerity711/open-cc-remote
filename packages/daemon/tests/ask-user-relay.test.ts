import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";

const ROOT = join(import.meta.dir, "..", "..", "..");
const HOOK = join(ROOT, ".claude", "hooks", "ask-user-relay.ts");

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(socketPath: string, stdin: string): Promise<HookResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CC_REMOTE_SOCKET: socketPath },
    });
    let stdout = ""; let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function tmpSocket() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-hook-"));
  return { dir, path: join(dir, "test.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ask-user-relay hook: round-trip — daemon answers, hook emits deny+reason", async () => {
  const t = tmpSocket();
  let serverFrame: { type: string; request_id: string; questions: { question: string }[]; claude_session_id: string } | null = null;
  const server = createServer((sock: Socket) => {
    const dec = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      for (const f of dec.push(new Uint8Array(chunk))) {
        const fr = f as { type?: string; request_id?: string };
        if (fr.type === "ask_user_question_request") {
          serverFrame = f as typeof serverFrame extends infer T ? T : never;
          // Reply with answers.
          sock.write(encodeFrame({
            type: "ask_user_question_answer",
            request_id: fr.request_id,
            answers: ["docs/", "markdown"],
            resolution: "answered",
          }));
        }
      }
    });
  });
  await new Promise<void>((res) => server.listen(t.path, () => res()));
  try {
    const stdin = JSON.stringify({
      session_id: "claude-uuid-123",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Where?", header: "Loc", multiSelect: false, options: [{ label: "docs/" }, { label: "src/" }] },
          { question: "Format?", header: "Fmt", multiSelect: false, options: [{ label: "markdown" }, { label: "text" }] },
        ],
      },
    });
    const r = await runHook(t.path, stdin);
    expect(r.exitCode).toBe(0);
    expect(serverFrame).not.toBeNull();
    expect(serverFrame!.claude_session_id).toBe("claude-uuid-123");
    expect(serverFrame!.questions).toHaveLength(2);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = out.hookSpecificOutput?.permissionDecisionReason as string;
    expect(reason).toContain("docs/");
    expect(reason).toContain("markdown");
    expect(reason).toContain("Q1:");
    expect(reason).toContain("Q2:");
  } finally {
    server.close();
    t.cleanup();
  }
}, 15_000);

test("ask-user-relay hook: daemon offline → emits no_pwa fallback", async () => {
  const t = tmpSocket();
  // No server listening on t.path.
  try {
    const stdin = JSON.stringify({
      session_id: "claude-uuid-x",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "?", header: "h", multiSelect: false, options: [{ label: "a" }] },
        ],
      },
    });
    const r = await runHook(t.path, stdin);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/No PWA was connected|Daemon doesn't recognize/);
  } finally {
    t.cleanup();
  }
}, 15_000);

test("ask-user-relay hook: non-AskUserQuestion tool passes through", async () => {
  const t = tmpSocket();
  try {
    const stdin = JSON.stringify({
      session_id: "claude-uuid-y",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const r = await runHook(t.path, stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
  } finally {
    t.cleanup();
  }
}, 15_000);
