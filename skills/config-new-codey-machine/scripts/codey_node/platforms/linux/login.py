"""Plan owner shell hooks that load the private Codey model environment."""
from pathlib import Path
import re

from ...common.config_files import Change, Owner, commit
from ...common.errors import SetupError


START = "# >>> Codey model API environment >>>"
END = "# <<< Codey model API environment <<<"


def _text(data):
    try:
        return (data or b"").decode("utf-8-sig")
    except UnicodeError:
        raise SetupError("Shell profiles must be UTF-8; original bytes were not changed") from None


def _encoded(text, original):
    return (b"\xef\xbb\xbf" if original and original.startswith(b"\xef\xbb\xbf") else b"") + text.encode()


def patch(text, provider_env):
    block = (
        f"{START}\n"
        f"if [ -r '{provider_env}' ]; then\n"
        f"  . '{provider_env}'\n"
        "  export CODEY_MODEL_API_KEY\n"
        "fi\n"
        f"{END}"
    )
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
    if pattern.search(text):
        return pattern.sub(lambda _match: block, text)
    return text.rstrip("\n") + ("\n\n" if text else "") + block + "\n"


def prepare(home, provider_env):
    owner = Owner.target(home)
    provider_env = owner.check(provider_env)
    changes = []
    login_profile = next((name for name in (".bash_profile", ".bash_login", ".profile")
                          if (owner.home / name).exists()), ".profile")
    for name in (login_profile, ".bashrc"):
        before = owner.read(owner.home / name)
        changes.append(Change(before, _encoded(patch(_text(before.data), provider_env), before.data)))
    return owner, changes


def report(changes):
    return {
        "files": [{"path": str(change.before.path), "action": (
            "replace-with-backup" if change.before.data is not None else "create"
        ) if change.changed else "unchanged"} for change in changes],
        "loads": "CODEY_MODEL_API_KEY from the owner-private provider.env; no key is copied into shell profiles",
    }


def apply(owner, changes):
    return {"applied": True, "backups": commit(owner, changes), **report(changes)}
