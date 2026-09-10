"""Copy only a platform's runtime dependencies; no installers, assets or credentials."""
from pathlib import Path

from ..common.errors import SetupError
from ..common.files import digest, protected_write
from .launcher import ENTRYPOINT, ordinary_path, runtime_files, validate_files


def bundle_hashes(bundle):
    return {str(Path(bundle["root"]) / relative): value for relative, value in bundle["fileHashes"].items()}


def install_bundle(scripts, destination, platform):
    scripts, destination = ordinary_path(scripts), ordinary_path(destination)
    files = runtime_files(platform)
    for relative in files:
        source = ordinary_path(scripts / relative)
        if not source.is_file() or source.stat().st_size > 128 * 1024:
            raise SetupError("The complete reviewed service modules are required")
    bundle = {
        "schema": 1, "platform": platform, "root": str(destination),
        "entrypoint": str(destination / ENTRYPOINT),
        "fileHashes": {relative: digest(scripts / relative) for relative in files},
    }
    if destination.exists():
        # Retry may reuse the identical bundle, never overwrite unknown/partial
        # files or change an already installed worker's dependency set.
        validate_files(bundle, platform)
        return bundle
    destination.mkdir(parents=True, mode=0o700)
    for relative in files:
        protected_write(destination / relative, (scripts / relative).read_bytes())
    validate_files(bundle, platform)
    return bundle
