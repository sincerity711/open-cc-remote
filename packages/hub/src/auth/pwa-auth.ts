import type { Db } from "../db.ts";
import { findDeviceByToken, touchDevice } from "../repos/devices.ts";

export interface PwaAuthResult {
  device_id: string;
  owner_sub: string;
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.get("cookie");
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)cc_session=([^;]+)/);
    if (m) return m[1] ?? null;
  }
  // Fallback for browser WebSocket which can't set arbitrary headers.
  const url = new URL(req.url);
  const t = url.searchParams.get("bearer");
  if (t) return t;
  return null;
}

export function authenticatePwa(db: Db, req: Request): PwaAuthResult | { error: string } {
  const bearer = extractBearer(req);
  if (!bearer) return { error: "authentication required" };
  const device = findDeviceByToken(db, bearer);
  if (!device) return { error: "invalid token" };
  if (device.revoked_at !== null) return { error: "token revoked" };
  if (device.expires_at < Date.now()) return { error: "token expired" };
  touchDevice(db, device.device_id);
  return { device_id: device.device_id, owner_sub: device.owner_sub };
}
