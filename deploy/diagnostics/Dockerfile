# Test-only diagnostics layered on the exact production image built at root.
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
USER root
RUN install -d -m 0755 -o node -g node /opt/dsh-permission-outer
COPY probes /opt/dsh-runtime/probes
COPY diagnostics.mjs /opt/dsh-runtime/diagnostics.mjs
USER node
