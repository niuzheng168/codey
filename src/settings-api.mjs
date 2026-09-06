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
  constructor({ accounts, nodePolicy, authenticator, cloudCliGateway, nodeDataGateway }) {
    Object.assign(this, { accounts, nodePolicy, authenticator, cloudCliGateway, nodeDataGateway });
  }

  async handle(req, res) {
    const pathname = new URL(req.url, "http://portal.local").pathname;
    if (!pathname.startsWith("/api/settings") && !pathname.startsWith("/api/admin/")) return false;
    try {
      const principal = req.codeyPrincipal;
      if (!principal) throw requestError("需要登录", 401);
      if (pathname.startsWith("/api/admin/") && principal.role !== "admin") {
        throw requestError("只有管理员可以管理账号", 403);
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
        });
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
