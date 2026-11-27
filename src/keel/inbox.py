"""Inbound events: store first (deduplicated), then process on the worker.

Slack and GitHub both redeliver. The unique (org, source, external_id) row makes a second delivery a no-op.
"""

from __future__ import annotations

import typing

import sqlalchemy as sa
from sqlalchemy import exc as sa_exc
from sqlalchemy import orm

from keel import feed, jobs, models


def record(session: orm.Session, org_id: str, team_id: str | None, source: str, external_id: str, kind: str,
           payload: dict[str, typing.Any]) -> models.InboxEvent | None:
    """Store an inbound event and queue it. Returns None when it was already received."""
    exists = session.scalar(sa.select(models.InboxEvent.id).where(
        models.InboxEvent.org_id == org_id, models.InboxEvent.source == source,
        models.InboxEvent.external_id == external_id))
    if exists is not None:
        feed.INBOX_EVENTS.labels(source=source, result="duplicate").inc()
        return None
    ev = models.InboxEvent(org_id=org_id, team_id=team_id, source=source, external_id=external_id, kind=kind,
                           payload=payload)
    try:
        with session.begin_nested():
            session.add(ev)
    except sa_exc.IntegrityError:
        feed.INBOX_EVENTS.labels(source=source, result="duplicate").inc()
        return None
    jobs.enqueue(session, org_id, "process_inbox", {"event": ev.id}, dedupe_key=f"inbox:{ev.id}")
    return ev


def team_for_channel(session: orm.Session, channel_id: str) -> models.Team | None:
    """The team whose home channel this is."""
    return session.scalar(sa.select(models.Team).where(models.Team.slack_channel_id == channel_id))


def team_for_repo(session: orm.Session, repo: str) -> models.Team | None:
    """The first team that lists ``owner/name`` among its repos."""
    for team in session.scalars(sa.select(models.Team)):
        if repo.lower() in [r.lower() for r in (team.github_repos or [])]:
            return team
    return None
