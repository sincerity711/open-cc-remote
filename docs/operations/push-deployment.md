# Push deployment

The hub uses Web Push (VAPID). On Android Chrome and on iOS 16.4+ when the PWA is installed to the home screen, browsers honour Web Push by bridging to FCM or APNs respectively — the hub does not need a native SDK.

## Generate VAPID keys

```
npx web-push generate-vapid-keys
```

Output is two base64url strings (public + private). Treat the private key as a secret.

## Configure the hub

Set three environment variables on the hub container/process:

```
HUB_VAPID_PUBLIC_KEY=<public_key>
HUB_VAPID_PRIVATE_KEY=<private_key>
HUB_VAPID_SUBJECT=mailto:ops@your-domain.example
```

If any one is missing the hub logs a warning and Web Push is disabled.

## Configure the PWA build

The PWA reads the public key at build time:

```
VITE_VAPID_PUBLIC_KEY=<public_key>
```

If the variable is unset, `registerPushSubscription` returns `{ registered: false, reason: "VITE_VAPID_PUBLIC_KEY not configured" }` and the PWA shows a notice; nothing else is affected.

## TLS and origin

Web Push is served over HTTPS only (browser hard requirement). The PWA must be served from the same HTTPS origin used during sign-in and WebSocket connection, or you will hit secure-cookie / CORS issues. Localhost is exempt during development.

## iOS installed-PWA caveat

iOS only delivers Web Push to PWAs that the user has explicitly added to the home screen and launched from that icon. Visiting the site in Safari does not subscribe.

## Verification

1. Open the PWA on a real Android Chrome device (or iOS 16.4+, **installed**).
2. Sign in, open Settings, allow notifications when prompted.
3. From a daemon: trigger a permission request — the device should show the notification immediately.
4. Disconnect the daemon and wait ~30s — `offline` notification should arrive if subscribed.
5. On the hub, tail logs for `web-push send to … failed:` lines; 410/404 responses indicate stale subscriptions and are expected over time.
