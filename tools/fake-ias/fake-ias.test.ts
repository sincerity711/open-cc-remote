/**
 * Comprehensive tests for the new oidc-provider-backed fake-ias.
 * These are RED tests: they fail until tools/fake-ias/oidc-server.mjs is written
 * and fake-ias.ts is rewritten to spawn it as a Node subprocess.
 *
 * Run: bun test tools/fake-ias/fake-ias.test.ts
 */

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { startFakeIas } from "./fake-ias.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Follow 301/302/303 redirects. Stops before actually fetching a URL whose
 * string starts with `callbackPrefix` and returns that URL parsed. Used for
 * auth-code / device flows where the callback server isn't running.
 */
async function followRedirectsToCallback(
  startUrl: string,
  callbackPrefix: string,
  maxHops = 15
): Promise<URL> {
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, { redirect: "manual" });
    const loc = res.headers.get("location");
    if ((res.status === 301 || res.status === 302 || res.status === 303) && loc) {
      const next = loc.startsWith("http") ? loc : new URL(loc, current).toString();
      if (next.startsWith(callbackPrefix)) {
        return new URL(next);
      }
      current = next;
    } else if (res.ok) {
      // Non-redirect success in the middle of the chain is unexpected here
      throw new Error(
        `followRedirectsToCallback: unexpected ${res.status} at ${current} before reaching callback`
      );
    } else {
      throw new Error(
        `followRedirectsToCallback: error ${res.status} at ${current}: ${await res.text()}`
      );
    }
  }
  throw new Error(`followRedirectsToCallback: exceeded ${maxHops} hops from ${startUrl}`);
}

/**
 * Generic redirect follower — returns the first non-3xx response.
 * Throws on connection errors; used for device verification flow.
 */
async function followRedirects(startUrl: string, maxHops = 15): Promise<Response> {
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, { redirect: "manual" });
    if (res.status !== 301 && res.status !== 302 && res.status !== 303) {
      return res;
    }
    const loc = res.headers.get("location");
    if (!loc) return res;
    current = loc.startsWith("http") ? loc : new URL(loc, current).toString();
  }
  throw new Error(`followRedirects: exceeded ${maxHops} hops from ${startUrl}`);
}

/** Decode the payload portion of a JWT without verifying the signature. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`Invalid JWT: expected 3 parts, got ${parts.length}`);
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** Compute PKCE S256 code_challenge from a plain verifier string. */
function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── Shared constants ─────────────────────────────────────────────────────────

const REDIRECT_URI = "http://localhost:9876/cb";
const CLIENT_ID = "cc-remote";
const CLIENT_SECRET = "test-secret";
const DEFAULT_SUB = "i060912@sap.com";

// ─── discovery ───────────────────────────────────────────────────────────────

