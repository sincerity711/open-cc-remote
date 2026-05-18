// Length-prefixed JSON for Unix socket framing.
// Wire: [4-byte BE length][UTF-8 JSON payload]

const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16MB hard ceiling

export function encodeFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  const payload = new TextEncoder().encode(json);
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${payload.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, false);
  out.set(payload, HEADER_BYTES);
  return out;
}

export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const out: unknown[] = [];
    while (this.buffer.byteLength >= HEADER_BYTES) {
      const len = new DataView(this.buffer.buffer, this.buffer.byteOffset, HEADER_BYTES).getUint32(0, false);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`frame too large: ${len}`);
      }
      if (this.buffer.byteLength < HEADER_BYTES + len) break;
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + len);
      out.push(JSON.parse(new TextDecoder().decode(payload)));
      this.buffer = this.buffer.subarray(HEADER_BYTES + len);
    }
    return out;
  }
}
