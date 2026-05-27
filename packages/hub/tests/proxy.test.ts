import { test, expect } from "bun:test";
import { parseTrustedProxies, isTrustedAddress, resolveRequest } from "../src/proxy.ts";

test("parseTrustedProxies handles empty / undefined as empty", () => {
  expect(parseTrustedProxies(undefined).cidrs.length).toBe(0);
  expect(parseTrustedProxies("").cidrs.length).toBe(0);
});

test("isTrustedAddress IPv4 CIDR match", () => {
  const tp = parseTrustedProxies("10.0.0.0/8,127.0.0.1");
  expect(isTrustedAddress("10.5.6.7", tp)).toBe(true);
  expect(isTrustedAddress("10.0.0.1", tp)).toBe(true);
  expect(isTrustedAddress("11.0.0.1", tp)).toBe(false);
  expect(isTrustedAddress("127.0.0.1", tp)).toBe(true);
  expect(isTrustedAddress("127.0.0.2", tp)).toBe(false);
});

test("isTrustedAddress empty config trusts no one", () => {
  const tp = parseTrustedProxies("");
  expect(isTrustedAddress("127.0.0.1", tp)).toBe(false);
});

test("isTrustedAddress IPv6", () => {
  const tp = parseTrustedProxies("::1,fd00::/8");
  expect(isTrustedAddress("::1", tp)).toBe(true);
  expect(isTrustedAddress("fd12:3456::1", tp)).toBe(true);
  expect(isTrustedAddress("2001:db8::1", tp)).toBe(false);
});

test("resolveRequest from untrusted peer ignores XFF/XFP/XFH", () => {
  const tp = parseTrustedProxies(""); // no trust
  const req = new Request("http://hub.local:7745/pair", {
    headers: {
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "public.example.com",
    },
  });
  const r = resolveRequest(req, "192.168.0.5", tp);
  expect(r.client_ip).toBe("192.168.0.5");
  expect(r.url).toBe("http://hub.local:7745/pair");
});

test("resolveRequest from trusted peer reconstructs URL and IP", () => {
  const tp = parseTrustedProxies("10.0.0.0/8");
  const req = new Request("http://hub-internal:7745/pair", {
    headers: {
      "x-forwarded-for": "203.0.113.7, 10.0.0.99",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "hub.example.com",
    },
  });
  const r = resolveRequest(req, "10.0.0.99", tp);
  expect(r.client_ip).toBe("203.0.113.7");
  expect(r.url).toBe("https://hub.example.com/pair");
});

test("resolveRequest preserves path and query", () => {
  const tp = parseTrustedProxies("10.0.0.0/8");
  const req = new Request("http://internal/ws/daemon?daemon_id=mac", {
    headers: {
      "x-forwarded-proto": "wss",
      "x-forwarded-host": "hub.example.com",
    },
  });
  const r = resolveRequest(req, "10.0.0.99", tp);
  expect(r.url).toBe("wss://hub.example.com/ws/daemon?daemon_id=mac");
});
