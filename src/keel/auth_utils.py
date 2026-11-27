"""Passwords (scrypt) and signed session cookies."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

import itsdangerous

from keel import config

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1  # OWASP's scrypt baseline: ~50 ms per hash, 16 MiB memory.
SALT_BYTES = 16
SESSION_MAX_AGE_S = 14 * 24 * 3600  # Two weeks, then sign in again.
MIN_PASSWORD_CHARS = 10  # NIST 800-63B asks for at least 8; 10 adds margin for a team admin account.


def hash_password(password: str) -> str:
    """Hash a password for storage: ``scrypt$<salt>$<hash>`` (base64)."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check of ``password`` against a stored hash. False for a missing or malformed hash."""
    if not stored or not stored.startswith("scrypt$"):
        return False
    try:
        _, salt_b64, digest_b64 = stored.split("$")
        salt, digest = base64.b64decode(salt_b64), base64.b64decode(digest_b64)
    except ValueError:
        return False
    test = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P)
    return hmac.compare_digest(test, digest)


def check_new_password(password: str) -> None:
    """Raise ValueError with a plain reason if a new password is too weak."""
    if len(password) < MIN_PASSWORD_CHARS:
        raise ValueError(f"Use at least {MIN_PASSWORD_CHARS} characters.")


def _serializer() -> itsdangerous.URLSafeTimedSerializer:
    return itsdangerous.URLSafeTimedSerializer(config.get().effective_secret_key(), salt="keel-session")


def sign_session(user_id: str) -> str:
    """Cookie value for a signed-in user."""
    return _serializer().dumps({"u": user_id})


def read_session(value: str | None) -> str | None:
    """User id from a cookie, or None when missing, tampered with or expired."""
    if not value:
        return None
    try:
        data = _serializer().loads(value, max_age=SESSION_MAX_AGE_S)
    except itsdangerous.BadData:
        return None
    return data.get("u") if isinstance(data, dict) else None
