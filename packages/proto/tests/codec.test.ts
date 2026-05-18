import { test, expect } from "bun:test";
import { encodeFrame, FrameDecoder } from "../src/codec.ts";

test("encode then decode round-trips", () => {
  const frame = { type: "register", session: { session_id: "s_1", cwd: "/x" } };
  const decoder = new FrameDecoder();
  const out = decoder.push(encodeFrame(frame));
  expect(out).toEqual([frame]);
});

test("decoder reassembles split chunks", () => {
  const frame = { hello: "world" };
  const bytes = encodeFrame(frame);
  const decoder = new FrameDecoder();
  expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
  expect(decoder.push(bytes.subarray(2, 5))).toEqual([]);
  expect(decoder.push(bytes.subarray(5))).toEqual([frame]);
});

test("decoder yields multiple frames in a single chunk", () => {
  const a = encodeFrame({ a: 1 });
  const b = encodeFrame({ b: 2 });
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  const decoder = new FrameDecoder();
  expect(decoder.push(merged)).toEqual([{ a: 1 }, { b: 2 }]);
});

test("decoder rejects oversize length header", () => {
  const decoder = new FrameDecoder();
  const evil = new Uint8Array(4);
  new DataView(evil.buffer).setUint32(0, 999_999_999, false);
  expect(() => decoder.push(evil)).toThrow(/frame too large/);
});
