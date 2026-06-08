# Deploying the hub on SAP Cloud Foundry

Path A from the design discussion: 0 code change, ephemeral sqlite. Each platform
restart loses pairings/devices/push-subscriptions; expect to re-pair the daemon
and re-sign-in on the PWA after a restage.

Daemon and PWA stay local. Only the hub runs on CF.

## Current deployment (2026-05-26)

| | Value |
|---|---|
| App URL | https://cc-remote-hub.cfapps.sap.hana.ondemand.com |
| Image | `docker.io/sincerity711/cc-remote-hub:0.1.0` (linux/amd64) |
| CF API | `https://api.cf.sap.hana.ondemand.com` |
| Org / Space | `Story Copilot_openai-2vkczh7b / dev` |
| IAS instance | `cc-remote-identity` (plan `application`, broker `sm-identity-broker`) |
| IAS tenant | `abe1iv2rj.accounts400.ondemand.com` |
| Allowed subject | `ciro.xu@sap.com` |
| BTP cockpit | [subaccount link](https://canary.cockpit.btp.int.sap/cockpit#/globalaccount/55157a7c-3623-4ddc-9ea9-d90957d0a574/subaccount/df5a37c2-d2f9-4b2e-937a-8e5db6da615d/org/0ea06f7a-9ca6-4125-b881-7c3405bf6e17/space/ecadc45c-415d-4e63-8582-193b9006c5cb) |

### Daily ops cheatsheet

```sh
# logs (live tail)
cf logs cc-remote-hub
# logs (last 100 lines)
cf logs cc-remote-hub --recent

# restart (clears /tmp sqlite ⇒ requires re-pair + re-sign-in)
cf restart cc-remote-hub

# inspect injected env (IAS creds come from VCAP_SERVICES)
cf env cc-remote-hub

# rotate JWT secret (invalidates all daemon JWTs)
cf set-env cc-remote-hub HUB_JWT_SECRET "$(openssl rand -base64 32)"
cf restart cc-remote-hub
```

### Redeploy after code changes

```sh
# 1. ARM-Mac → amd64 build + push (IMPORTANT: linux/amd64, see "gotchas")
docker pull --platform linux/amd64 oven/bun:1   # avoids buildx IPv6 metadata fetch
docker buildx build --platform linux/amd64 --pull=false \
  -f tools/cf/Dockerfile -t docker.io/sincerity711/cc-remote-hub:0.1.0 --push .

# 2. tell CF to re-pull
cf restart cc-remote-hub
```

If you bump the tag (e.g. `0.1.1`), edit `manifest.yml` and `cf push` instead
of `cf restart`. Otherwise CF caches by tag and won't notice the new image.

### Local daemon + browser

```sh
# pair daemon (run after every CF restart — see Path A tradeoff)
cd packages/daemon
bun run src/cli.ts init --hub https://cc-remote-hub.cfapps.sap.hana.ondemand.com
# get a pair code from the PWA Settings, then:
bun run src/cli.ts pair <code>
bun run src/cli.ts run

# browser
open https://cc-remote-hub.cfapps.sap.hana.ondemand.com/
```

### Gotchas hit during initial deploy

1. **`exec format error`** on first start — built image was ARM64 (Mac), CF cell
   needs amd64. Fixed by `docker buildx build --platform linux/amd64 --push`.
2. **`buildx` IPv6 reset** when fetching `oven/bun:1` metadata — IPv6 path to
   `auth.docker.io` was unreliable on the corp net. Fixed by pre-pulling with
   `docker pull --platform linux/amd64 oven/bun:1` (uses IPv4 path) before
   running buildx with `--pull=false`.
3. **`Cannot find module '@cc-remote/proto'`** during `tsc -b` in builder — the
   PWA's tsconfig extends `../../tsconfig.base.json`. Initial Dockerfile didn't
   `COPY tsconfig.base.json ./` and tsc silently fell back to default
   moduleResolution. Fixed in the Dockerfile.

---

## 1. Prerequisites

- A CF org/space on SAP BTP with entitlements for **Identity Authentication
  Service** (the "identity" service) and at least one route in
  `*.cfapps.<region>.hana.ondemand.com`.
- A docker registry you can `docker push` to and CF can pull from
  (Docker Hub, GHCR, SAP Artifactory, ...).
- `cf` CLI v8+, `docker` running locally.

## 2. Build & push the image

```sh
# from repo root
docker build -f tools/cf/Dockerfile -t <registry>/cc-remote-hub:latest .
docker push <registry>/cc-remote-hub:latest
```

The build does two stages: PWA bundle (`vite build`) → hub runtime (bun + jose
+ web-push) with the PWA dist baked in at `/app/pwa-dist`. If you build behind
a corporate proxy, pass it through:

```sh
docker build \
  --build-arg HTTP_PROXY=$HTTP_PROXY --build-arg HTTPS_PROXY=$HTTPS_PROXY \
  -f tools/cf/Dockerfile -t <registry>/cc-remote-hub:latest .
```

Edit `manifest.yml` and replace `REPLACE_ME/cc-remote-hub:latest` with the
pushed image tag.

## 3. Create the IAS service instance

```sh
cf create-service identity application cc-remote-identity \
  -c '{"display-name": "cc-remote", "oauth2-configuration": {"redirect-uris": ["https://<app-route>/auth/callback"]}}'
```

`<app-route>` is whatever you'll set under `routes:` in `manifest.yml` (or what
CF assigns by default: `cc-remote-hub.cfapps.<region>.hana.ondemand.com`).

