# fake-ias image — minimal: a single script + jose.
FROM oven/bun:1

WORKDIR /app

# Standalone package.json so we don't drag in the workspace.
RUN echo '{"name":"fake-ias-img","version":"0.0.1","private":true,"type":"module","dependencies":{"jose":"^5.6.0"}}' > package.json && \
    bun install

COPY tools/fake-ias ./tools/fake-ias

EXPOSE 7770

ENV FAKE_IAS_PORT=7770

CMD ["bun", "run", "/app/tools/fake-ias/fake-ias.ts"]
