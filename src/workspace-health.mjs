import https from "node:https";

// Public, read-only health metadata only. Never send a user cookie, SSO
// assertion, provider credential, or return an upstream body/error to the UI.
export function readWorkspaceHealth(node, options, { clock = Date.now, timeoutMs = 4000, requestImpl = https.get } = {}) {
  const result = (reachable, version = null, codey = null) => ({
    reachable, checkedAt: clock(), version, ...(codey ? { codey } : {}),
  });
  if (node.upstream.protocol !== "https:" || options.rejectUnauthorized !== true) {
    return Promise.resolve(result(false));
  }
  return new Promise((resolve) => {
    let request;
    let finished = false;
    const finish = (reachable, version, codey) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result(reachable, version, codey));
    };
    const timer = setTimeout(() => {
      finish(false);
      request?.destroy();
    }, timeoutMs);
    try {
      request = requestImpl(new URL("/health", node.upstream), {
        ...options, headers: { accept: "application/json" },
      }, (response) => {
        if (response.statusCode !== 200) {
          finish(false);
          response.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024) {
            finish(false);
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", () => finish(false));
        response.once("aborted", () => finish(false));
        response.once("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks));
            const version = typeof body.version === "string" &&
              /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(body.version) && body.version.length <= 80
              ? body.version : null;
            const identity = body.codey;
            // A component's version or the published target is not an installed
            // Codey version. Accept only the running package's explicit identity.
            const codey = body.status === "ok" && version && identity?.name === "codey" &&
              identity.version === version && /^[a-f0-9]{40}$/.test(identity.commit ?? "") &&
              /^machine-[a-f0-9]{16}$/.test(identity.releaseId ?? "") &&
              Number.isSafeInteger(identity.nodeMajor) && identity.nodeMajor > 0 && identity.nodeMajor < 1000
              ? { name: "codey", version, commit: identity.commit, releaseId: identity.releaseId, nodeMajor: identity.nodeMajor }
              : null;
            finish(body.status === "ok", body.status === "ok" ? version : null, codey);
          } catch { finish(false); }
        });
      });
      request.once("error", () => finish(false));
    } catch { finish(false); }
  });
}
