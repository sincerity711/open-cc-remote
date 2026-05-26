// packages/hub/src/push-dispatch.ts
import type { Db } from "./db.ts";
import type { PushHelper } from "./push.ts";
import type { PushTopic } from "./push-topics.ts";
import { findActiveSubsForTopic } from "./repos/topic-subscriptions.ts";
import { findDaemon } from "./repos/daemons.ts";
import { getDndSettings } from "./repos/dnd.ts";
import { isInDndWindow } from "./dnd.ts";

export async function dispatchTopic(
  db: Db,
  push: PushHelper,
  topic: PushTopic,
  daemon_id: string,
  ctx: unknown,
): Promise<void> {
  const daemon = findDaemon(db, daemon_id);
  if (!daemon) return;

  const subs = findActiveSubsForTopic(
    db, daemon.owner_sub, topic.id, daemon_id, topic.default_enabled,
  );
  if (subs.length === 0) return;

  const filtered = topic.bypass_dnd
    ? subs
    : subs.filter((s) => !isInDndWindow(getDndSettings(db, s.device_id), Date.now()));
  if (filtered.length === 0) return;

  const payload = topic.build_payload(ctx);
  const tag = topic.build_tag(payload);
  await push.sendTo(filtered, { ...payload, tag });
}