If the redirect URI changes later:

```sh
cf update-service cc-remote-identity \
  -c '{"oauth2-configuration": {"redirect-uris": ["https://<new-route>/auth/callback"]}}'
```

## 4. Set deploy-time secrets

```sh
cf push --no-start          # creates the app from manifest, does not start it
cf set-env cc-remote-hub HUB_JWT_SECRET "$(openssl rand -base64 32)"
# Optional Web Push:
# cf set-env cc-remote-hub HUB_VAPID_PUBLIC_KEY ...
# cf set-env cc-remote-hub HUB_VAPID_PRIVATE_KEY ...
# cf set-env cc-remote-hub HUB_VAPID_SUBJECT mailto:you@example.com
cf start cc-remote-hub
```

Verify:

```sh
curl https://<app-route>/healthz   # → "ok"
```

## 5. Run daemon locally

```sh
# In packages/daemon
bun run src/cli.ts init --hub https://<app-route>
# Open the PWA, sign in via IAS, generate a pair code from Settings, then:
bun run src/cli.ts pair <code>
bun run src/cli.ts run
```

(Hub URL must use `https://` for CF — Gorouter will upgrade WS to WSS for you.)

### Why systemd-installed daemons need the `install` step

`cc-remote init` resolves `claude` via a login shell (bash → zsh → sh) and
bakes the absolute path into `spawn_command`, and `cc-remote install` captures
the user's interactive `PATH` and writes `Environment=PATH=…` into the
systemd unit (or the launchd plist's `EnvironmentVariables`). This matters
because systemd user services and launchd agents do **not** source `~/.bashrc`
/ `~/.zshrc` — without these two steps, a daemon started by systemd will fail
to find `claude` (or `tmux`, `git`, anything in `~/.local/bin` / `~/.bun/bin`)
the first time the PWA triggers a session, and tmux dies silently.

If you're upgrading an older config and seeing PWA-spawned sessions die
immediately, either re-run `cc-remote init --force` or hand-edit
`spawn_command` in `~/.cc-remote/config.json` to use the absolute claude path.

## 6. Open the PWA

The PWA is bundled into the hub image and served at the app root. Just visit:

```
https://<app-route>/
```

Sign in via IAS, then in Settings → Daemons issue a pair code and run the
daemon command from step 5 with the new code.

If you want to run the PWA locally instead (e.g. iterating on UI), build it
pointed at the CF hub and serve the dist:

```sh
# In packages/pwa
VITE_HUB_URL=wss://<app-route> bun run dev
```

The hub trusts whichever origin loads the PWA — there's no CORS allow-list to
update.

## What lives where

| | Process | Persistence |
|---|---|---|
| Hub + PWA | CF app `cc-remote-hub` (single image) | sqlite at `/tmp/hub.sqlite`, **lost on every restart** |
| Daemon | Your laptop, `bun run packages/daemon/src/cli.ts run` | `~/.cc-remote/config.json` (durable) |
| PWA (browser side) | Whatever browser loaded `https://<app-route>/` | localStorage in browser |

## Recovering from a hub restart

After CF restarts the app (deploy, scaling, platform maintenance):

1. PWA: refresh — bearer in localStorage is invalid, you'll see the sign-in
   screen, re-authenticate via IAS (no password prompt if your IAS session is
   alive).
2. Daemon: it'll reconnect-loop with the old JWT. Re-pair:
   `bun run packages/daemon/src/cli.ts pair <new-code-from-PWA>`.
3. Push: PWA's service worker re-registers automatically on first visit; you'll
   need to re-toggle topic preferences in Settings.

If this happens often enough to be painful, switch to a real DB
(`docs/TODO.md` Backlog #2 / Path C from the design discussion).

## Tearing down

```sh
cf delete cc-remote-hub -f
cf delete-service cc-remote-identity -f
```
