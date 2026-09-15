"""Linux build/ACA worker. No VM or local Windows service operations."""
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

from common import archive_tree, canonical, command, read, release_name, require, safe_extract, save, sha
from gateway_routes import freeze as freeze_gateway_routes, verify_frozen as verify_gateway_routes
from release_source import commits as source_commits, export_sources, select_main, verify_export, verify_source_files


REMOVED_MCP_ENV = frozenset({"PORTAL_MCP_PROXY_URL", "SESSION_SHARE_PORTAL_CONFIG"})


def portal_topology(template):
    names = [row.get("name") for row in template.get("containers", [])]
    require(len(names) == len(set(names))
            and set(names) in ({"portal"}, {"portal", "mcp"}),
            "ACA must contain Portal and at most the removable legacy MCP sidecar")
    return "mcp" in names


def portal_deployment_template(before, portal_image):
    legacy_mcp = portal_topology(before)
    require(isinstance(portal_image, str) and "@sha256:" in portal_image,
            "Portal image must use an immutable digest")
    template = copy.deepcopy(before)
    portal = next(row for row in template["containers"] if row["name"] == "portal")
    portal["image"] = portal_image
    portal["env"] = [
        item for item in portal.get("env", [])
        if item.get("name") not in REMOVED_MCP_ENV
    ]
    template["containers"] = [portal]
    return template, legacy_mcp


