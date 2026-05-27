import type { Db } from "../db.ts";

export type PairingKind = "daemon";
export interface ConsumedCode {
  kind: PairingKind;
  issuer_sub: string;
  metadata: Record<string, unknown> | null;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

function generateCode(): string {
  // Reject-resample to avoid modulo bias on the 31-char alphabet.
  const buf = new Uint8Array(CODE_LEN * 2);
  let raw = "";
  while (raw.length < CODE_LEN) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && raw.length < CODE_LEN; i++) {
      const b = buf[i]!;
      if (b >= 248) continue; // 256 % 31 == 8 → reject [248,255] for unbiased modulo
      raw += ALPHABET[b % ALPHABET.length];
    }
  }
  return raw.slice(0, 4) + "-" + raw.slice(4);
}

export const MAX_PAIR_TTL_MS = 5 * 60_000;

export function issueCode(
  db: Db,
  kind: PairingKind,
  issuer_sub: string,
  metadata: Record<string, unknown> | null,
  ttlMs: number,
): string {
  const ttl = Math.min(ttlMs, MAX_PAIR_TTL_MS);
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      db.prepare(
        "INSERT INTO pairing_codes (code, kind, issuer_sub, metadata, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(code, kind, issuer_sub, metadata ? JSON.stringify(metadata) : null, Date.now() + ttl);
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
