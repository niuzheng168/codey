# Preserve reviewed Dev Tunnel Workspaces

Git source alone is not the runtime node inventory. The builder copies its
private `config/cloudcli-nodes.aca.json` into the Portal image. Keep that
authoritative file synchronized during approved onboarding; changing only a
controller checkout or one deployed image is not sufficient.

For an approved Dev Tunnel Workspace, also maintain the private, Git-ignored
`config/cloudcli-tunnels.required.json`:

- `schema`: `1`
- `routes`: reviewed objects containing only `id`, `upstream`, `tlsServerName`,
  `fingerprint`, and `devTunnel`
- `probeNodeIds`: explicit existing nodes of the deployment account to verify
  through its normal owner-authorized API

The `devTunnel` object contains the original tunnel ID, cluster, HTTPS Workspace
port 3001, and the environment-variable **name** for its connect token. Neither
file should contain a token value, password, Workspace SSO key, or CA private key.
Changing the reviewed tunnel identity, port, TLS pin, or route requires explicit
owner approval. Do not regenerate a missing policy from a suspect four-node
candidate merely to make a failing build pass.

`gateway_routes.py` provides a read-only live preflight:

```sh
python3 -I -S /path/to/scripts/gateway_routes.py --root /home/zhn/g/codey
```

It uses the builder's existing Azure CLI sign-in and prints only node IDs and
SHA-256 proofs. No Azure resource or secret is changed.

The publisher validates the actual frozen Docker input in `Builder.prepare`,
writes `gateway-routes.json`, and checks that neither the input nor private policy
changed before ACA activation. A configured `CODEY_*_TUNNEL_TOKEN` without its
protected route is an error, even if the candidate/policy silently becomes empty.
Normal Linux-only installations without tunnel credentials remain supported.

Post-publication acceptance checks that `probeNodeIds` appear in the deployment
owner's Workspace API, validates node-bound SSO and projects access, and checks
anonymous rejection. It does not grant admin access to other users' nodes, issue
model inference requests, or forward the protected `local` Usage endpoint.
Windows Workspace uses the authenticated Dev Tunnel, not a phone's loopback
interface. Real phone/non-corporate-network acceptance must not be replaced by a
desktop viewport simulation alone.

Offline regressions: run `test_gateway_routes.py` alongside `test_deploy.py`.
Always serialize publishers with the existing controller and builder locks.
