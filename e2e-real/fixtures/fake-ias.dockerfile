# fake-ias image — Node ESM, runs oidc-server.mjs directly.
FROM node:22-alpine

WORKDIR /app

# Standalone package.json so we don't drag in the workspace.
RUN echo '{"name":"fake-ias-img","version":"0.0.1","private":true,"type":"module","dependencies":{"jose":"^5.6.0","oidc-provider":"^9.8.3"}}' > package.json && \
    npm install

COPY tools/fake-ias/oidc-server.mjs ./tools/fake-ias/oidc-server.mjs

EXPOSE 7770

ENV FAKE_IAS_PORT=7770

CMD ["node", "/app/tools/fake-ias/oidc-server.mjs"]
