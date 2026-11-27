"""Engine, sessions and schema migrations."""

from __future__ import annotations

import contextlib
import logging
import pathlib
import typing

import sqlalchemy as sa
from sqlalchemy import orm

from keel import config

log = logging.getLogger(__name__)

MIGRATION_LOCK_ID = 74_211_337  # Arbitrary constant for pg_advisory_lock; only Keel's migrator uses it.
SQLITE_BUSY_TIMEOUT_S = 30  # Demo runs web + worker threads on one SQLite file; wait instead of failing.

_engine: sa.Engine | None = None
_sessionmaker: orm.sessionmaker[orm.Session] | None = None


def engine() -> sa.Engine:
    """Return the process-wide engine, creating it on first use."""
    global _engine, _sessionmaker
    if _engine is None:
        settings = config.get()
        url = settings.database_url
        kwargs: dict[str, typing.Any] = {"future": True}
        if settings.is_sqlite:
            path = url.removeprefix("sqlite:///")
            if path and path != ":memory:":
                pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": SQLITE_BUSY_TIMEOUT_S}
        else:
            kwargs.update(pool_pre_ping=True, pool_size=10, max_overflow=20)
        _engine = sa.create_engine(url, **kwargs)
        if settings.is_sqlite:
            sa.event.listen(_engine, "connect", _sqlite_pragmas)
        _sessionmaker = orm.sessionmaker(_engine, expire_on_commit=False)
    return _engine


def _sqlite_pragmas(dbapi_conn: typing.Any, _record: typing.Any) -> None:
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def reset() -> None:
    """Dispose the engine (tests, CLI switching databases)."""
    global _engine, _sessionmaker
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _sessionmaker = None


def is_postgres() -> bool:
    """True when connected to Postgres."""
    return engine().dialect.name == "postgresql"


def new_session() -> orm.Session:
    """Open a new session. Caller commits/closes; prefer :func:`session`."""
    engine()
    assert _sessionmaker is not None
    return _sessionmaker()


@contextlib.contextmanager
def session() -> typing.Iterator[orm.Session]:
    """Session that commits on success and rolls back on error."""
    s = new_session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def alembic_config() -> typing.Any:
    """Alembic config pointing at the packaged migrations."""
    from alembic import config as alembic_cfg

    cfg = alembic_cfg.Config()
    cfg.set_main_option("script_location", str(pathlib.Path(__file__).parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", config.get().database_url.replace("%", "%%"))
    return cfg


def migrate() -> None:
    """Upgrade the schema to head. Safe with many replicas: Postgres runs it under an advisory lock."""
    from alembic import command

    cfg = alembic_config()
    eng = engine()
    with eng.connect() as conn:
        if eng.dialect.name == "postgresql":
            conn.execute(sa.text("SELECT pg_advisory_lock(:k)"), {"k": MIGRATION_LOCK_ID})
            conn.commit()
        try:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
            conn.commit()
        finally:
            if eng.dialect.name == "postgresql":
                conn.execute(sa.text("SELECT pg_advisory_unlock(:k)"), {"k": MIGRATION_LOCK_ID})
                conn.commit()


def current_revision() -> str | None:
    """Return the applied schema revision, or None for an empty database."""
    from alembic.runtime import migration

    with engine().connect() as conn:
        return migration.MigrationContext.configure(conn).get_current_revision()


def head_revision() -> str:
    """Return the newest revision shipped with this version of Keel."""
    from alembic import script

    head = script.ScriptDirectory.from_config(alembic_config()).get_current_head()
    assert head is not None
    return head


def ping() -> bool:
    """Return True when the database answers a trivial query."""
    try:
        with engine().connect() as conn:
            conn.execute(sa.text("SELECT 1"))
        return True
    except sa.exc.SQLAlchemyError:
        return False