test("discovery: openid-configuration has required fields and issuer matches handle.url", async () => {
  const handle = await startFakeIas({ port: 0, redirectUris: [REDIRECT_URI] });
  try {
    const res = await fetch(`${handle.url}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);

    const doc = (await res.json()) as Record<string, unknown>;
    expect(typeof doc.issuer).toBe("string");
    expect(typeof doc.authorization_endpoint).toBe("string");
    expect(typeof doc.token_endpoint).toBe("string");
    expect(typeof doc.jwks_uri).toBe("string");

    // issuer must match the URL the handle reports
    expect(doc.issuer).toBe(handle.url);

    // oidc-provider must advertise the device authorization endpoint
    expect(typeof doc.device_authorization_endpoint).toBe("string");
  } finally {
    await handle.stop();
  }
});

// ─── jwks ─────────────────────────────────────────────────────────────────────

test("jwks: key has kid=fake-ias-key-1, alg=ES256, use=sig and matches handle.publicJwk", async () => {
  const handle = await startFakeIas({ port: 0, redirectUris: [REDIRECT_URI] });
  try {
    // The new implementation spawns a Node child process; verify the PID is exposed
    // so the stop() test (and callers) can do kill-0 process-liveness checks.
    expect(typeof (handle as any).pid).toBe("number");
    // Discover the jwks_uri via discovery rather than hard-coding it
    const disco = (await fetch(`${handle.url}/.well-known/openid-configuration`).then((r) =>
      r.json()
    )) as any;
    const jwksUri = disco.jwks_uri as string;
    expect(typeof jwksUri).toBe("string");

    const res = await fetch(jwksUri);
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: any[] };
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);

    const sigKey = keys.find((k: any) => k.kid === "fake-ias-key-1");
    expect(sigKey).toBeDefined();
    expect(sigKey.alg).toBe("ES256");
    expect(sigKey.use).toBe("sig");

    // Public key material must match what handle exposes
    const pub = handle.publicJwk as any;
    expect(sigKey.kty).toBe(pub.kty ?? "EC");
    expect(sigKey.x).toBe(pub.x);
    expect(sigKey.y).toBe(pub.y);
    expect(sigKey.kid).toBe(pub.kid);
  } finally {
    await handle.stop();
  }
});

// ─── authorization_code happy path ───────────────────────────────────────────

test("authorization_code: happy path yields code+state then id_token with sub/aud/iss", async () => {
  const sub = "authcode-user@example.com";
  const handle = await startFakeIas({
    port: 0,
    sub,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  try {
    const disco = (await fetch(`${handle.url}/.well-known/openid-configuration`).then((r) =>
      r.json()
    )) as any;

    // Build authorize URL
    const authUrl = new URL(disco.authorization_endpoint as string);
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", "S-happy");
    authUrl.searchParams.set("scope", "openid email");

    // Follow login → consent → redirect_uri chain; stop before fetching the callback
    const callbackUrl = await followRedirectsToCallback(authUrl.toString(), REDIRECT_URI);

    expect(callbackUrl.origin).toBe("http://localhost:9876");
    expect(callbackUrl.searchParams.get("state")).toBe("S-happy");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    // Exchange code for tokens
    const tokenRes = await fetch(disco.token_endpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(tokenRes.status).toBe(200);

    const tokens = (await tokenRes.json()) as any;
    expect(typeof tokens.id_token).toBe("string");

    const payload = decodeJwtPayload(tokens.id_token as string);
    expect(payload.sub).toBe(sub);
    expect(payload.aud).toBe(CLIENT_ID);
    expect(payload.iss).toBe(handle.url);

    // ── Sub-test B: wrong client_secret must be rejected ──────────────────
    // oidc-provider validates client_secret for confidential clients.
    // The old hand-rolled server ignores client_secret entirely → returns 200 → fails.
    const authUrl2 = new URL(disco.authorization_endpoint as string);
    authUrl2.searchParams.set("client_id", CLIENT_ID);
    authUrl2.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl2.searchParams.set("response_type", "code");
    authUrl2.searchParams.set("state", "S-wrongsecret");
    authUrl2.searchParams.set("scope", "openid email");

    const cbUrl2 = await followRedirectsToCallback(authUrl2.toString(), REDIRECT_URI);
    const code2 = cbUrl2.searchParams.get("code");
    expect(code2).toBeTruthy();

    const wrongSecretRes = await fetch(disco.token_endpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code2!,
        client_id: CLIENT_ID,
        client_secret: "definitely-wrong-secret",
        redirect_uri: REDIRECT_URI,
      }),
    });
    // Must NOT be 200 — confidential client secret must be validated
    expect(wrongSecretRes.status).not.toBe(200);
  } finally {
    await handle.stop();
  }
});

// ─── PKCE ────────────────────────────────────────────────────────────────────

test("PKCE S256: correct verifier succeeds; wrong verifier is rejected with non-200", async () => {
  const handle = await startFakeIas({
    port: 0,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  try {
    const disco = (await fetch(`${handle.url}/.well-known/openid-configuration`).then((r) =>
      r.json()
    )) as any;

    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // 44-char RFC valid verifier
    const challenge = pkceChallenge(verifier);

    // ── Sub-test A: correct verifier succeeds ──────────────────────────────
    const authUrl = new URL(disco.authorization_endpoint as string);
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", "S-pkce-ok");
    authUrl.searchParams.set("scope", "openid email");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const cbOk = await followRedirectsToCallback(authUrl.toString(), REDIRECT_URI);
    const codeOk = cbOk.searchParams.get("code");
    expect(codeOk).toBeTruthy();
    expect(cbOk.searchParams.get("state")).toBe("S-pkce-ok");

    const goodRes = await fetch(disco.token_endpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: codeOk!,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(goodRes.status).toBe(200);
    const goodTokens = (await goodRes.json()) as any;
    expect(typeof goodTokens.id_token).toBe("string");

    // ── Sub-test B: wrong verifier returns error ───────────────────────────
    // Need a fresh code (codes are single-use in oidc-provider)
    const authUrl2 = new URL(disco.authorization_endpoint as string);
    authUrl2.searchParams.set("client_id", CLIENT_ID);
    authUrl2.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl2.searchParams.set("response_type", "code");
    authUrl2.searchParams.set("state", "S-pkce-bad");
    authUrl2.searchParams.set("scope", "openid email");
    authUrl2.searchParams.set("code_challenge", challenge);
    authUrl2.searchParams.set("code_challenge_method", "S256");

    const cbBad = await followRedirectsToCallback(authUrl2.toString(), REDIRECT_URI);
    const codeBad = cbBad.searchParams.get("code");
    expect(codeBad).toBeTruthy();

    const badRes = await fetch(disco.token_endpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: codeBad!,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code_verifier: "wrong-verifier-xxxxxxxxxxxxxxxxxxxxxxxx", // definitely wrong
      }),
    });
    expect(badRes.status).not.toBe(200);
  } finally {
    await handle.stop();
  }
});

// ─── refresh_token ────────────────────────────────────────────────────────────

test("refresh_token: offline_access yields refresh_token; exchange returns new tokens", async () => {
  const handle = await startFakeIas({
    port: 0,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  try {
    const disco = (await fetch(`${handle.url}/.well-known/openid-configuration`).then((r) =>
      r.json()
    )) as any;

    const authUrl = new URL(disco.authorization_endpoint as string);
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", "S-refresh");
    authUrl.searchParams.set("scope", "openid email offline_access");

    const cbUrl = await followRedirectsToCallback(authUrl.toString(), REDIRECT_URI);
    const code = cbUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    // Initial token exchange
    const tokenRes = await fetch(disco.token_endpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as any;
    expect(typeof tokens.refresh_token).toBe("string");
    expect(typeof tokens.id_token).toBe("string");

    // Use refresh token to get new tokens
    const refreshRes = await fetch(disco.token_endpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token as string,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as any;
    expect(typeof refreshed.access_token).toBe("string");
    expect(typeof refreshed.id_token).toBe("string");
  } finally {
    await handle.stop();
  }
});

// ─── device_code ─────────────────────────────────────────────────────────────

test("device_code: initiate flow, simulate approval, poll /token for tokens", async () => {
  /**
   * IMPLEMENTER NOTE:
   * oidc-server.mjs must auto-approve device authorizations in test mode.
   * Two acceptable approaches (pick one):
   *   A) Set env var `TEST_AUTO_APPROVE_DEVICE=true` — the server auto-approves the
   *      device_code as soon as it's issued (no user interaction needed; poll returns
   *      tokens immediately or after one "authorization_pending" response).
   *   B) Expose a test-only endpoint GET /test/approve-device?user_code=<code> that
   *      marks the device code as approved.
   * This test calls the verification_uri and follows any redirect chain (option B-style)
   * then falls back to polling regardless.
   */
  const handle = await startFakeIas({
    port: 0,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  try {
    const disco = (await fetch(`${handle.url}/.well-known/openid-configuration`).then((r) =>
      r.json()
    )) as any;

    // device_authorization_endpoint may or may not appear in discovery
    const deviceAuthEndpoint =
      (disco.device_authorization_endpoint as string | undefined) ??
      `${handle.url}/device/auth`;

    // Step 1: Initiate device authorization
    const daRes = await fetch(deviceAuthEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: "openid email",
      }),
    });
    expect(daRes.status).toBe(200);
    const da = (await daRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      expires_in: number;
      interval?: number;
    };
    expect(typeof da.device_code).toBe("string");
    expect(typeof da.user_code).toBe("string");
    expect(typeof da.verification_uri).toBe("string");

    // Step 2: Simulate user navigating to verification_uri to approve
    // Follow redirect chain; the auto-approval interaction should succeed.
    // We catch errors in case the server redirects off-origin (that's fine).
    await followRedirects(da.verification_uri, 15).catch(() => {
      /* acceptable — redirect may land at an unreachable URL */
    });

    // Step 3: Poll /token — tolerate a few "authorization_pending" responses
    const tokenEndpoint = disco.token_endpoint as string;
    let pollResult: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const pollRes = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: da.device_code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });

      if (pollRes.status === 400) {
        const errBody = (await pollRes.json()) as any;
        if (
          errBody.error === "authorization_pending" ||
          errBody.error === "slow_down"
        ) {
          await Bun.sleep(300);
          continue;
        }
        throw new Error(
          `device_code poll: unexpected error at attempt ${attempt}: ${JSON.stringify(errBody)}`
        );
      }

      expect(pollRes.status).toBe(200);
      pollResult = (await pollRes.json()) as Record<string, unknown>;
      break;
    }

    expect(pollResult).not.toBeNull();
    expect(typeof pollResult!.access_token).toBe("string");
    expect(typeof pollResult!.id_token).toBe("string");
  } finally {
    await handle.stop();
  }
});

// ─── stop() ──────────────────────────────────────────────────────────────────

test("stop(): handle.stop() makes server unreachable (ECONNREFUSED or fetch throws)", async () => {
  const handle = await startFakeIas({ port: 0, redirectUris: [REDIRECT_URI] });
  const { url } = handle;

  // Confirm it's reachable before stopping
  const preRes = await fetch(`${url}/.well-known/openid-configuration`);
  expect(preRes.status).toBe(200);

  // The handle must expose a pid so callers can verify child-process death
  // (the new implementation spawns a Node child; pid comes from that subprocess)
  expect(typeof (handle as any).pid).toBe("number");

  await handle.stop();

  // After stop, any request must throw (ECONNREFUSED) or return a network error
  let threw = false;
  try {
    await fetch(`${url}/.well-known/openid-configuration`);
  } catch (err: any) {
    threw = true;
    // Tolerate various error shapes: ECONNREFUSED, "fetch failed", etc.
    const msg: string = String(err?.message ?? err?.code ?? "");
    const isConnErr =
      msg.toLowerCase().includes("connect") ||
      msg.toLowerCase().includes("econnrefused") ||
      msg.toLowerCase().includes("fetch") ||
      err?.code === "ECONNREFUSED";
    expect(isConnErr).toBe(true);
  }
  expect(threw).toBe(true);
});
