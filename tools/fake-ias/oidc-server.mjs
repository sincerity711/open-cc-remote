/**
 * Fake IAS OIDC server — pure Node ESM, spawned as a child process by fake-ias.ts.
 *
 * Interaction handling: uses provider.use() Koa middleware to auto-complete login/consent
 * without cookie round-trips, so plain fetch() without cookie persistence works.
 *
 * Device auto-approval: option A — listen to `device_authorization.success` event and
 * immediately approve the device_code in-process (no user-facing endpoint needed).
 */

import { createServer } from 'node:http';
import { generateKeyPair, exportJWK } from 'jose';
import { Provider } from 'oidc-provider';

const PORT = parseInt(process.env.FAKE_IAS_PORT ?? '0', 10);
const SUB = process.env.FAKE_IAS_SUB ?? 'i060912@sap.com';
const CLIENT_ID = process.env.FAKE_IAS_CLIENT_ID ?? 'cc-remote';
const CLIENT_SECRET = process.env.FAKE_IAS_CLIENT_SECRET ?? 'test-secret';
const REDIRECT_URIS = (process.env.FAKE_IAS_REDIRECT_URIS ?? 'http://localhost:9999/cb').split(',');

// Generate ES256 keypair; stable kid so JWT headers are predictable.
const { privateKey } = await generateKeyPair('ES256');
const privJwk = await exportJWK(privateKey);
privJwk.kid = 'fake-ias-key-1';
privJwk.alg = 'ES256';
privJwk.use = 'sig';

// Public JWK strips private key fields.
const { d, dp, dq, p, q, qi, ...publicJwk } = privJwk;

// Create an HTTP server first so we can get the actual ephemeral port before
// constructing the Provider (the issuer URL must contain the real port).
const server = createServer();
await new Promise((resolve) => server.listen(PORT, resolve));
const actualPort = server.address().port;
const issuer = process.env.FAKE_IAS_ISSUER ?? `http://localhost:${actualPort}`;

const provider = new Provider(issuer, {
  jwks: { keys: [privJwk] },

  clients: [
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: REDIRECT_URIS,
      grant_types: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      id_token_signed_response_alg: 'ES256',
    },
  ],

  routes: {
    authorization: '/authorize',
    jwks: '/jwks.json',
  },

  features: {
    devInteractions: { enabled: false },
    deviceFlow: { enabled: true },
    revocation: { enabled: true },
  },

  pkce: { required: () => false },

  scopes: ['openid', 'email', 'profile', 'offline_access'],

  findAccount(_ctx, id) {
    return {
      accountId: id,
      claims: async () => ({ sub: id, email: id, name: id }),
    };
  },

  // oidc-provider strips offline_access when prompt=consent is absent (strict OIDC).
  // For a fake server, always issue refresh tokens when the grant type is allowed.
  issueRefreshToken(_ctx, client) {
    return client.grantTypeAllowed('refresh_token');
  },
});

// ── Koa middleware: auto-complete interactions without cookie round-trips ──────
//
// Problem: the test's followRedirectsToCallback() uses fetch() without cookie
// persistence, so oidc-provider's cookie-based interaction/resume mechanism breaks.
//
// Solution:
//   1. Intercept GET /interaction/:uid — look up the Interaction directly by UID
//      (from the URL path, no cookie), process login/consent, redirect to returnTo.
//   2. Intercept GET /authorize/:uid (resume path) — inject _interaction_resume
//      cookie from the URL UID before the resume handler runs.
//
// No cookies.keys configured → cookies are unsigned → we can inject them safely.

const RESUME_COOKIE = provider.cookieName('resume');
const AUTHORIZATION_ROUTE = '/authorize'; // matches routes.authorization

