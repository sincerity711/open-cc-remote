# Hub image for SAP Cloud Foundry (or any docker host).
# Build context must be the repo root: `docker build -f tools/cf/Dockerfile .`
#
# Two-stage build:
#   1. pwa-builder — installs PWA deps + runs vite build to produce dist/
#   2. final — bun runtime hosting the hub, with PWA dist copied in and
#      served via HUB_STATIC_DIR (SPA fallback in routes.ts).

FROM oven/bun:1 AS pwa-builder
WORKDIR /repo
# Synthetic workspace root — narrower than the real one so bun install only
# resolves what the PWA needs (no daemon/hub/plugin/e2e-real graph).
RUN echo '{"name":"pwa-build","private":true,"workspaces":["packages/proto","packages/observability","packages/pwa"]}' > package.json
# tsconfig.base.json is referenced by every package's tsconfig via `extends`.
COPY tsconfig.base.json ./
COPY packages/proto packages/proto
COPY packages/observability packages/observability
COPY packages/pwa packages/pwa
RUN bun install --no-summary
RUN bun run --cwd packages/pwa build

FROM oven/bun:1
WORKDIR /app

# Synthetic workspace narrowed to just the hub graph (proto + observability +
# hub) so bun install resolves @cc-remote/* via workspace and pulls every
# transitive @opentelemetry runtime dep without needing the daemon/plugin/PWA
# subtrees.
RUN echo '{"name":"hub-img","private":true,"type":"module","workspaces":["packages/proto","packages/observability","packages/hub"]}' > package.json
COPY tsconfig.base.json ./
COPY packages/proto packages/proto
COPY packages/observability packages/observability
COPY packages/hub packages/hub
COPY tools/cf/entrypoint.ts ./tools/cf/entrypoint.ts
RUN bun install --no-summary

# PWA dist served by the hub at the app root.
COPY --from=pwa-builder /repo/packages/pwa/dist /app/pwa-dist
ENV HUB_STATIC_DIR=/app/pwa-dist

# CF assigns $PORT at runtime; no need to EXPOSE.
CMD ["bun", "run", "/app/tools/cf/entrypoint.ts"]
