import type { Db } from "../db.ts";

export type PairingKind = "daemon";
export interface ConsumedCode {
  kind: PairingKind;
  issuer_sub: string;
  metadata: Record<string, unknown> | null;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  let raw = "";
  for (let i = 0; i < 6; i++) raw += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return raw.slice(0, 3) + "-" + raw.slice(3);
}

export function issueCode(
  db: Db,
  kind: PairingKind,
  issuer_sub: string,
  metadata: Record<string, unknown> | null,
  ttlMs: number,
): string {
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      db.prepare(
        "INSERT INTO pairing_codes (code, kind, issuer_sub, metadata, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(code, kind, issuer_sub, metadata ? JSON.stringify(metadata) : null, Date.now() + ttlMs);
      return code;
    } catch { /* PK collision, retry */ }
  }
  throw new Error("could not issue pairing code after retries");
}

export function consumeCode(db: Db, code: string): ConsumedCode | null {
  const now = Date.now();
  const row = db.query(
    "SELECT kind, issuer_sub, metadata, expires_at, consumed_at FROM pairing_codes WHERE code = ?",
  ).get(code) as
    | { kind: string; issuer_sub: string; metadata: string | null; expires_at: number; consumed_at: number | null }
    | null;
  if (!row) return null;
  if (row.consumed_at !== null) return null;
  if (row.expires_at < now) return null;

  const upd = db.prepare(
    "UPDATE pairing_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL",
  ).run(now, code);
  if (upd.changes !== 1) return null;

  return {
    kind: row.kind as PairingKind,
    issuer_sub: row.issuer_sub,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };
}
