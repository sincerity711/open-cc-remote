import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS permissions (
  request_id   TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  decision     TEXT,
  decided_via  TEXT
);
`;

export type Db = Database;

export function openDb(path: string): Db {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
