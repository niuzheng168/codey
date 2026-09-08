import https from "node:https";

// Public, read-only health metadata only. Never send a user cookie, SSO
// assertion, provider credential, or return an upstream body/error to the UI.
export function readWorkspaceHealth(node, options, { clock = Date.now, timeoutMs = 4000, requestImpl = https.get } = {}) {
  const result = (reachable, version = null) => ({ reachable, checkedAt: clock(), version });
  if (node.upstream.protocol !== "https:" || options.rejectUnauthorized !== true) {
    return Promise.resolve(result(false));
  }
  return new Promise((resolve) => {
    let request;
    let finished = false;
    const finish = (reachable, version) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result(reachable, version));
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
              /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(body.version) && body.version.length <= 80
              ? body.version : null;
            finish(body.status === "ok", body.status === "ok" ? version : null);
          } catch { finish(false); }
        });
      });
      request.once("error", () => finish(false));
    } catch { finish(false); }
  });
}
