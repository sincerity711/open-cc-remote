export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        email TEXT,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS daemons (
        daemon_id TEXT PRIMARY KEY,
        owner_sub TEXT NOT NULL,
        hostname TEXT,
        public_key_jwk TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        jwt_jti TEXT,
        jwt_exp INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        owner_sub TEXT NOT NULL,
        display_name TEXT,
        user_agent TEXT,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        token_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        issuer_sub TEXT NOT NULL,
        metadata TEXT,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
      CREATE TABLE IF NOT EXISTS push_subs (
        device_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        preferences TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE daemons ADD COLUMN display_name TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS topic_subscriptions (
        device_id TEXT NOT NULL,
        topic_id  TEXT NOT NULL,
        daemon_id TEXT NOT NULL DEFAULT '',
        enabled   INTEGER NOT NULL,
        PRIMARY KEY (device_id, topic_id, daemon_id),
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dnd_settings (
        device_id   TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 0,
        start_hh_mm TEXT,
        end_hh_mm   TEXT,
        timezone    TEXT,
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'permission', '',
             CASE WHEN json_extract(preferences, '$.permission') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.permission') IS NOT NULL;
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'offline', '',
             CASE WHEN json_extract(preferences, '$.offline') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.offline') IS NOT NULL;
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'completed', '',
             CASE WHEN json_extract(preferences, '$.completed') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.completed') IS NOT NULL;
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'idle', '',
             CASE WHEN json_extract(preferences, '$.idle') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.idle') IS NOT NULL;
    `,
  },
];
