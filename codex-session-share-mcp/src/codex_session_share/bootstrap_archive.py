"""Build the pure-standard-library zero-install download client."""

from __future__ import annotations

import io
import zipfile
from functools import lru_cache
from pathlib import Path

_BOOTSTRAP_MODULES = (
    "__init__.py",
    "bootstrap.py",
    "bundle.py",
    "codex_store.py",
    "config_sync.py",
    "names.py",
)


@lru_cache(maxsize=1)
def build_bootstrap_zipapp() -> bytes:
    """Return a cached executable Python archive for session downloads."""

    package_root = Path(__file__).parent
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "__main__.py",
            "from codex_session_share.bootstrap import main\nmain()\n",
        )
        for filename in _BOOTSTRAP_MODULES:
            archive.write(
                package_root / filename,
                f"codex_session_share/{filename}",
            )
    return output.getvalue()
