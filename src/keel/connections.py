"""Resolve integration settings: environment variables win, then what the setup wizard stored."""

from __future__ import annotations

import dataclasses

import sqlalchemy as sa
from sqlalchemy import orm

from keel import config, models, vault


@dataclasses.dataclass
class Resolved:
    """Effective settings for one integration."""

    kind: str
    config: dict[str, str]
    secrets: dict[str, str]
    source: str  # "env" | "db" | "none"

    @property
    def configured(self) -> bool:
        """True when any credential is present."""
        return self.source != "none"


def _env(kind: str) -> Resolved | None:
    s = config.get()
    if kind == "slack" and s.slack_bot_token:
        return Resolved("slack", {}, {"bot_token": s.slack_bot_token, "app_token": s.slack_app_token,
                                      "signing_secret": s.slack_signing_secret}, "env")
    if kind == "github" and (s.github_token or s.github_app_id):
        return Resolved("github", {"app_id": s.github_app_id, "installation_id": s.github_installation_id,
                                   "api_url": s.github_api_url},
                        {"token": s.github_token, "private_key": s.github_app_private_key}, "env")
    if kind == "model" and s.model_provider:
        return Resolved("model", {"provider": s.model_provider, "model": s.model_name, "base_url": s.model_base_url},
                        {"api_key": s.model_api_key}, "env")
    return None


def resolve(session: orm.Session, org_id: str, kind: str) -> Resolved:
    """Return effective settings for ``kind`` (slack | github | model)."""
    env = _env(kind)
    if env is not None:
        return env
    row = session.scalar(sa.select(models.Connection).where(models.Connection.org_id == org_id,
                                                            models.Connection.kind == kind))
    if row is None:
        return Resolved(kind, {}, {}, "none")
    return Resolved(kind, dict(row.config), vault.unseal(row.secret_enc), "db")


def store(session: orm.Session, org_id: str, kind: str, cfg: dict[str, str], secrets: dict[str, str]) -> None:
    """Save settings from the setup wizard. Empty secret values keep the stored ones."""
    row = session.scalar(sa.select(models.Connection).where(models.Connection.org_id == org_id,
                                                            models.Connection.kind == kind))
    if row is None:
        row = models.Connection(org_id=org_id, kind=kind)
        session.add(row)
    old = vault.unseal(row.secret_enc) if row.secret_enc else {}
    merged = {**old, **{k: v for k, v in secrets.items() if v}}
    row.config = cfg
    row.secret_enc = vault.seal(merged)
    row.status, row.status_line = "ok", ""


def mark(session: orm.Session, org_id: str, kind: str, status: str, line: str) -> None:
    """Record a connection's health (e.g. after a 401) so the UI shows why on its row."""
    row = session.scalar(sa.select(models.Connection).where(models.Connection.org_id == org_id,
                                                            models.Connection.kind == kind))
    if row is not None:
        row.status, row.status_line = status, line
