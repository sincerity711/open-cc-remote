# Reverse proxy in front of the hub

The hub runs three protocols whose authentication is done **inside** the hub
process, not by HTTP middleware:

| Path | Auth | Notes |
|---|---|---|
| `POST /pair` | pair code (one-shot, ≤5 min TTL) issued from a signed-in PWA | bootstraps a new daemon |
| `POST /pair/refresh` | DPoP-bound JWT + EdDSA proof-of-possession | rotates the daemon's JWT |
| `GET /ws/daemon` | DPoP-bound JWT + EdDSA proof-of-possession | the long-lived daemon socket |

If you wrap any of these paths in an **OIDC-aware reverse proxy** (oauth2-proxy
in front of nginx, Caddy `forward_auth`, an Envoy ext_authz filter, etc.) the
proxy will reject the daemon — daemons hold a hub-issued JWT, not an OIDC
session cookie. **Daemons must reach these endpoints unwrapped.**

The PWA endpoints (`/auth/*`, `/devices`, `/daemons`, `/push/*`, `/pair/issue`,
`/ws/pwa`, static assets) authenticate via a bearer derived from the PWA's
OIDC session — those are safe to wrap.

## Trusted-proxy configuration

When the hub sits behind a TLS-terminating reverse proxy, set
`HUB_TRUSTED_PROXIES` to a comma-separated list of CIDRs the proxy connects
from. With this set, the hub:

- Reads `X-Forwarded-For[0]` as the client IP (used for rate limiting on
  `/pair`, `/pair/refresh`, `/ws/daemon`).
- Reconstructs the public URL from `X-Forwarded-Proto` + `X-Forwarded-Host`
  for DPoP `htu` matching, so daemons can sign against `wss://hub.example.com`
  even though the hub sees the connection as `http://internal:7745`.

`HUB_TRUSTED_PROXIES` defaults to **empty** (no trust). When empty, XFF/XFP
are ignored and the rate limiter falls back to the socket peer address — the
2026-05-27 behavior is unchanged.

```bash
# Single ingress
HUB_TRUSTED_PROXIES=10.0.0.0/8

# Cloud Foundry gorouter (route emulator)
HUB_TRUSTED_PROXIES=10.244.0.0/16

# Loopback for local TLS terminator
HUB_TRUSTED_PROXIES=127.0.0.1,::1
```

## Rate limits

Defaults (per-minute, per-client-IP):

| Variable | Default | Path |
|---|---|---|
| `HUB_RATELIMIT_PAIR_PER_MIN` | 10 | `POST /pair` |
| `HUB_RATELIMIT_PAIR_REFRESH_PER_MIN` | 30 | `POST /pair/refresh` |
| `HUB_RATELIMIT_WS_DAEMON_PER_MIN` | 30 | `GET /ws/daemon` |

Set any of these to `0` to disable rate limiting on that path (useful for
behind-NAT staging where every client appears to share an IP).

## Example: nginx + oauth2-proxy

```nginx
# Wrap PWA paths only. Daemon paths and the hub's own auth endpoints are
# NOT touched.
upstream hub_backend {
  server 127.0.0.1:7745;
}

server {
  listen 443 ssl http2;
  server_name hub.example.com;

  # PASS-THROUGH for daemon-auth paths — DO NOT proxy through oauth2-proxy.
  location = /pair             { proxy_pass http://hub_backend; include /etc/nginx/proxy.conf; }
  location = /pair/refresh     { proxy_pass http://hub_backend; include /etc/nginx/proxy.conf; }
  location = /ws/daemon        { proxy_pass http://hub_backend; include /etc/nginx/proxy.conf; }
  location /healthz            { proxy_pass http://hub_backend; }

  # PWA paths — wrapped by oauth2-proxy via auth_request.
  location /oauth2/ { proxy_pass http://127.0.0.1:4180; }
  location /        {
    auth_request /oauth2/auth;
    error_page 401 = @oauth_signin;
    proxy_pass http://hub_backend;
    include /etc/nginx/proxy.conf;
  }
  location @oauth_signin {
    return 302 /oauth2/start?rd=$scheme://$host$request_uri;
  }
}
```

`/etc/nginx/proxy.conf` should contain the `X-Forwarded-*` header dance
required for the hub's `HUB_TRUSTED_PROXIES` reconstruction:

```nginx
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        $http_connection;
```

The combination — pass-through `location =` blocks for the daemon paths plus
`HUB_TRUSTED_PROXIES=<nginx CIDR>` — is the contract: nginx terminates TLS,
forwards the protocol/host hint, and the hub trusts those headers because
the connection arrived from a known proxy.

## What about Caddy `forward_auth`?

Same shape, different syntax:

```caddy
hub.example.com {
  # Daemon paths — pass through unauthenticated.
  @daemon path /pair /pair/refresh /ws/daemon /healthz
  reverse_proxy @daemon 127.0.0.1:7745

  # PWA paths — wrapped by forward_auth.
  forward_auth 127.0.0.1:4180 {
    uri /oauth2/auth
    copy_headers X-Auth-Request-User X-Auth-Request-Email
  }
  reverse_proxy 127.0.0.1:7745
}
```
