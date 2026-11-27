"""Encrypt connector secrets at rest with a key derived from KEEL_SECRET_KEY."""

from __future__ import annotations

import base64
import hashlib
import json

from cryptography import fernet

from keel import config

KDF_SALT = b"keel-connection-secrets-v1"  # Fixed: rotating it would orphan stored secrets.
KDF_ITERATIONS = 200_000  # OWASP-range PBKDF2 cost; runs once per process, so speed doesn't matter.

_fernet: fernet.Fernet | None = None


def _box() -> fernet.Fernet:
    global _fernet
    if _fernet is None:
        raw = hashlib.pbkdf2_hmac("sha256", config.get().effective_secret_key().encode(), KDF_SALT, KDF_ITERATIONS)
        _fernet = fernet.Fernet(base64.urlsafe_b64encode(raw))
    return _fernet


def reset() -> None:
    """Forget the derived key (tests that change KEEL_SECRET_KEY)."""
    global _fernet
    _fernet = None


def seal(values: dict[str, str]) -> str:
    """Encrypt a dict of secrets. An empty dict seals to an empty string."""
    if not values:
        return ""
    return _box().encrypt(json.dumps(values).encode()).decode()


def unseal(token: str) -> dict[str, str]:
    """Decrypt :func:`seal` output. An empty string gives an empty dict."""
    if not token:
        return {}
    return json.loads(_box().decrypt(token.encode()))


def mask(value: str) -> str:
    """Show only the last 4 characters of a secret."""
    if not value:
        return ""
    return "•" * 8 + value[-4:]
