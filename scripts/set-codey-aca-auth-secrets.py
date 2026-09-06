"""Use Azure CLI's in-process API so secret values never appear in OS argv."""
import json
import pathlib
import sys

from azure.cli.core import get_default_cli

secrets = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
result = get_default_cli().invoke([
    "containerapp", "secret", "set", "--name", "codey", "--resource-group", "zhn-devbox",
    "--secrets",
    "codey-password-account=" + json.dumps(secrets["credential"], separators=(",", ":")),
    "codey-workspace-sso=" + secrets["master"],
    "--only-show-errors", "--output", "none",
])
if result:
    raise SystemExit(result)
print("Updated only the two Codey authentication secrets; existing secrets retained.")
