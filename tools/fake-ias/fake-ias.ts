#!/usr/bin/env bun
// Test-only OIDC mock for cc-remote hub.
// Signs id_tokens with an ephemeral ES256 keypair generated at startup.
// Codes are JWTs (no per-code state); subjects fixed via opts.sub.

import { generateKeyPair, exportJWK, SignJWT, jwtVerify } from "jose";

export interface FakeIasOptions {
  port?: number;       // 0 = ephemeral
  sub?: string;        // default "i060912@sap.com"
}

export interface FakeIasHandle {
  url: string;
  port: number;
  publicJwk: Record<string, unknown>;
  stop(): void;
}

export async function startFakeIas(opts: FakeIasOptions = {}): Promise<FakeIasHandle> {
  const sub = opts.sub ?? "i060912@sap.com";
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const pubJwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  pubJwk.kid = "fake-ias-key-1";
  pubJwk.alg = "ES256";
  pubJwk.use = "sig";

  let issuerUrl = "";

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!issuerUrl) issuerUrl = url.origin;

      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: issuerUrl,
          authorization_endpoint: `${issuerUrl}/authorize`,
          token_endpoint: `${issuerUrl}/token`,
          jwks_uri: `${issuerUrl}/jwks.json`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }

      if (url.pathname === "/jwks.json") {
        return Response.json({ keys: [pubJwk] });
      }

      if (url.pathname === "/authorize") {
        const p = url.searchParams;
        const redirect_uri = p.get("redirect_uri");
        const state = p.get("state");
        const client_id = p.get("client_id");
        if (!redirect_uri || !state || !client_id) {
          return new Response("missing params", { status: 400 });
        }
        const code = await new SignJWT({ sub, client_id })
          .setProtectedHeader({ alg: "ES256", kid: "fake-ias-key-1" })
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        const target = new URL(redirect_uri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        return Response.redirect(target.toString(), 302);
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const form = await req.formData();
        const code = form.get("code") as string | null;
        const client_id = form.get("client_id") as string | null;
        if (!code || !client_id) return new Response("missing code/client_id", { status: 400 });

        let payload: { sub?: string; client_id?: string };
        try {
          const v = await jwtVerify(code, publicKey);
          payload = v.payload as typeof payload;
        } catch {
          return new Response("invalid code", { status: 400 });
        }
        if (payload.client_id !== client_id) {
          return new Response("client_id mismatch", { status: 400 });
        }
        const id_token = await new SignJWT({})
          .setProtectedHeader({ alg: "ES256", kid: "fake-ias-key-1" })
          .setIssuer(issuerUrl)
          .setSubject(payload.sub!)
          .setAudience(client_id)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey);
        return Response.json({
          id_token,
          access_token: id_token,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port!}`,
    port: server.port!,
    publicJwk: pubJwk,
    stop() { server.stop(true); },
  };
}

if (import.meta.main) {
  const handle = await startFakeIas({
    port: Number(process.env.FAKE_IAS_PORT ?? 7770),
    sub: process.env.FAKE_IAS_SUB,
  });
  console.log(`fake-ias listening at ${handle.url}`);
}
