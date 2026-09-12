import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  UI_ASSET_PREFIX, UI_MANIFEST_MARKER, UI_RUNTIME_MARKER,
  readUiPackage, readUiPackageFile, readUiStoreFile, uiContentType, validateUiRelease, validateUiTemplate,
} from "./cloudcli-ui-package.mjs";

function send(req, res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "cache-control": "private, no-store",
    vary: "Cookie",
    "content-type": type,
    "content-length": bytes.length,
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "no-referrer",
    // Preserve CloudCLI's resource/plugin behavior while forbidding cross-origin framing.
    "content-security-policy": "frame-ancestors 'self'; base-uri 'none'",
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

function error(req, res, status, code) {
  send(req, res, status, JSON.stringify({ error: code }));
}

/** Show the authorized machine label even before the shared frontend has hydrated. */
function withWorkspaceTitle(template, nodeName) {
  const title = `cloudcli - ${nodeName}`.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const markup = `<title>${title}</title>`;
  const existing = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i;
  return existing.test(template)
    ? template.replace(existing, () => markup)
    : template.replace(/<\/head\s*>/i, () => `${markup}</head>`);
}

/** Portal serves one immutable UI package; node APIs, SSO and WebSockets remain in CloudCliGateway. */
export class CloudCliUi {
  constructor(root) {
    if (!root || !path.isAbsolute(root)) throw new Error("PORTAL_CLOUDCLI_UI_ROOT must be absolute");
    this.root = root;
    // Immutable metadata only. Read active.json afresh so publication needs no process restart.
    this.packages = new Map();
  }

  async package(release, expectedSha256) {
    validateUiRelease(release);
    let bundle = this.packages.get(release);
    if (!bundle) {
      const storeRoot = await realpath(this.root);
      const directory = path.join(storeRoot, "releases", release);
      bundle = await readUiPackage(directory, expectedSha256);
      if (bundle.root !== directory) throw new Error("Unsafe workspace UI release directory");
      if (bundle.manifest.release !== release) throw new Error("Workspace UI release mismatch");
      if (this.packages.size >= 8) this.packages.delete(this.packages.keys().next().value);
      this.packages.set(release, bundle);
    }
    if (expectedSha256 && bundle.sha256 !== expectedSha256) throw new Error("Workspace UI release was mutated");
    return bundle;
  }

  async active() {
    const value = JSON.parse((await readUiStoreFile(this.root, "active.json", 1024)).toString("utf8"));
    if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.manifestSha256 || "")) {
      throw new Error("Invalid workspace UI activation");
    }
    return this.package(value.release, value.manifestSha256);
  }

  /** Called only after the Portal's normal login gate; these assets contain no node/user data. */
  async handleAssets(req, res) {
    const pathname = new URL(req.url, "http://portal.local").pathname;
    if (pathname !== UI_ASSET_PREFIX.slice(0, -1) && !pathname.startsWith(UI_ASSET_PREFIX)) return false;
    if (!["GET", "HEAD"].includes(req.method)) {
      error(req, res, 405, "WORKSPACE_UI_READ_ONLY");
      return true;
    }
    const [release, ...parts] = pathname.slice(UI_ASSET_PREFIX.length).split("/");
    const name = parts.join("/");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(release) || !uiContentType(name) ||
        ["index.html", "manifest.json", "sw.js"].includes(name)) {
      error(req, res, 404, "WORKSPACE_UI_NOT_FOUND");
      return true;
    }
    try {
      const bundle = await this.package(release);
      const body = await readUiPackageFile(bundle, name);
      if (!body) error(req, res, 404, "WORKSPACE_UI_NOT_FOUND");
      else {
        const etag = `"${bundle.manifest.files[name].sha256}"`;
        const headers = {
          "cache-control": "private, max-age=31536000, immutable",
          "x-codey-ui-release": release, etag,
        };
        if (req.headers["if-none-match"] === etag) send(req, res, 304, "", uiContentType(name), headers);
        else send(req, res, 200, body, uiContentType(name), headers);
      }
    } catch (reason) {
      error(req, res, reason.code === "ENOENT" ? 404 : 503, "WORKSPACE_UI_UNAVAILABLE");
    }
    return true;
  }

  /** CloudCliGateway calls this only AFTER checking the requested node's allowlist and live ACL. */
  async handleWorkspace(req, res, node) {
    const pathname = new URL(req.url, "http://portal.local").pathname.slice(node.basePath.length);
    const backend = /^\/(?:api|assets|ws|shell|plugin-ws|health)(?:\/|$)/i.test(pathname);
    // Client-side routes may grow without another Portal deployment. Reserve
    // node endpoints and dotted resources before applying the SPA fallback.
    const page = !backend && !pathname.startsWith("/_ui/") &&
      (pathname === "/index.html" || !path.posix.extname(pathname) || /^\/session\/[^/]+\/?$/.test(pathname));
    const runtime = pathname === "/_ui/runtime.js";
    const version = pathname === "/_ui/version.json";
    const manifest = pathname === "/manifest.json";
    const worker = pathname === "/sw.js";
    const icon = /^\/(?:favicon\.(?:png|svg|ico)|logo(?:-\d+)?\.(?:png|svg)|icons\/[a-zA-Z0-9_-]+\.(?:png|svg))$/.test(pathname);
    if (pathname.startsWith("/_ui/") && !runtime && !version) {
      error(req, res, 404, "WORKSPACE_UI_NOT_FOUND");
      return true;
    }
    if (!page && !runtime && !version && !manifest && !worker && !icon) return false;
    if (!["GET", "HEAD"].includes(req.method)) {
      error(req, res, 405, "WORKSPACE_UI_READ_ONLY");
      return true;
    }
    try {
      const nodeName = typeof node.name === "string" && node.name.trim() ? node.name.trim() : node.id;
      if (runtime) {
        // No release-dependent values: an old page racing an activation keeps its own asset URLs.
        const base = JSON.stringify(`${node.basePath}/`);
        const identity = JSON.stringify({ id: node.id, name: nodeName })
          .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
        send(req, res, 200,
          `window.__CLOUDCLI_BASE_PATH__=${base};window.__ROUTER_BASENAME__=${JSON.stringify(node.basePath)};window.__CLOUDCLI_NODE__=${identity};\n`,
          "text/javascript; charset=utf-8");
        return true;
      }
      const bundle = await this.active();
      const headers = { "x-codey-ui-release": bundle.manifest.release };
      if (version) {
        send(req, res, 200, JSON.stringify({
          release: bundle.manifest.release, cloudCliVersion: bundle.manifest.cloudCliVersion,
          apiContract: bundle.manifest.apiContract, shared: true,
        }), undefined, headers);
      } else if (page) {
        const template = validateUiTemplate((await readUiPackageFile(bundle, "index.html")).toString("utf8"));
        const html = withWorkspaceTitle(template, nodeName)
          .replace(UI_RUNTIME_MARKER, `<script src="${node.basePath}/_ui/runtime.js"></script>`)
          .replace(UI_MANIFEST_MARKER, `${node.basePath}/manifest.json`);
        send(req, res, 200, html, "text/html; charset=utf-8", headers);
      } else if (manifest) {
        const value = JSON.parse((await readUiPackageFile(bundle, "manifest.json")).toString("utf8"));
        const base = `${node.basePath}/`;
        value.id = base;
        value.start_url = base;
        value.scope = base;
        value.icons = (value.icons || []).map((item) => {
          if (!Object.hasOwn(bundle.manifest.files, item.src) || !uiContentType(item.src)?.startsWith("image/")) {
            throw new Error("Invalid workspace icon");
          }
          return { ...item, src: bundle.manifest.assetBase + item.src };
        });
        send(req, res, 200, JSON.stringify(value), uiContentType("manifest.json"), headers);
      } else {
        const name = worker ? "sw.js" : pathname.slice(1);
        const body = await readUiPackageFile(bundle, name);
        if (!body) error(req, res, 404, "WORKSPACE_UI_NOT_FOUND");
        else send(req, res, 200, body, uiContentType(name), {
          ...headers, ...(worker ? { "service-worker-allowed": `${node.basePath}/` } : {}),
        });
      }
    } catch {
      // An incomplete activation must not silently fall back to a stale VM UI.
      error(req, res, 503, "WORKSPACE_UI_UNAVAILABLE");
    }
    return true;
  }
}
