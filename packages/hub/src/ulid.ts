// Tiny ULID generator: 26-char Crockford-base32, time-prefixed (10 chars) +
// random (16 chars). No external dep; uses crypto.getRandomValues. Lexically
// sortable, monotonic-enough for our chat use case.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[buf[i]! % 32];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}
