"""Regression of the archived, non-default Windows recovery tools."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parents[1] /
                      "archive/config-new-codey-machine-legacy-tools-20260909/test/test_windows_codex_runtime.py"),
                   run_name="__main__")
