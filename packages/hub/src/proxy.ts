// Trusted-proxy gating for X-Forwarded-* headers and client IP extraction.
//
// HUB_TRUSTED_PROXIES: comma-separated CIDRs. When the immediate peer falls in
// any of them we honor X-Forwarded-For (first hop) and X-Forwarded-Proto/Host
// for DPoP htu reconstruction. Empty list = no trust = use socket peer / req.url
// as-is. Default is empty so behavior is identical to today unless opted in.

export interface TrustedProxies {
  cidrs: ReadonlyArray<ParsedCidr>;
}

interface ParsedCidr {
  v6: boolean;
  bits: number;
  bytes: Uint8Array;
}

export function parseTrustedProxies(spec: string | undefined): TrustedProxies {
  if (!spec) return { cidrs: [] };
  const cidrs: ParsedCidr[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parsed = parseCidr(raw);
    if (parsed) cidrs.push(parsed);
  }
  return { cidrs };
}

function parseCidr(spec: string): ParsedCidr | null {
  const slash = spec.indexOf("/");
  const host = slash >= 0 ? spec.slice(0, slash) : spec;
  const v6 = host.includes(":");
  const total = v6 ? 128 : 32;
  const bits = slash >= 0 ? Number(spec.slice(slash + 1)) : total;
  if (!Number.isFinite(bits) || bits < 0 || bits > total) return null;
  const bytes = v6 ? parseV6(host) : parseV4(host);
  if (!bytes) return null;
  return { v6, bits, bytes };
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(s: string): Uint8Array | null {
  // Strip zone id (rare in headers but safe).
  const z = s.indexOf("%");
  const addr = z >= 0 ? s.slice(0, z) : s;
  const dd = addr.indexOf("::");
  let head: string[] = [];
  let tail: string[] = [];
  if (dd >= 0) {
    head = addr.slice(0, dd) ? addr.slice(0, dd).split(":") : [];
    tail = addr.slice(dd + 2) ? addr.slice(dd + 2).split(":") : [];
  } else {
    head = addr.split(":");
  }
  // Possible IPv4-mapped tail (e.g., ::ffff:1.2.3.4)
  let v4Bytes: Uint8Array | null = null;
  const last = tail.length ? tail[tail.length - 1] : (head.length ? head[head.length - 1] : "");
  if (last && last.includes(".")) {
    v4Bytes = parseV4(last);
    if (!v4Bytes) return null;
    if (tail.length) tail = tail.slice(0, -1);
    else head = head.slice(0, -1);
  }
  const groups = head.length + tail.length + (v4Bytes ? 2 : 0);
  if (groups > 8) return null;
  const fill = 8 - groups;
  if (dd < 0 && fill !== 0) return null;
  const out = new Uint8Array(16);
  let i = 0;
  for (const g of head) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff || g.length > 4) return null;
    out[i++] = (n >> 8) & 0xff;
    out[i++] = n & 0xff;
  }
  i += fill * 2;
  for (const g of tail) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff || g.length > 4) return null;
    out[i++] = (n >> 8) & 0xff;
    out[i++] = n & 0xff;
  }
  if (v4Bytes) {
    out[i++] = v4Bytes[0]!;
    out[i++] = v4Bytes[1]!;
    out[i++] = v4Bytes[2]!;
    out[i++] = v4Bytes[3]!;
  }
  return out;
}

function parseAddress(addr: string): { v6: boolean; bytes: Uint8Array } | null {
  if (!addr) return null;
  // Strip ::ffff: IPv4-mapped prefix when the address has one but is otherwise a v4 string.
  const v4 = parseV4(addr);
  if (v4) return { v6: false, bytes: v4 };
  const v6 = parseV6(addr);
  if (v6) return { v6: true, bytes: v6 };
  return null;
}

function inCidr(addr: { v6: boolean; bytes: Uint8Array }, cidr: ParsedCidr): boolean {
  if (addr.v6 !== cidr.v6) {
    // Allow v4 addr to match against ::ffff:0:0/96-style v6 cidr by promoting.
    if (!addr.v6 && cidr.v6) {
      const promoted = new Uint8Array(16);
      promoted[10] = 0xff; promoted[11] = 0xff;
      promoted.set(addr.bytes, 12);
      return inCidr({ v6: true, bytes: promoted }, cidr);
    }
    return false;
  }
  let bits = cidr.bits;
  for (let i = 0; bits > 0; i++) {
    const take = bits >= 8 ? 8 : bits;
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((addr.bytes[i]! & mask) !== (cidr.bytes[i]! & mask)) return false;
    bits -= take;
  }
  return true;
}

export function isTrustedAddress(peer: string | undefined, tp: TrustedProxies): boolean {
  if (!peer || tp.cidrs.length === 0) return false;
  const a = parseAddress(peer);
  if (!a) return false;
  for (const c of tp.cidrs) if (inCidr(a, c)) return true;
  return false;
}

export interface ResolvedRequest {
  client_ip: string;
  url: string;
}

// Resolve client IP and the public URL the client actually addressed.
//   - peer is the socket-level remote address (server.requestIP(req)).
//   - When peer is in trusted_proxies, take XFF[0] as client_ip and rebuild
//     URL from XFP + XFH; otherwise use peer + req.url verbatim.
export function resolveRequest(
  req: Request,
  peer: string | undefined,
  tp: TrustedProxies,
): ResolvedRequest {
  const fallback: ResolvedRequest = { client_ip: peer ?? "unknown", url: req.url };
  if (!isTrustedAddress(peer, tp)) return fallback;

  const xff = req.headers.get("x-forwarded-for");
  const client_ip = xff ? (xff.split(",")[0]?.trim() ?? peer ?? "unknown") : (peer ?? "unknown");

  const xfp = req.headers.get("x-forwarded-proto");
  const xfh = req.headers.get("x-forwarded-host");
  if (!xfp && !xfh) return { client_ip, url: req.url };

  try {
    const orig = new URL(req.url);
    const proto = (xfp ? (xfp.split(",")[0]?.trim() ?? orig.protocol.replace(/:$/, "")) : orig.protocol.replace(/:$/, ""));
    const host = xfh ? (xfh.split(",")[0]?.trim() ?? orig.host) : orig.host;
    const url = `${proto}://${host}${orig.pathname}${orig.search}`;
    return { client_ip, url };
  } catch {
    return { client_ip, url: req.url };
  }
}
