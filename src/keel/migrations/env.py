"""Alembic environment. Uses the connection passed by keel.db.migrate when present."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import context

from keel import models

target_metadata = models.Base.metadata


def run() -> None:
    """Run migrations online, on Keel's connection or a fresh one."""
    connection = context.config.attributes.get("connection")
    if connection is not None:
        _run_on(connection)
        return
    engine = sa.create_engine(context.config.get_main_option("sqlalchemy.url"))
    with engine.connect() as conn:
        _run_on(conn)
        conn.commit()


def _run_on(connection: sa.Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=connection.dialect.name == "sqlite",
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


run()
