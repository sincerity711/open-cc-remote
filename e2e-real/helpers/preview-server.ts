import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pwaDir = resolve(repoRoot, "packages", "pwa");
const PREVIEW_PORT = 4173;

export interface PreviewHandle {
  baseURL: string;
  stop: () => Promise<void>;
}

async function isPortBound(port: number, host = "127.0.0.1"): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolveBound) => {
    const sock = net.createConnection({ host, port });
    sock.once("connect", () => { sock.end(); resolveBound(true); });
    sock.once("error", () => resolveBound(false));
    setTimeout(() => { try { sock.destroy(); } catch {} resolveBound(false); }, 500);
  });
}

async function waitPortFree(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await isPortBound(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Builds the PWA, then starts vite preview. Resolves once /index.html responds 200. */
export async function startPreview(): Promise<PreviewHandle> {
  // 1. Build. Pin VITE_HUB_URL to the e2e compose's host port (7745) so the
  //    bundled PWA points at the test hub regardless of the package-level
  //    default (which is 17745 to avoid host-port conflicts in dev).
  await new Promise<void>((res, rej) => {
    const p = spawn("bun", ["run", "build"], {
      cwd: pwaDir,
      stdio: "inherit",
      env: { ...process.env, VITE_HUB_URL: "ws://localhost:7745" },
    });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`vite build exit ${code}`))));
  });

  // 2. If a prior preview from another scenario still holds the port
  //    (SIGTERM may not have fully released it), wait for release. If it
  //    never frees, fall through and let `bun run preview` error noisily.
  if (await isPortBound(PREVIEW_PORT)) {
    process.stderr.write(`[preview-server] port ${PREVIEW_PORT} bound at startup — waiting up to 10s for release\n`);
    await waitPortFree(PREVIEW_PORT, 10_000);
  }

  // 3. Start preview.
  const child: ChildProcess = spawn("bun", ["run", "preview"], { cwd: pwaDir, stdio: ["ignore", "pipe", "pipe"] });
  const baseURL = `http://localhost:${PREVIEW_PORT}`;

  // 4. Wait for ready (HTTP 200).
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
      // SIGTERM, then wait for actual port release. The previous 250ms
      // sleep was too short — the next file's startPreview could race
      // against the still-bound port and either get ECONNREFUSED on the
      // poll OR (worse) connect to a half-dead server.
      try { child.kill("SIGTERM"); } catch {}
      const freed = await waitPortFree(PREVIEW_PORT, 5_000);
      if (!freed) {
        try { child.kill("SIGKILL"); } catch {}
        await waitPortFree(PREVIEW_PORT, 2_000);
      }
    },
  };
}
