#!/usr/bin/env python3
"""Add GPT-6 Astra to a Codex catalog and make it the active model."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MODEL_ID = "gpt-6-astra"
DISPLAY_NAME = "GPT-6 Astra"
CONTEXT_WINDOW = 872_000
MAX_CONTEXT_WINDOW = 1_000_000
AUTO_COMPACT_TOKEN_LIMIT = 722_000
REASONING_EFFORT = "max"
SUPPORTED_REASONING_EFFORTS = ("low", "medium", "high", "xhigh", "max")

REASONING_DESCRIPTIONS = {
    "low": "Fast responses with lighter reasoning",
    "medium": "Balances speed and reasoning depth",
    "high": "Greater reasoning depth for complex problems",
    "xhigh": "Extra high reasoning depth for complex problems",
    "max": "Maximum reasoning depth",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
        help="Codex configuration directory; defaults to CODEX_HOME or ~/.codex.",
    )
    return parser.parse_args()


def next_backup_path(path: Path, timestamp: str) -> Path:
    base = path.with_name(f"{path.name}.backup-{timestamp}-{MODEL_ID}")
    if not base.exists():
        return base

    for index in range(2, 100):
        candidate = path.with_name(f"{base.name}-{index}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not allocate a backup path for {path}")


def backup_file(path: Path, timestamp: str) -> Path:
    backup = next_backup_path(path, timestamp)
    shutil.copy2(path, backup)
    return backup


def atomic_write(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    original_mode = stat.S_IMODE(path.stat().st_mode)
    try:
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        os.chmod(temporary, original_mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def set_root_toml_value(lines: list[str], key: str, value: str) -> None:
    table_start = next(
        (index for index, line in enumerate(lines) if line.lstrip().startswith("[")),
        len(lines),
    )
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=")
    for index in range(table_start):
        if pattern.match(lines[index]):
            lines[index] = f"{key} = {value}"
            return
    lines.insert(0, f"{key} = {value}")


def update_config(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.splitlines()

    set_root_toml_value(lines, "model", json.dumps(MODEL_ID))
    set_root_toml_value(lines, "model_reasoning_effort", json.dumps(REASONING_EFFORT))
    set_root_toml_value(lines, "model_context_window", str(CONTEXT_WINDOW))

    atomic_write(path, newline.join(lines) + newline)


def build_model_entry(template: dict[str, Any], priority: int) -> dict[str, Any]:
    model = copy.deepcopy(template)
    model.update(
        {
            "slug": MODEL_ID,
            "display_name": DISPLAY_NAME,
            "description": "GPT-6 Astra coding model with an 872K prompt context.",
            "default_reasoning_level": REASONING_EFFORT,
            "priority": priority,
            "context_window": CONTEXT_WINDOW,
            "max_context_window": MAX_CONTEXT_WINDOW,
            "auto_compact_token_limit": AUTO_COMPACT_TOKEN_LIMIT,
            # 872K is already the requested usable prompt context, so do not
            # apply the 95% reduction used by the 1.05M GPT-5.6 catalog rows.
            "effective_context_window_percent": 100,
        }
    )
    model["supported_reasoning_levels"] = [
        {
            "effort": effort,
            "description": REASONING_DESCRIPTIONS[effort],
        }
        for effort in SUPPORTED_REASONING_EFFORTS
    ]

    instructions = model.get("base_instructions")
    if isinstance(instructions, str):
        model["base_instructions"] = instructions.replace(
            "based on GPT-5.",
            "based on GPT-6.",
            1,
        )
    return model


def update_models(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    payload = json.loads(raw)
    models = payload.get("models")
    if not isinstance(models, list) or not models:
        raise RuntimeError(f"{path} does not contain a non-empty models list")

    template = next(
        (
            model
            for model in models
            if isinstance(model, dict) and model.get("slug") == "gpt-5.6-sol-fast"
        ),
        None,
    )
    if template is None:
        template = next((model for model in models if isinstance(model, dict)), None)
    if template is None:
        raise RuntimeError(f"{path} has no usable model template")

    priorities = [
        model.get("priority")
        for model in models
        if isinstance(model, dict) and isinstance(model.get("priority"), int)
    ]
    priority = max(priorities, default=100) + 10
    gpt6 = build_model_entry(template, priority)

    payload["models"] = [
        gpt6,
        *[
            model
            for model in models
            if not isinstance(model, dict) or model.get("slug") != MODEL_ID
        ],
    ]
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + newline
    atomic_write(path, serialized)


def main() -> int:
    args = parse_args()
    codex_home = args.codex_home.expanduser().resolve()
    config_path = codex_home / "config.toml"
    models_path = codex_home / "models.json"
    for required in (config_path, models_path):
        if not required.is_file():
            raise FileNotFoundError(required)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    config_backup = backup_file(config_path, timestamp)
    models_backup = backup_file(models_path, timestamp)
    update_config(config_path)
    update_models(models_path)

    print(f"codex_home={codex_home}")
    print(f"config_backup={config_backup}")
    print(f"models_backup={models_backup}")
    print(f"model={MODEL_ID}")
    print(f"model_reasoning_effort={REASONING_EFFORT}")
    print(f"model_context_window={CONTEXT_WINDOW}")
    print(f"model_max_context_window={MAX_CONTEXT_WINDOW}")
    print(f"model_auto_compact_token_limit={AUTO_COMPACT_TOKEN_LIMIT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
