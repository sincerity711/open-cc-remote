# Hub image — minimal: copy proto (workspace dep used as relative source) + hub.
FROM oven/bun:1

WORKDIR /app

# Hub package.json with workspace reference replaced by file: path.
RUN echo '{"name":"hub-img","version":"0.0.1","private":true,"type":"module","dependencies":{"jose":"^5.6.0","web-push":"^3.6.0"}}' > package.json && \
    bun install

# Copy source. Proto is referenced from hub/src/index.ts via "@cc-remote/proto" — we
# satisfy that import by symlinking it into node_modules.
COPY packages/proto ./packages/proto
COPY packages/hub ./packages/hub

RUN mkdir -p node_modules/@cc-remote && ln -s /app/packages/proto node_modules/@cc-remote/proto

RUN mkdir -p /data

EXPOSE 7745

CMD ["bun", "run", "/app/packages/hub/src/index.ts"]
