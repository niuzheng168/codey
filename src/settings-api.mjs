import { publicAccount, validateNewPassword } from "./account-store.mjs";
import { requestError } from "./signed-store.mjs";

async function body(req, fields) {
  if (String(req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") {
    throw requestError("Expected JSON", 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw requestError("Request too large", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw requestError("Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key))) throw requestError("包含不允许修改的字段");
  return value;
}

function send(res, status, value, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": bytes.length,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", ...headers,
  });
  res.end(bytes);
}

export class SettingsApi {
  constructor({ accounts, nodePolicy, authenticator, cloudCliGateway, nodeDataGateway, machineSetup, machineUpdates }) {
    Object.assign(this, { accounts, nodePolicy, authenticator, cloudCliGateway, nodeDataGateway, machineSetup, machineUpdates });
  }

  async adminNodes() {
    const [registered, users] = await Promise.all([this.nodePolicy.inventory(), this.accounts.list()]);
    const owners = new Map(users.map((user) => [user.id, user]));
    const snapshot = await this.machineUpdates?.inventory(registered);
    const nodes = await Promise.all(registered.map(async ({ id, name, region, ownerId }) => {
      const owner = owners.get(ownerId);
      const metadata = snapshot?.nodes.get(id);
      const updaterStatus = metadata?.status ?? "unavailable";
      const health = owner?.enabled && ["not_enrolled", "unreported", "unavailable"].includes(updaterStatus)
        ? await this.cloudCliGateway?.healthMetadata?.(id) : null;
      const status = !owner ? "unknown" : !owner.enabled ? "owner_disabled"
        : health?.reachable ? "workspace_online" : health ? "workspace_unreachable" : updaterStatus;
      return {
        id, name, region,
        owner: { id: ownerId, username: owner?.username ?? null, enabled: owner?.enabled ?? false },
        status,
        lastSeen: metadata?.lastSeen ?? null,
        releaseId: metadata?.releaseId ?? null,
        ...(health ? { workspaceHealth: health, updaterStatus } : {}),
        components: {
          cloudcli: health?.reachable && health.version
            ? { version: health.version, commit: null, nodeMajor: null, source: "workspace_health" }
            : metadata?.components.cloudcli ?? null,
          copilotApi: metadata?.components.copilotApi ?? null,
        },
      };
    }));
    const online = nodes.filter((node) => ["online", "workspace_online"].includes(node.status)).length;
    const stale = nodes.filter((node) => node.status === "stale").length;
    return {
      generatedAt: snapshot?.generatedAt ?? Date.now(),
      heartbeatTimeoutMs: snapshot?.heartbeatTimeoutMs ?? null,
      telemetryAvailable: Boolean(snapshot),
      workspaceHealthAvailable: nodes.some((node) => node.workspaceHealth),
      summary: {
        total: nodes.length, owners: new Set(nodes.map((node) => node.owner.id)).size,
        online, stale, unknown: nodes.length - online - stale,
      },
      nodes,
    };
  }

  async handle(req, res) {
    const pathname = new URL(req.url, "http://portal.local").pathname;
    if (!pathname.startsWith("/api/settings") && !pathname.startsWith("/api/admin/")) return false;
    try {
      const principal = req.codeyPrincipal;
      if (!principal) throw requestError("需要登录", 401);
      if (this.machineUpdates && await this.machineUpdates.handleOwner(req, res)) return true;
      if (this.machineSetup && await this.machineSetup.handle(req, res)) return true;
      if (pathname.startsWith("/api/admin/") && principal.role !== "admin") {
        throw requestError("只有管理员可以访问全局管理", 403);
      }
      if (pathname === "/api/settings" && req.method === "GET") {
        const nodes = await this.nodePolicy.list(principal.id);
        const ids = nodes.map((node) => node.id);
        const workspaces = new Set((this.cloudCliGateway?.publicNodes(ids) ?? []).map((node) => node.id));
        const account = await this.accounts.byId(principal.id);
        send(res, 200, {
          user: publicAccount(account),
          nodes: nodes.map((node) => ({
            ...node, vnetAvailable: Boolean(this.nodeDataGateway?.endpoint(node.id, ids)),
            workspaceAvailable: workspaces.has(node.id),
          })),
          machineSetup: this.machineSetup ? await this.machineSetup.availability() : { enabled: false },
          pendingMachines: await this.nodePolicy.pendingMachines(principal.id),
        });
        return true;
      }
      if (pathname === "/api/admin/nodes") {
        if (req.method !== "GET") throw requestError("节点总览仅支持只读查询", 405);
        send(res, 200, await this.adminNodes());
        return true;
      }
      if (pathname === "/api/admin/users") {
        if (req.method === "GET") send(res, 200, { users: await this.accounts.list() });
        else if (req.method === "POST") {
          send(res, 201, { user: await this.accounts.create(await body(req, ["username", "password"])) });
        } else throw requestError("Method not allowed", 405);
        return true;
      }
      const accountMatch = pathname.match(/^\/api\/admin\/users\/([a-z0-9-]{1,80})$/);
      if (accountMatch && req.method === "PATCH") {
        const input = await body(req, ["enabled"]);
        send(res, 200, { user: await this.accounts.setEnabled(accountMatch[1], input.enabled, principal.id) });
        return true;
      }
      if (accountMatch && req.method === "DELETE") {
        if ((await this.nodePolicy.list(accountMatch[1])).length) {
          throw requestError("账号仍有节点，不能删除；可先停用以撤销访问", 409);
        }
        await this.accounts.removeDisabled(accountMatch[1], principal.id);
        send(res, 200, { ok: true });
        return true;
      }
      if (pathname === "/api/settings/password" && req.method === "POST") {
        const input = await body(req, ["currentPassword", "newPassword"]);
        validateNewPassword(input.newPassword);
        let version;
        try { version = await this.authenticator.verifyCurrentPassword(principal, input.currentPassword); }
        catch (error) {
          if (error.status === 401) throw requestError("当前密码不正确");
          throw error;
        }
        await this.accounts.changePassword(principal.id, version, input.newPassword);
        await this.authenticator.revoke(req);
        send(res, 200, { ok: true, relogin: true }, { "clear-site-data": '"cache", "storage"' });
        return true;
      }
      if (pathname === "/api/settings/nodes" && req.method === "POST") {
        send(res, 201, { node: await this.nodePolicy.create(principal.id, await body(req, ["name", "region", "endpoint", "accent"])) });
        return true;
      }
      const nodeMatch = pathname.match(/^\/api\/settings\/nodes\/([a-z0-9][a-z0-9_-]{0,31})(\/enrollment)?$/);
      if (nodeMatch) {
        const [, nodeId, enrollment] = nodeMatch;
        // Check ownership before body validation or revealing any node metadata.
        await this.nodePolicy.owned(principal.id, nodeId);
        if (enrollment && req.method === "POST") {
          send(res, 200, await this.nodePolicy.enrollment(principal, nodeId, this.authenticator.origin));
        } else if (!enrollment && req.method === "PUT") {
          send(res, 200, { node: await this.nodePolicy.update(principal.id, nodeId, await body(req, ["name", "region", "endpoint", "accent"])) });
        } else if (!enrollment && req.method === "DELETE") {
          await this.nodePolicy.remove(principal.id, nodeId);
          send(res, 200, { ok: true });
        } else throw requestError("Method not allowed", 405);
        return true;
      }
      throw requestError("Not found", 404);
    } catch (error) {
      send(res, error.status ?? 503, { error: error.status ? error.message : "账号或节点设置暂不可用" });
    }
    return true;
  }
}
