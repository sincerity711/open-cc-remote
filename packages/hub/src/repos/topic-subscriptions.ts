// packages/hub/src/repos/topic-subscriptions.ts
import type { Db } from "../db.ts";
import type { PushSubRow } from "./push-subs.ts";

export interface SubRow { topic_id: string; daemon_id: string | null; enabled: boolean }

export function setSubscription(
  db: Db, device_id: string, topic_id: string, daemon_id: string, enabled: boolean,
): void {
  db.prepare(
    `INSERT INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id, topic_id, daemon_id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(device_id, topic_id, daemon_id, enabled ? 1 : 0);
}

export function deleteSubscription(
  db: Db, device_id: string, topic_id: string, daemon_id: string,
): void {
  db.prepare(
    "DELETE FROM topic_subscriptions WHERE device_id = ? AND topic_id = ? AND daemon_id = ?",
  ).run(device_id, topic_id, daemon_id);
}

export function deleteAllForDaemon(db: Db, device_id: string, daemon_id: string): void {
  db.prepare(
    "DELETE FROM topic_subscriptions WHERE device_id = ? AND daemon_id = ?",
  ).run(device_id, daemon_id);
}

export function listSubscriptions(db: Db, device_id: string): SubRow[] {
  const rows = db.query(
    "SELECT topic_id, daemon_id, enabled FROM topic_subscriptions WHERE device_id = ? ORDER BY topic_id, daemon_id",
  ).all(device_id) as Array<{ topic_id: string; daemon_id: string; enabled: number }>;
  return rows.map((r) => ({
    topic_id: r.topic_id,
    daemon_id: r.daemon_id === "" ? null : r.daemon_id,
    enabled: r.enabled === 1,
  }));
}

/**
 * Returns push subscriptions for devices owned by `owner_sub` whose effective
 * subscription for (`topic_id`, `daemon_id`) resolves to enabled.
 *
 * Resolution order (per device):
 *   1. (device, topic, daemon_id) row, if present
 *   2. (device, topic, '')         row, if present
 *   3. `default_enabled` argument
 */
export function findActiveSubsForTopic(
  db: Db, owner_sub: string, topic_id: string, daemon_id: string, default_enabled: boolean,
): PushSubRow[] {
  const rows = db.query(
    `SELECT ps.device_id, ps.endpoint, ps.p256dh, ps.auth, ps.preferences,
       COALESCE(
         (SELECT enabled FROM topic_subscriptions
            WHERE device_id = ps.device_id AND topic_id = ?1 AND daemon_id = ?2),
         (SELECT enabled FROM topic_subscriptions
            WHERE device_id = ps.device_id AND topic_id = ?1 AND daemon_id = ''),
         ?3
       ) AS effective_enabled
     FROM push_subs ps
     JOIN devices d ON d.device_id = ps.device_id
     WHERE d.owner_sub = ?4 AND d.revoked_at IS NULL`,
  ).all(topic_id, daemon_id, default_enabled ? 1 : 0, owner_sub) as Array<{
    device_id: string; endpoint: string; p256dh: string; auth: string;
    preferences: string; effective_enabled: number;
  }>;
  return rows
    .filter((r) => r.effective_enabled === 1)
    .map((r) => ({
      device_id: r.device_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      preferences: {},
    }));
}
