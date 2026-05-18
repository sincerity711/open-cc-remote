import { test, expect } from "bun:test";
import { startFakeIas } from "./fake-ias.ts";

test("discovery doc contains expected endpoints", async () => {
  const ias = await startFakeIas({ port: 0 });
  try {
    const res = await fetch(`${ias.url}/.well-known/openid-configuration`);
    const doc = await res.json() as any;
    expect(doc.issuer).toBe(ias.url);
    expect(doc.authorization_endpoint).toBe(`${ias.url}/authorize`);
    expect(doc.token_endpoint).toBe(`${ias.url}/token`);
    expect(doc.jwks_uri).toBe(`${ias.url}/jwks.json`);
  } finally { ias.stop(); }
});

test("jwks endpoint exposes the signing key", async () => {
  const ias = await startFakeIas({ port: 0 });
  try {
    const res = await fetch(`${ias.url}/jwks.json`);
    const doc = await res.json() as any;
    expect(Array.isArray(doc.keys)).toBe(true);
    expect(doc.keys[0].kty).toBeTruthy();
    expect(doc.keys[0].kid).toBe("fake-ias-key-1");
  } finally { ias.stop(); }
});

test("authorize redirects with code and state preserved", async () => {
  const ias = await startFakeIas({ port: 0 });
  try {
    const params = new URLSearchParams({
      client_id: "test-client",
      redirect_uri: "http://localhost:9999/cb",
      response_type: "code",
      state: "S123",
      scope: "openid",
    });
    const res = await fetch(`${ias.url}/authorize?${params}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("http://localhost:9999");
    expect(loc.pathname).toBe("/cb");
    expect(loc.searchParams.get("state")).toBe("S123");
    expect(loc.searchParams.get("code")).toBeTruthy();
  } finally { ias.stop(); }
});

test("token exchange returns id_token with the configured subject", async () => {
  const ias = await startFakeIas({ port: 0, sub: "custom@example.com" });
  try {
    const authParams = new URLSearchParams({
      client_id: "test-client",
      redirect_uri: "http://localhost:9999/cb",
      response_type: "code",
      state: "S",
      scope: "openid",
    });
    const authRes = await fetch(`${ias.url}/authorize?${authParams}`, { redirect: "manual" });
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "http://localhost:9999/cb",
    });
    const tokenRes = await fetch(`${ias.url}/token`, { method: "POST", body });
    expect(tokenRes.status).toBe(200);
    const json = await tokenRes.json() as any;
    expect(json.id_token).toBeTruthy();

    const [, payloadB64] = (json.id_token as string).split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString());
    expect(payload.sub).toBe("custom@example.com");
    expect(payload.aud).toBe("test-client");
    expect(payload.iss).toBe(ias.url);
  } finally { ias.stop(); }
});
