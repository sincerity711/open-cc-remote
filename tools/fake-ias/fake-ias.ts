#!/usr/bin/env bun
// Bun-side wrapper for the oidc-provider-backed fake IAS server.
// Spawns tools/fake-ias/oidc-server.mjs under `node` and waits for its READY line.

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface FakeIasOptions {
  port?: number;
  sub?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUris?: string[];
}

export interface FakeIasHandle {
  url: string;
  port: number;
  pid: number;
  publicJwk: Record<string, unknown>;
  stop(): Promise<void>;
}

const SERVER_MJS = join(dirname(fileURLToPath(import.meta.url)), "oidc-server.mjs");

export async function startFakeIas(opts: FakeIasOptions = {}): Promise<FakeIasHandle> {
  const sub = opts.sub ?? "i060912@sap.com";
  const clientId = opts.clientId ?? "cc-remote";
  const clientSecret = opts.clientSecret ?? "test-secret";
  const redirectUris = opts.redirectUris ?? ["http://localhost:9999/cb"];
  const port = opts.port ?? 0;

  const env: Record<string, string> = {
    ...process.env,
    FAKE_IAS_PORT: String(port),
    FAKE_IAS_SUB: sub,
    FAKE_IAS_CLIENT_ID: clientId,
    FAKE_IAS_CLIENT_SECRET: clientSecret,
    FAKE_IAS_REDIRECT_URIS: redirectUris.join(","),
  };

  const child = spawn("node", [SERVER_MJS], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise<FakeIasHandle>((resolve, reject) => {
    const stderrChunks: Buffer[] = [];
    let stdoutBuf = "";
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("startFakeIas: timed out waiting for READY line (5s)"));
    }, 5000);

    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");

      // Drain all complete lines per chunk so a pre-READY stdout line doesn't stall us.
      let newline: number;
      while ((newline = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, newline).trimEnd();
        stdoutBuf = stdoutBuf.slice(newline + 1);

        if (!line.startsWith("READY ")) continue;

        let parsed: { port: number; issuer: string; publicJwk: Record<string, unknown> };
        try {
          parsed = JSON.parse(line.slice("READY ".length));
        } catch (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          child.kill("SIGKILL");
          reject(new Error(`startFakeIas: invalid READY JSON: ${line}`));
          return;
        }

        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);

        const handle: FakeIasHandle = {
          url: parsed.issuer,
          port: parsed.port,
          pid: child.pid!,
          publicJwk: parsed.publicJwk,

          stop(): Promise<void> {
            return new Promise<void>((res) => {
              if (child.exitCode !== null) {
                res();
                return;
              }
              const escalate = setTimeout(() => child.kill("SIGKILL"), 2000);
              child.once("exit", () => {
                clearTimeout(escalate);
                res();
              });
              child.kill("SIGTERM");
            });
          },
        };
        resolve(handle);
        return; // stop draining; we're done
      }
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      reject(
        new Error(`startFakeIas: child exited with code ${code} before READY.\nstderr: ${stderr}`)
      );
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(`startFakeIas: failed to spawn child: ${err.message}`));
    });
  });
}

if (import.meta.main) {
  const handle = await startFakeIas({
    port: Number(process.env.FAKE_IAS_PORT ?? 17770),
    sub: process.env.FAKE_IAS_SUB,
  });
  console.log(`fake-ias listening at ${handle.url}  (pid ${handle.pid})`);
}
