FROM node:22.21.0-bookworm-slim AS node-skill-builder

WORKDIR /build
COPY scripts/build-node-skill.mjs ./scripts/
COPY skills/codey-node-onboarding ./skills/codey-node-onboarding/
RUN node scripts/build-node-skill.mjs

FROM node:22.21.0-bookworm-slim

ENV NODE_ENV=production \
    PORTAL_HOST=0.0.0.0 \
    PORTAL_PORT=8080 \
    PORTAL_NAME=Codey \
    PORTAL_READ_ONLY=true \
    PORTAL_CLIENT_ONLY=true \
    PORTAL_SESSION_HISTORY_HTTP_ONLY=true \
    PORTAL_MCP_PROXY_URL=http://127.0.0.1:8000 \
    PORTAL_CONFIG=/app/config/nodes.aca.json \
    PORTAL_CLOUDCLI_CONFIG=/app/config/cloudcli-nodes.aca.json \
    PORTAL_NODE_DATA_CONFIG=/app/config/node-data.aca.json \
    SESSION_SHARE_PORTAL_CONFIG=/app/config/session-share.aca.json

# Workspace UI releases are published separately to the existing persistent
# share, not copied to VMs or baked into this backend image. After the first
# package is published, enable PORTAL_CLOUDCLI_UI_ROOT=/data/cloudcli-ui.
WORKDIR /app

COPY package.json package-lock.json README.md ./
COPY public ./public
COPY --from=node-skill-builder /build/public/downloads ./public/downloads
COPY src ./src
COPY config/nodes.aca.json config/session-share.aca.json config/cloudcli-nodes.aca.json config/node-data.aca.json config/codey-node-ca.pem ./config/

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
