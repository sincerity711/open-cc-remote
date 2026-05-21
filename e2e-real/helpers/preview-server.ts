import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pwaDir = resolve(repoRoot, "packages", "pwa");

export interface PreviewHandle {
  baseURL: string;
  stop: () => Promise<void>;
}

/** Builds the PWA, then starts vite preview. Resolves once /index.html responds 200. */
export async function startPreview(): Promise<PreviewHandle> {
  // 1. Build (one-shot per test session is fine).
  await new Promise<void>((res, rej) => {
    const p = spawn("bun", ["run", "build"], { cwd: pwaDir, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`vite build exit ${code}`))));
  });

  // 2. Start preview.
  const child: ChildProcess = spawn("bun", ["run", "preview"], { cwd: pwaDir, stdio: ["ignore", "pipe", "pipe"] });
  const baseURL = "http://localhost:4173";

  // 3. Wait for ready.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseURL);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error("vite preview did not become ready within 30s");
  }

  return {
    baseURL,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 250));
    },
  };
}
