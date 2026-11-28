"""Passwords (scrypt) and signed session cookies."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import typing

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


# ---------------------------------------------------------------- setup code and sign-in throttling

IP_FAILURE_FACTOR = 4  # An office behind one NAT shares an IP; allow a few people's typos before blocking it.


def setup_code() -> str:
    """The code that proves the person creating the first admin can see the server (its log or its shell).

    Stable for a given secret key, so restarts don't change it. ``KEEL_SETUP_CODE`` overrides it.
    """
    cfg = config.get()
    if cfg.setup_code:
        return cfg.setup_code.strip()
    digest = hmac.new(cfg.effective_secret_key().encode(), b"keel-setup-code", hashlib.sha256).hexdigest()
    return f"{digest[:4]}-{digest[4:8]}".upper()


def setup_code_ok(given: str) -> bool:
    """Compare ignoring case, spaces and dashes."""

    def norm(x: str) -> str:
        return "".join(ch for ch in x.upper() if ch.isalnum())

    return hmac.compare_digest(norm(given or ""), norm(setup_code()))


def _window() -> typing.Any:
    import datetime as dt

    return dt.timedelta(minutes=config.get().login_lockout_minutes)


def login_wait_minutes(email: str, ip: str) -> int:
    """Minutes until this email (or IP) may try again; 0 when it may try now."""
    import sqlalchemy as sa

    from keel import db, models

    cfg = config.get()
    since = models.utcnow() - _window()
    with db.session() as s:
        rows = {
            key: (n, first)
            for key, n, first in s.execute(
                sa.select(models.LoginFailure.key, sa.func.count(), sa.func.min(models.LoginFailure.at))
                .where(
                    models.LoginFailure.key.in_([f"email:{email}", f"ip:{ip}"]),
                    models.LoginFailure.at > since,
                )
                .group_by(models.LoginFailure.key)
            )
        }
    limits = {
        f"email:{email}": cfg.login_max_failures,
        f"ip:{ip}": cfg.login_max_failures * IP_FAILURE_FACTOR,
    }
    wait = 0
    for key, (n, first) in rows.items():
        if n >= limits[key]:
            left = (first + _window() - models.utcnow()).total_seconds() / 60
            wait = max(wait, int(left) + 1)
    return wait


def record_login_failure(email: str, ip: str) -> None:
    """Remember a failed sign-in (in its own transaction, so a rolled-back request still counts)."""
    import sqlalchemy as sa

    from keel import db, models

    with db.session() as s:
        s.add_all([models.LoginFailure(key=f"email:{email}"), models.LoginFailure(key=f"ip:{ip}")])
        s.execute(
            sa.delete(models.LoginFailure).where(models.LoginFailure.at < models.utcnow() - 4 * _window())
        )


def clear_login_failures(email: str) -> None:
    """Forget an email's failures after it signs in."""
    import sqlalchemy as sa

    from keel import db, models

    with db.session() as s:
        s.execute(sa.delete(models.LoginFailure).where(models.LoginFailure.key == f"email:{email}"))
