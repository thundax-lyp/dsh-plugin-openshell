# Build from the repository root with docker compose -f deploy/compose.yaml build runtime.
# Override NODE_IMAGE only with a trusted,
# Node.js 24 glibc-based image when using a registry mirror.
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /opt/dsh-runtime
COPY src/runtime/package.json src/runtime/package-lock.json ./
RUN node -e "if (process.versions.node.split('.')[0] !== '24') process.exit(1)" \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node --input-type=module -e "import { accessSync, constants } from 'node:fs'; import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'; accessSync(launcherPath(), constants.X_OK)"

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="dsh-sandbox-openshell-runtime" \
      org.opencontainers.image.description="OpenShell sandbox helper with DSH 0.2.1-rc.4" \
      org.opencontainers.image.version="0.2.1-rc.4"
USER root
RUN mkdir -p /opt/dsh-runtime /sandbox/project \
    && chown -R node:node /sandbox
COPY --from=dependencies --chown=0:0 /opt/dsh-runtime/ /opt/dsh-runtime/
COPY --chown=0:0 src/runtime/confine.mjs src/runtime/fs.mjs /opt/dsh-runtime/
RUN chmod -R a-w /opt/dsh-runtime
USER node
WORKDIR /sandbox/project
ENTRYPOINT []
CMD ["sleep", "infinity"]
