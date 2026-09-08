import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageCloudCliUi } from "../../scripts/build-cloudcli-ui.mjs";

export async function uiFixture(t, release = "ui-one", { title = "CloudCLI UI" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-ui-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const built = path.join(root, "built");
  await mkdir(path.join(built, "assets"), { recursive: true });
  await mkdir(path.join(built, "icons"));
  const base = `/cloudcli-ui/${release}/`;
  const files = {
    "index.html": `<!doctype html><html><head>${title === null ? "" : `<title>${title}</title>`}<link rel="manifest" href="${base}manifest.json"><script type="module" src="${base}assets/app.js"></script></head><body><div id="root"></div><script id="cloudcli-runtime">window.__CLOUDCLI_BASE_PATH__='${base}';</script></body></html>`,
    "assets/app.js": "window.TEST_SHARED_UI=true;",
    "icons/icon.png": "test-png",
    "logo.svg": "<svg></svg>",
    "sw.js": "self.addEventListener('fetch',()=>{});",
    "manifest.json": JSON.stringify({ name: "CloudCLI", start_url: "./", scope: "./", icons: [{ src: "icons/icon.png" }] }),
    "not-public.env": "PRIVATE_TEST_VALUE",
    "clear-cache.html": "Do not ship unscoped cache operations",
  };
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(built, name), body);
  const packageRoot = path.join(root, "package");
  const result = await packageCloudCliUi(built, packageRoot, {
    release, cloudCliVersion: "1.37.2", sourceSha256: createHash("sha256").update("test").digest("hex"),
  });
  const store = path.join(root, "store");
  const activate = async (nextPackage = packageRoot) => {
    const raw = await readFile(path.join(nextPackage, "ui-package.json"));
    const manifest = JSON.parse(raw);
    await mkdir(path.join(store, "releases"), { recursive: true });
    await cp(nextPackage, path.join(store, "releases", manifest.release), { recursive: true });
    await writeFile(path.join(store, "active.json"), JSON.stringify({
      schema: 1, release: manifest.release, manifestSha256: createHash("sha256").update(raw).digest("hex"),
    }));
  };
  await activate();
  return { root, built, packageRoot, store, result, activate };
}