provider.use(async (ctx, next) => {
  const { method, path } = ctx;

  // ── Auto-complete interaction (login or consent) ─────────────────────────
  if (method === 'GET' && path.startsWith('/interaction/')) {
    const uid = path.split('/')[2];
    const interaction = await provider.Interaction.find(uid).catch(() => null);

    if (interaction) {
      const { prompt, session, params } = interaction;
      const now = Math.floor(Date.now() / 1000);
      const ttl = interaction.exp - now;

      if (prompt.name === 'login') {
        interaction.result = { login: { accountId: SUB } };
        await interaction.save(ttl > 0 ? ttl : 300);
        ctx.status = 303;
        ctx.set('Location', interaction.returnTo);
        return; // do not call next()
      }

      if (prompt.name === 'consent') {
        let grant;
        if (interaction.grantId) {
          grant = await provider.Grant.find(interaction.grantId).catch(() => null);
        }
        if (!grant) {
          grant = new provider.Grant({
            accountId: session?.accountId ?? SUB,
            clientId: params.client_id,
          });
        }

        const { missingOIDCScope, missingOIDCClaims, missingResourceScopes } = prompt.details;
        if (missingOIDCScope) grant.addOIDCScope(missingOIDCScope.join(' '));
        if (missingOIDCClaims) grant.addOIDCClaims(missingOIDCClaims);
        if (missingResourceScopes) {
          for (const [indicator, scope] of Object.entries(missingResourceScopes)) {
            grant.addResourceScope(indicator, scope.join(' '));
          }
        }

        const grantId = await grant.save();
        interaction.result = { ...(interaction.lastSubmission ?? {}), consent: { grantId } };
        await interaction.save(ttl > 0 ? ttl : 300);
        ctx.status = 303;
        ctx.set('Location', interaction.returnTo);
        return;
      }
    }
    // Fallthrough to oidc-provider for unknown prompt or missing interaction.
  }

  // ── Inject cookies for cookie-less redirect chains ───────────────────────
  // The resume handler reads _interaction_resume and _session from the Cookie header.
  // When fetch() doesn't persist cookies, reconstruct both from the URL UID:
  //   - _interaction_resume  = the UID itself (set by oidc-provider during /authorize)
  //   - _session             = the session.jti stored in the interaction, so the
  //                            resume handler's session-mismatch check passes.
  if (method === 'GET' && path.startsWith(`${AUTHORIZATION_ROUTE}/`)) {
    const uid = path.slice(AUTHORIZATION_ROUTE.length + 1).split('?')[0];
    if (uid) {
      const existing = ctx.req.headers.cookie ?? '';
      const additions = [];

      if (!existing.includes(`${RESUME_COOKIE}=`)) {
        additions.push(`${RESUME_COOKIE}=${uid}`);
      }

      const SESSION_COOKIE = provider.cookieName('session');
      if (!existing.includes(`${SESSION_COOKIE}=`)) {
        const interaction = await provider.Interaction.find(uid).catch(() => null);
        if (interaction?.session?.uid) {
          const sess = await provider.Session.findByUid(interaction.session.uid).catch(() => null);
          if (sess?.jti) {
            additions.push(`${SESSION_COOKIE}=${sess.jti}`);
          }
        }
      }

      if (additions.length > 0) {
        ctx.req.headers.cookie = existing
          ? `${existing}; ${additions.join('; ')}`
          : additions.join('; ');
      }
    }
  }

  return next();
});

// ── Device flow: auto-approve codes immediately after issuance (option A) ────
provider.on('device_authorization.success', (_ctx, body) => {
  const deviceCode = body.device_code;
  // Small delay so the adapter write completes before we try to read it back.
  setTimeout(async () => {
    try {
      const code = await provider.DeviceCode.find(deviceCode);
      if (!code || code.accountId) return;

      const grant = new provider.Grant({
        accountId: SUB,
        clientId: code.clientId,
      });
      const scopeStr = (code.params && code.params.scope) ? code.params.scope : 'openid';
      grant.addOIDCScope(scopeStr);
      const grantId = await grant.save();

      Object.assign(code, {
        accountId: SUB,
        grantId,
        scope: scopeStr,
      });
      await code.save();
    } catch (err) {
      process.stderr.write(`device auto-approve error: ${err.message}\n`);
    }
  }, 50);
});

const providerCallback = provider.callback();

server.on('request', async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    // Device authorization endpoint: RFC 8628 clients often omit client_secret here
    // even for confidential clients. Buffer the body, inject the secret if missing,
    // then let oidc-provider's req.body fallback pick it up.
    if (req.method === 'POST' && pathname === '/device/auth') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const params = new URLSearchParams(body);
      if (!params.has('client_secret') && params.get('client_id') === CLIENT_ID) {
        params.set('client_secret', CLIENT_SECRET);
      }
      // req is now consumed (req.readable === false); oidc-provider falls back to req.body.
      req.body = Object.fromEntries(params.entries());
    }

    return providerCallback(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Server error: ${err.message}`);
    }
  }
});

// Signal that the server is ready; the Bun wrapper reads this line to resolve startFakeIas().
process.stdout.write(`READY ${JSON.stringify({ port: actualPort, issuer, publicJwk })}\n`);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
