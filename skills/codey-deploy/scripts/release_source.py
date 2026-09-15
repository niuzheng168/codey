"""The production source contract: one origin/main commit and its gitlinks.

No checkout, reset, stash, commit, version edit, or developer-index update.
Generated archives and provenance belong only in an isolated build directory.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

COMPONENTS = ("cloudcli", "copilot-api")
SOURCE_FILE = "codey-source.json"
COMPONENT_FILE = ".codey-component-source.json"
SHA = re.compile(r"[a-f0-9]{40}")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?")


def require(value, message):
    if not value:
        raise RuntimeError(message)


def git(root, *args, binary=False):
    result = subprocess.run(["git", *map(str, args)], cwd=root, capture_output=True,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
                            timeout=60, check=False)
    require(result.returncode == 0,
            "Committed-source Git operation failed: " + str(args[0]))
    return result.stdout if binary else result.stdout.decode().strip()


def validate_source(value):
    keys = {"schema", "kind", "ref", "commit", "tree", "submodules", "sourceDirty", "codeyVersion"}
    require(isinstance(value, dict) and set(value) == keys and type(value["schema"]) is int and value["schema"] == 1
            and value["kind"] == "codey-main-source" and value["ref"] == "refs/heads/main"
            and value["sourceDirty"] is False
            and all(isinstance(value[name], str) and SHA.fullmatch(value[name])
                    for name in ("commit", "tree"))
            and isinstance(value["codeyVersion"], str) and VERSION.fullmatch(value["codeyVersion"])
            and isinstance(value["submodules"], dict) and set(value["submodules"]) == set(COMPONENTS)
            and all(isinstance(commit, str) and SHA.fullmatch(commit)
                    for commit in value["submodules"].values()),
            "Production publication requires verified, committed origin/main provenance")
    return value


def commits(value):
    value = validate_source(value)
    return {"portal": value["commit"], **value["submodules"]}


def verify_package_source(build, source):
    source = validate_source(source)
    require(build.get("sourceDirty") is False and build.get("releaseSource") == source
            and build.get("sourceCommit") == source["commit"] and build.get("version") == source["codeyVersion"]
            and build.get("cloudcli", {}).get("commit") == source["submodules"]["cloudcli"]
            and build.get("copilotApi", {}).get("commit") == source["submodules"]["copilot-api"],
            "Package source differs from its committed main provenance")
    return source


def select_main(root, release, expected=None):
    """Fetch main once, then derive every component from that exact tree."""
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", release), "Invalid release source namespace")
    require(expected is None or isinstance(expected, str) and SHA.fullmatch(expected),
            "The selected main commit must be a full lowercase SHA")
    ref = "refs/codey-deploy/" + release + "/portal"
    git(root, "fetch", "--no-write-fetch-head", "--no-tags", "--refmap=", "origin", "refs/heads/main:" + ref)
    commit = git(root, "rev-parse", ref + "^{commit}")
    require(expected is None or commit == expected,
            "origin/main changed; select its current commit before starting a new release")
    links = {}
    for name in COMPONENTS:
        record = git(root, "ls-tree", "-z", commit, "--", name, binary=True).decode()
        require(record.endswith("\0") and record.count("\0") == 1,
                "main must pin exactly one gitlink for " + name)
        metadata, filename = record[:-1].split("\t", 1)
        mode, kind, target = metadata.split(" ")
        require(filename == name and mode == "160000" and kind == "commit" and SHA.fullmatch(target),
                "main must pin a submodule commit, not a directory or branch: " + name)
        links[name] = target
    package = json.loads(git(root, "show", commit + ":packages/codey/package.json", binary=True))
    return validate_source({
        "schema": 1, "kind": "codey-main-source", "ref": "refs/heads/main",
        "commit": commit, "tree": git(root, "rev-parse", commit + "^{tree}"),
        "submodules": links, "sourceDirty": False, "codeyVersion": package["version"],
    })


def verify_tooling(root, source):
    """A dirty/stale launcher must not execute unmerged deployment behavior."""
    source = validate_source(source)
    require(git(root, "rev-parse", "HEAD") == source["commit"],
            "Use a clean checkout of selected origin/main; deploy never updates your checkout")
    require(not git(root, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"),
            "Production checkout is dirty; merge changes into main or use the isolated CI checkout")
    prefix = "skills/codey-deploy/scripts/"
    tracked = git(root, "ls-tree", "-r", "--name-only", source["commit"], "--", prefix).splitlines()
    expected = {name for name in tracked if Path(name).suffix in {".py", ".mjs"}}
    actual = {file.relative_to(root).as_posix() for file in (Path(root) / prefix).iterdir()
              if file.is_file() and file.suffix in {".py", ".mjs"}}
    require(actual == expected and expected,
            "Deployment tooling must first be merged into main; uncommitted tools cannot publish")
    for name in sorted(expected):
        original = git(root, "show", source["commit"] + ":" + name, binary=True)
        current = (Path(root) / name).read_bytes()
        require(current.replace(b"\r\n", b"\n") == original.replace(b"\r\n", b"\n"),
                "Deployment tooling differs from selected main; merge/pull before deploying: " + name)


def export_tree(root, commit, archive, destination):
    archive, destination = Path(archive), Path(destination)
    require(not archive.exists() and not destination.exists(), "Never overwrite a frozen source snapshot")
    git(root, "archive", "--format=tar.gz", "--output", archive, commit)
    destination.mkdir(parents=True, mode=0o700)
    with tarfile.open(archive, "r:gz") as source:
        names = [item.name for item in source]
        require(len(set(names)) == len(names), "Duplicate path in committed source archive")
        source.extractall(destination, filter="data")


def export_sources(root, source, directory):
    """Export the root and pinned submodules; submodule branch tips are ignored."""
    root, directory = Path(root), Path(directory)
    source = validate_source(source)
    require(not directory.exists(), "This release already has frozen source")
    directory.mkdir(parents=True, mode=0o700)
    for name, repository, commit in [
        ("portal", root, source["commit"]),
        *((name, root / name, source["submodules"][name]) for name in COMPONENTS),
    ]:
        if name != "portal":
            # Fetch the recorded object, never origin/main, origin/dev or --remote.
            ref = "refs/codey-release-source/" + source["commit"] + "/" + name
            git(repository, "fetch", "--no-write-fetch-head", "--no-tags", "--refmap=", "origin", commit + ":" + ref)
            require(git(repository, "rev-parse", commit + "^{commit}") == commit,
                    "Pinned submodule object is not a commit")
        destination = directory / name
        export_tree(repository, commit, directory / (name + ".tar.gz"), destination)
        if name != "portal":
            require(not (destination / COMPONENT_FILE).exists(), "Generated component provenance must not be committed")
            files = {file.relative_to(destination).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                     for file in sorted(destination.rglob("*")) if file.is_file() and not file.is_symlink()}
            proof = {"schema": 1, "component": name, "source": source, "files": files,
                     "packageJson": (destination / "package.json").read_text()}
            (destination / COMPONENT_FILE).write_text(json.dumps(proof, indent=2) + "\n")
    target = directory / "portal" / SOURCE_FILE
    require(not target.exists(), "Generated build provenance must not be committed")
    target.write_text(json.dumps(source, indent=2) + "\n")
    return directory / "portal"


def verify_source_tree(repository, commit, directory, source, component):
    """Catch edits made inside a build snapshot, including newly added code."""
    directory = Path(directory)
    records = git(repository, "ls-tree", "-r", "-z", commit, binary=True).decode().split("\0")
    tracked, gitlinks = set(), set()
    for record in filter(None, records):
        metadata, name = record.split("\t", 1)
        mode, kind, object_id = metadata.split(" ")
        if kind == "commit":  # The parent gitlinks are validated separately.
            gitlinks.add(name)
            continue
        require(kind == "blob", "Unsupported committed source entry")
        tracked.add(name)
        file = directory / name
        require(file.exists() or file.is_symlink(), "Frozen source file is missing: " + name)
        if mode == "120000":
            require(file.is_symlink(), "Frozen source link changed: " + name)
            body = os.readlink(file).encode()
        else:
            require(file.is_file() and not file.is_symlink(), "Frozen source file changed: " + name)
            body = file.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest()
        if actual == object_id:
            continue
        normalized = body.replace(b"\r\n", b"\n")
        if normalized != body and hashlib.sha1(
                b"blob " + str(len(normalized)).encode() + b"\0" + normalized).hexdigest() == object_id:
            # git archive honors committed eol=crlf attributes (notably PS1).
            # Do not treat binary edits or arbitrary filter output as equivalent.
            rows = git(repository, "check-attr", "-z", "--source", commit, "text", "eol", "--", name,
                       binary=True).decode().split("\0")
            attributes = dict(zip(rows[1::3], rows[2::3]))
            if attributes.get("eol") == "crlf" and attributes.get("text") != "unset":
                continue
        if component == "cloudcli" and name == "package.json":
            original = json.loads(git(repository, "show", commit + ":" + name, binary=True))
            changed = json.loads(body)
            if changed.get("version") == source["codeyVersion"]:
                changed["version"] = original["version"]
                if changed == original:
                    continue
        raise RuntimeError("Frozen source differs from main: " + component + "/" + name)
    ignored_dirs = {"node_modules", ".git", "__pycache__", "dist", "dist-server", "dist-server.next", "coverage"}
    generated = {SOURCE_FILE, COMPONENT_FILE, "codey-release.json", ".eslintcache"}
    runtime_config = {"config/" + name for name in
                      ("nodes.aca.json", "cloudcli-nodes.aca.json", "node-data.aca.json", "codey-node-ca.pem")}
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs:
            link = Path(parent) / name
            if link.is_symlink() and name not in ignored_dirs:
                relative = link.relative_to(directory).as_posix()
                require(relative in tracked or relative in gitlinks,
                        "Untracked link in frozen source: " + component + "/" + relative)
        dirs[:] = [name for name in dirs if name not in ignored_dirs and not (Path(parent) / name).is_symlink()]
        for name in files:
            relative = (Path(parent) / name).relative_to(directory).as_posix()
            if relative in tracked or relative in generated:
                continue
            if component == "portal" and (relative in runtime_config or relative.startswith("public/downloads/")):
                continue
            require(False, "Untracked file in frozen source: " + component + "/" + relative)


def verify_source_files(root, source, directory):
    source = validate_source(source)
    for name, repository, commit in [
        ("portal", Path(root), source["commit"]),
        *((name, Path(root) / name, source["submodules"][name]) for name in COMPONENTS),
    ]:
        verify_source_tree(repository, commit, Path(directory) / name, source, name)


def verify_export(directory, expected=None):
    value = validate_source(json.loads((Path(directory) / "portal" / SOURCE_FILE).read_text()))
    require(expected is None or value == validate_source(expected), "Frozen main provenance changed")
    return value


if __name__ == "__main__":
    import argparse
    import os
    import secrets
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-commit")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(args.workspace).resolve()
    require(Path(__file__).resolve() == root / "skills/codey-deploy/scripts/release_source.py",
            "Use the source exporter from the selected production checkout")
    selected = select_main(root, "source-" + secrets.token_hex(8), args.source_commit)
    verify_tooling(root, selected)
    export_sources(root, selected, Path(args.output).resolve())
    print(json.dumps(selected))
