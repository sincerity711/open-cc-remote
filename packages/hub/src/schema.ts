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
    `,
  },
];