class Builder:
    def __init__(self, request):
        require(not request.get("portalSnapshot"), "Uncommitted snapshots are forbidden in production")
        self.request = request
        self.root = Path(request["root"]).resolve()
        self.job = Path(__file__).resolve().parent.parent
        self.release = release_name(self.job.name)
        self.source = self.job / "source"
        self.config = read(self.root / "config/workspace-ui-publish.json")
        self.registry = request.get("registry", "codexshareef492f53f0")
        self.report = {"release": self.release, "checks": []}
        self.bun = ["npx", "--yes", "--package=bun@1.4.2", "bun"]
        self.lease = self.root / "artifacts/.codey-deploy-lock"

    def az(self, arguments, timeout=120):
        result, _ = command(
            ["az", *arguments, "--subscription", self.config["subscription"],
             "--only-show-errors", "-o", "json"],
            timeout=timeout,
            log=self.job / ("az-" + "-".join(arguments[:2]) + ".private.log")
            if arguments[:2] == ["acr", "build"] else None,
        )
        return json.loads(result) if result else None

    def app(self):
        return self.az(["containerapp", "show", "-g", self.config["resourceGroup"], "-n", "codey"])

    def publisher(self):
        file = self.source / "portal/scripts/publish-cloudcli-ui.py"
        spec = importlib.util.spec_from_file_location("codey_ui_publisher", file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def production_source(self):
        require(not self.request.get("portalSnapshot"), "Uncommitted snapshots are forbidden in production")
        source = verify_export(self.source, read(self.job / "release-source.json"))
        require(source_commits(source) == read(self.job / "source.json"), "Frozen source commits changed")
        expected = self.request.get("expectedCommits", {})
        require(all(source_commits(source).get(name) == commit for name, commit in expected.items()),
                "Frozen source does not match the selected main release")
        return source

    def prepare(self):
        require(not self.source.exists(), "This run already has frozen source")
        require(not self.request.get("portalSnapshot"), "Uncommitted snapshots are forbidden in production")
        source = select_main(self.root, self.release, self.request.get("expectedCommits", {}).get("portal"))
        refs = source_commits(source)
        require(all(refs.get(name) == commit for name, commit in self.request.get("expectedCommits", {}).items()),
                "Expected component commits must match main's recorded gitlinks")
        self.lease.mkdir(mode=0o700)
        save(self.lease / "owner.json", {"release": self.release})
        export_sources(self.root, source, self.source)
        save(self.job / "source.json", refs)
        save(self.job / "release-source.json", source)
        before = self.app()
        properties = before["properties"]
        require(properties["provisioningState"] == "Succeeded"
                and properties["latestRevisionName"] == properties["latestReadyRevisionName"],
                "ACA has an unfinished deployment")
        require(properties["configuration"]["activeRevisionsMode"] == "Single", "Unsupported ACA revision mode")
        legacy_mcp = portal_topology(properties["template"])
        for name in ("nodes.aca.json", "cloudcli-nodes.aca.json",
                     "node-data.aca.json", "codey-node-ca.pem"):
            shutil.copy2(self.root / "config" / name, self.source / "portal/config" / name)
        gateway_routes = freeze_gateway_routes(self.root, self.job, before)
        for name in ("cloudcli", "copilot-api"):
            link = self.source / "portal" / name
            if link.is_dir():
                require(not list(link.iterdir()), "Unexpected populated gitlink")
                link.rmdir()
            link.symlink_to(self.source / name, target_is_directory=True)
        store = self.publisher().AzureStore(self.config)
        active = read_json_bytes(store.read("active.json", 2048))
        save(self.job / "aca-before.private.json", before)
        save(self.job / "ui-before.json", active)
        save(self.job / "source.json", refs)
        shutil.copy2(self.root / "config/codey-node-ca.pem", self.job / "ca.pem")
        return {"commits": refs, "previousRevision": properties["latestReadyRevisionName"],
                "fqdn": properties["configuration"]["ingress"]["fqdn"], "previousUi": active["release"],
                "nodes": {row["id"]: {"tlsServerName": row["tlsServerName"]}
                          for row in read(self.root / "config/cloudcli-nodes.aca.json")["nodes"]},
                "releaseSource": source,
                "gatewayRoutes": gateway_routes,
                "worktreesModified": False, "legacyMcpPresent": legacy_mcp}

    def check(self, name, label, args, env, timeout=None):
        # The full Portal suite includes native updater transaction fixtures with
        # durable disk writes. Only the test-runner budget changes here, not any
        # application activity, health or rollout safeguard.
        if timeout is None:
            timeout = 180 if (name, label) == ("portal", "tests") else 100
        _, seconds = command(args, cwd=self.source / name, env=env, timeout=timeout,
                             log=self.job / f"{name}-{label}.log")
        self.report["checks"].append({"component": name, "check": label, "seconds": seconds})

    def dependency_cache(self, name, env):
        source = self.source / name
        lock = "bun.lock" if name == "copilot-api" else "package-lock.json"
        identity = sha(source / lock) + "-" + command(["node", "-p", "process.versions.modules"])[0]
        cache = self.root / "artifacts/codey-deploy-cache" / name / identity
        if not (cache / "ready.json").exists():
            cache.mkdir(parents=True, exist_ok=True)
            for file in ("package.json", lock):
                shutil.copy2(source / file, cache / file)
            if (source / "scripts").is_dir():
                shutil.copytree(source / "scripts", cache / "scripts", dirs_exist_ok=True)
            # Seed only from a matching, previously tested installation. It stays immutable.
            seed = self.request.get("seed")
            prior = Path(seed) / "source" / name if seed else None
            if prior and (prior / "node_modules").is_dir() and sha(prior / lock) == sha(source / lock):
                require(read(Path(seed) / "source-validation.json")["passed"], "Seed validation did not pass")
                require(command(["node", "-p", "process.versions.modules"])[0] == "137",
                        "The legacy seed was built with Node 24; use a cold cache on another ABI")
                (cache / "node_modules").symlink_to(prior / "node_modules", target_is_directory=True)
                mode = "verified-previous-build"
            else:
                args = [*self.bun, "install", "--frozen-lockfile"] if name == "copilot-api" else [
                    "npm", "ci", "--no-audit", "--no-fund"]
                if name == "portal":
                    args.append("--ignore-scripts")
                command(args, cwd=cache, env=env, timeout=180, log=self.job / f"{name}-install.log")
                mode = "cold-install"
            save(cache / "ready.json", {"lockSha256": sha(source / lock), "mode": mode,
                                      "nodeAbi": command(["node", "-p", "process.versions.modules"])[0]})
        require(sha(cache / lock) == sha(source / lock), "Dependency cache lock mismatch")
        (source / "node_modules").symlink_to(cache / "node_modules", target_is_directory=True)
        return read(cache / "ready.json")["mode"]

    def test_directory(self, prefix):
        # /dev is blocked by workspace validation; Git ancestors also affect
        # skill scope. Use short, isolated paths outside the source worktrees.
        return tempfile.TemporaryDirectory(prefix=prefix, dir="/var/tmp")

    def test_environment(self, temporary):
        # Tests receive no real HOME, provider env, Codex state, or production database.
        return {
            "PATH": os.environ["PATH"], "HOME": temporary, "TMPDIR": temporary, "CI": "true",
            "DATABASE_PATH": ":memory:", "CODEY_MANAGED": "false", "CODEY_PORTAL_SSO": "false",
            "NODE_ENV": "test", "NO_COLOR": "1", "HUSKY": "0", "SKIP_INSTALL_SIMPLE_GIT_HOOKS": "1",
            "ELECTRON_SKIP_BINARY_DOWNLOAD": "1",
            "npm_config_cache": str(self.root / "artifacts/codey-deploy-cache/npm"),
            "BUN_INSTALL_CACHE_DIR": str(self.root / "artifacts/codey-deploy-cache/bun"),
        }

    def build_cloudcli(self, commits, env):
        self.production_source()
        source = self.source / "cloudcli"
        mode = self.dependency_cache("cloudcli", env)
        command(["git", "init", "--quiet"], cwd=source)
        for label, args in [
            ("typecheck", ["npm", "run", "typecheck"]),
            ("frontend-tests", ["npm", "run", "test:client"]),
            ("backend-tests", ["npm", "test"]),
            ("lint", ["npm", "run", "lint"]),
            ("build-server", ["npm", "run", "build:server"]),
            ("shared-ui", ["node", str(self.source / "portal/scripts/build-cloudcli-ui.mjs"),
                           "--source", str(source), "--output", str(self.job / "ui"),
                           "--release", "ui-" + self.release]),
        ]:
            self.check("cloudcli", label, args, {**env, "TSX_TSCONFIG_PATH": str(source / "server/tsconfig.json")})
        save(source / "codey-release.json", {
            "release": self.release, "sourceCommit": commits["cloudcli"],
            "lockSha256": sha(source / "package-lock.json"),
        })
        archive_tree(source, self.job / "cloudcli.tar.gz", [
            "package.json", "package-lock.json", "server", "shared", "dist-server",
            "scripts", "codey-release.json",
        ])
        return {"version": read(source / "package.json")["version"], "sourceCommit": commits["cloudcli"],
                "lockSha256": sha(source / "package-lock.json"), "dependencyCache": mode,
                "archiveSha256": sha(self.job / "cloudcli.tar.gz"),
                "entrySha256": sha(source / "dist-server/server/index.js")}

    def build_workspace(self):
        provenance = self.production_source()
        verify_source_files(self.root, provenance, self.source)
        require(self.request.get("components") == ["cloudcli"], "Workspace scope may only publish CloudCLI")
        # Retain honest, previously validated gateway metadata for the existing
        # manifest contract. Its archive is neither rebuilt nor signed/published.
        preserved = self.request["preservedGateway"]
        prior = self.root / "artifacts" / release_name(preserved["releaseId"])
        require(read(prior / "validation.json")["passed"], "Preserved gateway build was not validated")
        gateway = read(prior / "manifest.json")["gateway"]
        for observed in preserved["nodes"].values():
            require(all(observed[a] == gateway[b] for a, b in [
                ("commit", "sourceCommit"), ("entrySha256", "entrySha256"), ("version", "version"),
            ]), "A gateway differs from the preserved build; do not include it in a Workspace-only update")
        commits = read(self.job / "source.json")
        with self.test_directory("codey-workspace-") as temporary:
            cloudcli = self.build_cloudcli(commits, self.test_environment(temporary))
        manifest = {
            "release": self.release, "scope": "workspace", "components": ["cloudcli"],
            "releaseSource": provenance,
            "commits": commits, "cloudcli": cloudcli, "gateway": gateway,
            "gatewayPreservedFrom": preserved["releaseId"], "images": {},
            "ui": read(self.job / "ui/latest-build.json"),
        }
        self.report.update({"passed": True, "scope": "workspace", "components": ["cloudcli"],
                            "cloudcli": cloudcli, "gatewayRebuilt": False, "imagesBuilt": False})
        save(self.job / "validation.json", self.report)
        save(self.job / "manifest.json", manifest)
        return manifest

    def verify_aca_unchanged(self):
        before = read(self.job / "aca-before.private.json")["properties"]
        after = self.app()["properties"]
        require(after["latestRevisionName"] == after["latestReadyRevisionName"] == before["latestReadyRevisionName"],
                "ACA revision changed during the Workspace-only release")
        require(canonical(after["template"]) == canonical(before["template"])
                and canonical(after["configuration"]) == canonical(before["configuration"]),
                "ACA configuration changed during the Workspace-only release")
        result = {"ready": True, "revision": after["latestReadyRevisionName"], "unchanged": True}
        save(self.job / "aca-result.json", result)
        return result

    def resume_workspace(self):
        source = self.production_source()
        manifest = read(self.job / "manifest.json")
        require(manifest.get("releaseSource") == source, "Recovery requires a committed main source manifest")
        require(manifest.get("scope") == "workspace" and manifest.get("components") == ["cloudcli"]
                and read(self.job / "validation.json")["passed"], "Not a validated CloudCLI-only release")
        require(sha(self.job / "cloudcli.tar.gz") == manifest["cloudcli"]["archiveSha256"],
                "The signed application artifact changed; never rebuild it under the same release id")
        for name, expected in self.request.get("expectedCommits", {}).items():
            require(manifest["commits"][name] == expected, "Recovery source differs from the selected commit")
        self.lease.mkdir(mode=0o700)
        save(self.lease / "owner.json", {"release": self.release})
        if self.request.get("reconcileAca"):
            before = read(self.job / "aca-before.private.json")
            current = self.app()
            old, new = before["properties"], current["properties"]
            require(new["provisioningState"] == "Succeeded"
                    and new["latestRevisionName"] == new["latestReadyRevisionName"],
                    "Wait for the other ACA rollout to finish; do not replace its baseline mid-rollout")
            old_template, new_template = canonical(old["template"]), canonical(new["template"])
            old_template.pop("revisionSuffix", None)
            new_template.pop("revisionSuffix", None)
            require(old_template == new_template
                    and canonical(old["configuration"]) == canonical(new["configuration"]),
                    "The concurrent ACA change is not a metadata-only restart; review it separately")
            active = read_json_bytes(self.publisher().AzureStore(self.config).read("active.json", 2048))
            require(active == read(self.job / "ui-before.json"), "Shared UI changed; do not overwrite another publication")
            save(self.job / f"aca-before-reconcile-{time.time_ns()}.private.json", before)
            save(self.job / "aca-before.private.json", current)
            reconciliation = {"previousRevision": old["latestReadyRevisionName"],
                              "acceptedRevision": new["latestReadyRevisionName"],
                              "imagesAndConfigurationUnchanged": True, "sharedUiUnchanged": True,
                              "acaMutatedByThisRelease": False}
            save(self.job / "aca-reconciliation.json", reconciliation)
            manifest = {**manifest, "acaReconciliation": reconciliation}
        self.verify_aca_unchanged()
        return manifest

    def build(self):
        provenance = self.production_source()
        verify_source_files(self.root, provenance, self.source)
        commits = read(self.job / "source.json")
        with self.test_directory("codey-fast-") as temporary:
            env = self.test_environment(temporary)

            def image(name, directory, repository):
                verify_source_files(self.root, provenance, self.source)
                tag = provenance["commit"] + "-" + self.release
                self.az(["acr", "build", "-r", self.registry, "-t", f"{repository}:{tag}",
                         "--build-arg", "CODEY_SOURCE_COMMIT=" + provenance["commit"],
                         "--file", str(directory / "Dockerfile"), "--no-logs", str(directory)], timeout=210)
                # A unique tag attributes this build even when the installed CLI returns no JSON.
                digest = self.az(["acr", "repository", "show", "-n", self.registry,
                                  "--image", f"{repository}:{tag}", "--query", "digest"])
                require(isinstance(digest, str) and digest.startswith("sha256:"), "Missing image digest")
                return name, {"image": f"{self.registry}.azurecr.io/{repository}@{digest}", "tag": tag,
                              "sourceCommit": provenance["commit"]}

            def portal():
                if read(self.source / "portal/package.json").get("dependencies"):
                    self.report["portalDependencyCache"] = self.dependency_cache("portal", env)
                for label, args in [
                    ("skill", ["npm", "run", "skill:build"]), ("check", ["npm", "run", "check"]),
                    ("updater-check", ["npm", "run", "updates:check"]),
                    ("updater-transactions", ["/usr/bin/python3", "-m", "unittest", "discover", "-s", "test", "-p", "test_node_updater.py"]),
                    ("tests", ["npm", "test"]),
                ]:
                    self.check("portal", label, args, env)
                return image("portal", self.source / "portal", "codey")

            def gateway():
                source = self.source / "copilot-api"
                mode = self.dependency_cache("copilot-api", env)
                for label, args in [
                    ("typecheck", [*self.bun, "run", "typecheck"]), ("tests", [*self.bun, "test"]),
                    ("lint", [*self.bun, "run", "lint"]), ("build", [*self.bun, "run", "build"]),
                ]:
                    self.check("copilot-api", label, args, env)
                package = self.job / "gateway-package"
                package.mkdir()
                for directory in ("dist", "pages"):
                    shutil.copytree(source / directory, package / directory)
                for file in ("package.json", "bun.lock"):
                    shutil.copy2(source / file, package / file)
                command([*self.bun, "install", "--frozen-lockfile", "--production", "--ignore-scripts"],
                        cwd=package, env=env, timeout=100, log=self.job / "gateway-production-install.log")
                save(package / "codey-release.json", {"release": self.release, "sourceCommit": commits["copilot-api"]})
                archive_tree(package, self.job / "gateway.tar.gz")
                return {"version": read(package / "package.json")["version"], "sourceCommit": commits["copilot-api"],
                        "dependencyCache": mode, "archiveSha256": sha(self.job / "gateway.tar.gz"),
                        "entrySha256": sha(package / "dist/main.js")}

            with ThreadPoolExecutor(max_workers=3) as pool:
                portal_job = pool.submit(portal)
                cc_job, cp_job = pool.submit(self.build_cloudcli, commits, env), pool.submit(gateway)
                images = dict([portal_job.result()])
                cc, cp = cc_job.result(), cp_job.result()
        manifest = {"release": self.release, "commits": commits, "releaseSource": provenance,
                    "cloudcli": cc, "gateway": cp, "images": images,
                    "ui": read(self.job / "ui/latest-build.json")}
        self.report.update({"passed": True, "cloudcli": cc, "gateway": cp})
        save(self.job / "validation.json", self.report)
        save(self.job / "manifest.json", manifest)
        return manifest

    def activate(self):
        source = self.production_source()
        verify_source_files(self.root, source, self.source)
        before = read(self.job / "aca-before.private.json")
        manifest = read(self.job / "manifest.json")
        require(manifest.get("releaseSource") == source, "Image manifest is not bound to the main source")
        verify_gateway_routes(self.root, self.job, before)
        require(read(self.job / "validation.json")["passed"], "Source validation did not pass")
        current = self.app()
        for field in ("configuration", "template"):
            require(canonical(current["properties"][field]) == canonical(before["properties"][field]),
                    "ACA changed concurrently; do not overwrite")
        require(canonical(current.get("identity")) == canonical(before.get("identity")), "ACA identity changed")
        require(set(manifest["images"]) == {"portal"}, "ACA releases may only deploy the Portal container")
        template, legacy_mcp_removed = portal_deployment_template(
            before["properties"]["template"], manifest["images"]["portal"]["image"],
        )
        suffix = self.release.replace("fast-", "f-", 1)
        template["revisionSuffix"] = suffix
        revision = "codey--" + suffix
        portal = template["containers"][0]
        if self.request.get("enableNodeUpdates"):
            require(any(item.get("mountPath") == "/data" for item in portal.get("volumeMounts", [])),
                    "Node updates require the existing /data share; no volume/resource is created")
            store = self.publisher().AzureStore({**self.config, "directory": "node-updates"})
            require(store.read("release-public.pem", 8192) and store.read("catalog.json", 4 * 1024 * 1024),
                    "Publish the signed node feed before enabling the Portal")
            values = {"PORTAL_NODE_UPDATE_ROOT": "/data/node-updates",
                      "PORTAL_NODE_UPDATE_PUBLIC_KEY_FILE": "/data/node-updates/release-public.pem"}
            portal["env"] = [item for item in portal.get("env", []) if item["name"] not in values]
            portal["env"].extend({"name": name, "value": value} for name, value in values.items())
        patch = self.job / "aca-patch.private.json"
        save(patch, {"properties": {"template": canonical(template)}})
        save(self.job / "aca-rollback.json", {"expectedRevision": revision,
             "previousRevision": before["properties"]["latestReadyRevisionName"],
             "beforeFile": "aca-before.private.json", "restorePersistentData": False})
        started = time.monotonic()
        # Exactly one PATCH. Poll eventual consistency, never retry it blindly.
        self.az(["rest", "--method", "patch", "--url", before["id"] + "?api-version=2025-07-01",
                 "--body", "@" + str(patch)], timeout=120)
        while time.monotonic() - started < 270:
            after = self.app()
            properties = after["properties"]
            require(properties["latestRevisionName"] in {revision, before["properties"]["latestRevisionName"]},
                    "A different ACA rollout superseded this one")
            if properties["latestRevisionName"] == revision:
                require(canonical(properties["template"]) == canonical(template), "Unexpected ACA template change")
                require(canonical(properties["configuration"]) == canonical(before["properties"]["configuration"]),
                        "Unexpected ACA configuration change")
                require(canonical(after.get("identity")) == canonical(before.get("identity")), "ACA identity drift")
            if properties["latestReadyRevisionName"] == revision and properties["provisioningState"] == "Succeeded":
                replicas = self.az(["containerapp", "replica", "list", "-g", self.config["resourceGroup"],
                                    "-n", "codey", "--revision", revision])
                containers = [row for replica in replicas for row in replica["properties"]["containers"]]
                if containers and all(row["ready"] for row in containers):
                    result = {"revision": revision, "ready": True, "seconds": round(time.monotonic() - started, 3),
                              "images": manifest["images"], "configurationPreserved": True,
                              "legacyMcpRemoved": legacy_mcp_removed,
                              "removedEnvironmentVariables": sorted(REMOVED_MCP_ENV),
                              "containers": [{key: row.get(key) for key in ("name", "ready", "restartCount")}
                                             for row in containers]}
                    save(self.job / "aca-result.json", result)
                    return result
            time.sleep(4)
        raise TimeoutError("ACA readiness exceeded 270 seconds; retain the rollback record and reconcile, not re-PATCH")

    def build_portal(self):
        """Portal-only release: no Workspace UI or node package build."""
        provenance = self.production_source()
        verify_source_files(self.root, provenance, self.source)
        with self.test_directory("codey-portal-") as temporary:
            env = {
                "PATH": os.environ["PATH"], "HOME": temporary, "TMPDIR": temporary,
                "CI": "true", "NODE_ENV": "test", "NO_COLOR": "1",
                "CODEY_MANAGED": "false", "CODEY_PORTAL_SSO": "false", "DATABASE_PATH": ":memory:",
            }
            if read(self.source / "portal/package.json").get("dependencies"):
                self.report["portalDependencyCache"] = self.dependency_cache("portal", env)
            for label, args in [
                ("skill", ["npm", "run", "skill:build"]),
                ("check", ["npm", "run", "check"]),
                ("updater-check", ["npm", "run", "updates:check"]),
                ("updater-transactions", ["/usr/bin/python3", "-m", "unittest", "discover", "-s", "test", "-p", "test_node_updater.py"]),
                ("tests", ["npm", "test"]),
            ]:
                self.check("portal", label, args, env)
        source = self.source / "portal"
        verify_source_files(self.root, provenance, self.source)
        tag = provenance["commit"] + "-" + self.release
        self.az(["acr", "build", "-r", self.registry, "-t", "codey:" + tag,
                 "--build-arg", "CODEY_SOURCE_COMMIT=" + provenance["commit"],
                 "--file", str(source / "Dockerfile"), "--no-logs", str(source)], timeout=210)
        digest = self.az(["acr", "repository", "show", "-n", self.registry,
                          "--image", "codey:" + tag, "--query", "digest"])
        require(isinstance(digest, str) and digest.startswith("sha256:"), "Missing Portal digest")
        before = read(self.job / "aca-before.private.json")
        legacy_mcp = portal_topology(before["properties"]["template"])
        images = {"portal": {"image": f"{self.registry}.azurecr.io/codey@{digest}", "tag": tag,
                             "sourceCommit": provenance["commit"]}}
        files = {"/": sha(source / "public/index.html"), "/app.js": sha(source / "public/app.js")}
        files["/settings"] = sha(source / "public/settings.html")
        for name in ["settings.css", "machine-updates.js", "client-aggregator.js", "node-transport.js", "styles.css"]:
            files["/" + name] = sha(source / "public" / name)
        features = {}
        if (source / "public/portal-features.js").is_file():
            files["/portal-features.js"] = sha(source / "public/portal-features.js")
            output, _ = command([
                "node", "--input-type=module", "-e",
                "import('./public/portal-features.js').then(m=>console.log(JSON.stringify("
                "{sessionHistory:m.SESSION_HISTORY_ENABLED,views:m.PORTAL_VIEWS})))",
            ], cwd=source, timeout=10)
            features = json.loads(output)
        result = {
            "release": self.release, "scope": "portal", "commits": read(self.job / "source.json"),
            "releaseSource": provenance, "images": images,
            "sharedUi": read(self.job / "ui-before.json"), "publicSha256": files,
            "features": features,
            "nodePackagesChanged": False, "deploymentContainers": ["portal"],
            "legacyMcpPresent": legacy_mcp,
        }
        self.report["passed"] = True
        save(self.job / "validation.json", self.report)
        save(self.job / "manifest.json", result)
        return result

    def publish_ui(self):
        self.production_source()
        manifest = read(self.job / "manifest.json")
        publisher = self.publisher()
        result = publisher.publish_package(publisher.AzureStore(self.config), manifest["ui"]["directory"],
                                           read(self.job / "ui-before.json")["release"])
        save(self.job / "ui-result.json", result)
        return result

    def unlock(self):
        if not self.lease.exists():
            return {"released": True}
        require(read(self.lease / "owner.json")["release"] == self.release, "Deployment lock belongs to another run")
        (self.lease / "owner.json").unlink()
        self.lease.rmdir()
        return {"released": True}

def read_json_bytes(value):
    require(value is not None, "Missing published UI descriptor")
    return json.loads(value)


if __name__ == "__main__":
    request = json.load(sys.stdin)
    worker = Builder(request)
    try:
        result = getattr(worker, request["mode"])()
        print(json.dumps({"ok": True, "result": result}), flush=True)
    except Exception as error:
        save(worker.job / (request["mode"] + "-error.json"), {"error": str(error), "type": type(error).__name__})
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        raise SystemExit(1)
