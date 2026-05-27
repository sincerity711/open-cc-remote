# Hub image — minimal: copy proto (workspace dep used as relative source) + hub.
FROM oven/bun:1

WORKDIR /app

# Hub package.json with workspace reference replaced by file: path. Pull in
# OTel SDK deps so @cc-remote/observability can lazily load them when
# OTEL_EXPORTER_OTLP_ENDPOINT is set; these are no-ops otherwise.
RUN echo '{"name":"hub-img","version":"0.0.1","private":true,"type":"module","dependencies":{"jose":"^5.6.0","web-push":"^3.6.0","@opentelemetry/api":"^1.9.0","@opentelemetry/api-logs":"^0.55.0","@opentelemetry/core":"^1.28.0","@opentelemetry/exporter-trace-otlp-http":"^0.55.0","@opentelemetry/exporter-logs-otlp-http":"^0.55.0","@opentelemetry/resources":"^1.28.0","@opentelemetry/sdk-logs":"^0.55.0","@opentelemetry/sdk-trace-base":"^1.28.0","@opentelemetry/sdk-trace-node":"^1.28.0","@opentelemetry/semantic-conventions":"^1.28.0"}}' > package.json && \
    bun install

# Copy source. Proto + observability are referenced via "@cc-remote/..." imports;
# satisfy them by symlinking into node_modules.
COPY packages/proto ./packages/proto
COPY packages/observability ./packages/observability
COPY packages/hub ./packages/hub

RUN mkdir -p node_modules/@cc-remote && \
    ln -s /app/packages/proto node_modules/@cc-remote/proto && \
    ln -s /app/packages/observability node_modules/@cc-remote/observability

RUN mkdir -p /data

EXPOSE 7745

CMD ["bun", "run", "/app/packages/hub/src/index.ts"]
