ARG III_VERSION=0.11.2

FROM iiidev/iii:${III_VERSION} AS iii-image

FROM node:24-slim

ARG AGENTMEMORY_VERSION=0.9.26
ARG III_VERSION=0.11.2
ARG III_SDK_VERSION=0.11.2

# Custom CA certificates (e.g. corporate proxy) — injected before apt so HTTPS repos are trusted
COPY certificates/*.crt /usr/local/share/ca-certificates/
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini curl \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=iii-image /app/iii /usr/local/bin/iii

# Install agentmemory into a dedicated prefix so the local package.json's
# `overrides` field pins iii-sdk to match the engine version.
WORKDIR /opt/agentmemory
RUN printf '{"name":"agentmemory-deploy","version":"1.0.0","private":true,"overrides":{"iii-sdk":"%s"}}\n' "${III_SDK_VERSION}" > package.json \
  && npm install "@agentmemory/agentmemory@${AGENTMEMORY_VERSION}" --omit=optional --no-fund --no-audit \
  && npm install @xenova/transformers --no-fund --no-audit \
  && ln -s /opt/agentmemory/node_modules/.bin/agentmemory /usr/local/bin/agentmemory

# Copy the deploy-tuned iii config (binds 0.0.0.0, absolute /data paths)
COPY iii-config.yaml /opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml

# Create runtime directories and set ownership to node user
RUN mkdir -p /data /secrets \
  && chown -R node:node /data /secrets \
  && chown node:node /opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

COPY --chmod=0755 entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

# Switch to unprivileged user for runtime
USER node

EXPOSE 3111 3113

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
