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

# Preserve private source modes without making the non-root runtime unable to read them.
COPY --chown=node:node package.json package-lock.json README.md ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node public ./public
COPY --from=node-skill-builder --chown=node:node /build/public/downloads ./public/downloads
COPY --chown=node:node src ./src
COPY --chown=node:node node-updater ./node-updater
COPY --chown=node:node skills/config-new-codey-machine/SKILL.md skills/config-new-codey-machine/dependencies.json ./skills/config-new-codey-machine/
COPY --chown=node:node skills/config-new-codey-machine/agents/openai.yaml ./skills/config-new-codey-machine/agents/
COPY --chown=node:node skills/config-new-codey-machine/scripts/configure-machine.py skills/config-new-codey-machine/scripts/azure-vnet.py ./skills/config-new-codey-machine/scripts/
COPY --chown=node:node skills/config-new-codey-machine/scripts/setup-linux.sh skills/config-new-codey-machine/scripts/setup-windows.ps1 skills/config-new-codey-machine/scripts/configure-windows.py skills/config-new-codey-machine/scripts/windows-service.py skills/config-new-codey-machine/scripts/windows-tasks.ps1 ./skills/config-new-codey-machine/scripts/
COPY --chown=node:node skills/config-new-codey-machine/scripts/configure-windows-tunnel.py skills/config-new-codey-machine/scripts/windows-tunnel-client.py skills/config-new-codey-machine/scripts/windows-tunnel-service.py skills/config-new-codey-machine/scripts/windows-tunnel-tasks.ps1 ./skills/config-new-codey-machine/scripts/
COPY --chown=node:node skills/config-new-codey-machine/scripts/windows-codex-runtime.py skills/config-new-codey-machine/scripts/repair-windows-codex.py skills/config-new-codey-machine/scripts/repair-windows-codex.ps1 skills/config-new-codey-machine/scripts/windows-codex-repair-tasks.ps1 ./skills/config-new-codey-machine/scripts/
COPY --chown=node:node skills/config-new-codey-machine/references/windows-codex-repair.md ./skills/config-new-codey-machine/references/
COPY --chown=node:node skills/config-new-codey-machine/scripts/setup-macos.sh skills/config-new-codey-machine/scripts/configure-macos.py skills/config-new-codey-machine/scripts/macos-service.py ./skills/config-new-codey-machine/scripts/
COPY --chown=node:node skills/config-new-codey-machine/references/verification.md ./skills/config-new-codey-machine/references/
COPY --chown=node:node config/nodes.aca.json config/session-share.aca.json config/cloudcli-nodes.aca.json config/node-data.aca.json config/codey-node-ca.pem ./config/

USER node

# Fail the build, rather than the production revision, if any runtime input is unreadable.
RUN node -e "const fs=require('node:fs'); const check=p=>{if(fs.statSync(p).isDirectory()){for(const name of fs.readdirSync(p))check(p+'/'+name)}else fs.accessSync(p,fs.constants.R_OK)}; for(const p of ['package.json','src','public','config','node-updater','skills/config-new-codey-machine'])check(p)"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
