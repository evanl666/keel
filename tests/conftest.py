"""Fixtures: a fresh migrated database per test (SQLite by default, Postgres with KEEL_TEST_DATABASE_URL)."""

from __future__ import annotations

import os
import pathlib
import typing

import pytest
import sqlalchemy as sa

from keel import config, db, gateway, models
from keel.api import routes


@pytest.fixture
def database(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> typing.Iterator[str]:
    """Point Keel at an empty, migrated database."""
    pg = os.environ.get("KEEL_TEST_DATABASE_URL")
    url = pg or f"sqlite:///{tmp_path / 'keel.db'}"
    monkeypatch.setenv("KEEL_DATABASE_URL", url)
    monkeypatch.setenv("KEEL_SECRET_KEY", "test-secret-key-test-secret-key-0123456789")
    monkeypatch.delenv("KEEL_DEMO", raising=False)
    monkeypatch.setenv("KEEL_MODEL_PROVIDER", "")
    config.reset()
    db.reset()
    if pg:
        with db.engine().begin() as conn:
            conn.execute(sa.text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    db.migrate()
    yield url
    gateway.set_connector_factory(None)
    db.reset()
    config.reset()


@pytest.fixture
def team(database: str) -> models.Team:
    """An org with an admin and one team whose steward is at L2 Assist."""
    with db.session() as s:
        org = models.Org(name="Testco", settings={"default_level": 2})
        s.add(org)
        s.flush()
        admin = models.User(org_id=org.id, email="ada@test.example", name="Ada", role="org_admin")
        s.add(admin)
        s.flush()
        t = routes.create_team(
            s, org, routes.NewTeam(name="Payments", steward_name="Pip", slack_channel="#payments"), admin
        )
        s.expunge_all()
    return t


def get(model: type, row_id: str) -> typing.Any:
    """Fresh copy of a row."""
    with db.session() as s:
        row = s.get(model, row_id)
        s.expunge_all()
        return row
