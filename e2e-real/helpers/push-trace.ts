import { spawn } from "node:child_process";

export interface PushTraceEntry {
  ts: number;
  subs: string[];
  payload: { kind: string; tag?: string; daemon_id?: string; session_id?: string; request_id?: string; body?: string; [k: string]: unknown };
}

async function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += String(b); });
    p.stderr.on("data", (b) => { err += String(b); });
    p.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} → ${code}\n${err}`)));
  });
}

export async function readPushTrace(): Promise<PushTraceEntry[]> {
  let raw: string;
  try {
    raw = await exec("docker", ["compose", "exec", "-T", "hub", "sh", "-c", "cat /data/push-trace.log 2>/dev/null || true"]);
  } catch {
    return [];
  }
  return raw.split("\n").filter((l) => l.trim().length > 0).map((line) => JSON.parse(line) as PushTraceEntry);
}

export async function clearPushTrace(): Promise<void> {
  try {
    await exec("docker", ["compose", "exec", "-T", "hub", "sh", "-c", ": > /data/push-trace.log"]);
  } catch {
    /* ignore */
  }
}

export async function waitForPushKind(kind: string, timeoutMs = 5_000): Promise<PushTraceEntry | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readPushTrace();
    const hit = entries.find((e) => e.payload.kind === kind);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
