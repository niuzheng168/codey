# Deployment-local configuration

Only `*.example.json` files belong in Git. Actual `*.json` files and certificates
are ignored and stay on the deployment operator's machine.

For a local, read-only portal, copy `nodes.example.json` to `nodes.json` and adjust
the endpoint to an existing gateway. The example has no management configuration
and does not install, update or restart that gateway.

For ACA, copy the `*.aca.example.json` files to the corresponding `*.aca.json`
names, then configure the deployment's real endpoints and node IDs. The bundled
Dockerfile deliberately requires these operator-supplied files; an unconfigured
clone is not a production deployment.

- `nodes.aca.json`: initial/legacy inventory. New accounts start with no nodes;
  node ownership is managed by Codey's enrollment workflow.
- `cloudcli-nodes.aca.json`: administrator-approved HTTPS Workspace routes.
- `node-data.aca.json`: administrator-approved private HTTPS usage/history routes.
- `session-share.aca.json`: MCP/Entra resource metadata, not OAuth credentials.
- `codey-node-ca.pem`: this deployment's public node CA certificate, provisioned
  separately. Never add its signing private key to the repository.

`example.test` endpoints and UUIDs in the examples are placeholders. Never disable
certificate verification to make an example endpoint work. Use the
`skills/codey-node-onboarding` instructions to enroll an owned node and generate
the matching gateway entries.

Passwords, password verifiers, node enrollment secrets, SSO signing keys and
Speech/Foundry API keys are supplied through a local ignored `.env` or ACA
secrets. Copying this repository does not migrate accounts, credentials or session
history.
