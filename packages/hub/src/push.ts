import webpush from "web-push";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VapidConfig } from "./config.ts";
import type { PushSubRow } from "./repos/push-subs.ts";

export interface PushHelper {
  sendTo(subs: PushSubRow[], payload: object): Promise<void>;
}

const noopHelper: PushHelper = {
  async sendTo() { /* no-op when VAPID disabled */ },
};

function fileLogHelper(path: string): PushHelper {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    process.stderr.write(`fileLogHelper: mkdir ${dirname(path)} failed: ${(e as Error).message}\n`);
  }
  return {
    async sendTo(subs: PushSubRow[], payload: object): Promise<void> {
      try {
        const line = JSON.stringify({
          ts: Date.now(),
          subs: subs.map((s) => s.device_id),
          payload,
        }) + "\n";
        appendFileSync(path, line);
      } catch (e) {
        process.stderr.write(`fileLogHelper: append ${path} failed: ${(e as Error).message}\n`);
      }
    },
  };
}

export function createPushHelper(vapid: VapidConfig | undefined): PushHelper {
  if (process.env.HUB_TEST_MODE === "1") {
    return fileLogHelper(process.env.HUB_PUSH_TRACE_PATH ?? "/data/push-trace.log");
  }
  if (!vapid) return noopHelper;
  webpush.setVapidDetails(vapid.subject, vapid.public_key, vapid.private_key);

  return {
    async sendTo(subs: PushSubRow[], payload: object): Promise<void> {
      const json = JSON.stringify(payload);
      await Promise.all(
        subs.map(async (s) => {
          try {
            await webpush.sendNotification(
              { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              json,
            );
          } catch (e) {
            // 410 / 404 = subscription gone; caller may want to clean up.
            // For Plan 5 we just log.
            process.stderr.write(`web-push send to ${s.device_id} failed: ${(e as Error).message}\n`);
          }
        }),
      );
    },
  };
}
