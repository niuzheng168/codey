"""Validation for human-readable session storage names."""

from __future__ import annotations

import re

SESSION_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHARED_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,128}$")
CONFIG_PROFILE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def validate_session_name(value: str) -> str:
    """Return a normalized safe path component or raise ``ValueError``."""

    value = value.strip()
    if not SESSION_NAME_PATTERN.fullmatch(value):
        raise ValueError(
            "session names must be 1-128 characters, start with a letter or number, "
            "and contain only letters, numbers, '.', '_', or '-'"
        )
    return value


def validate_shared_name(value: str) -> str:
    """Validate a user-selected name for a newly shared session."""

    if not SHARED_NAME_PATTERN.fullmatch(value):
        raise ValueError(
            "shared session names must be 1-128 characters and contain only "
            "letters, numbers, or '_'"
        )
    return value


def validate_config_profile(value: str) -> str:
    """Validate a private per-user configuration profile name."""

    value = value.strip()
    if not CONFIG_PROFILE_PATTERN.fullmatch(value):
        raise ValueError(
            "config profile names must be 1-64 characters, start with a letter or number, "
            "and contain only letters, numbers, '.', '_', or '-'"
        )
    return value
