"""The commitments ledger: who promised what to whom, by when."""

from __future__ import annotations

import datetime as dt
import zoneinfo

import sqlalchemy as sa
from sqlalchemy import orm

from keel import db, feed, models

AT_RISK_WINDOW = dt.timedelta(hours=48)  # Two working days: enough warning to renegotiate a date.
OPEN_STATUSES = ("proposed", "accepted", "in_progress", "blocked")
CLOSED_STATUSES = ("done", "dropped", "declined")
STATUSES = OPEN_STATUSES + CLOSED_STATUSES
PRIORITIES = ("low", "normal", "high", "urgent")


def day(when: dt.datetime, tz: str = "UTC", fmt: str = "%a %b %d") -> str:
    """Format a stored UTC time as a day in the team's timezone, e.g. "Fri Nov 27".

    Messages name the day people see on their own calendar; formatting the UTC value directly can be a day
    off for teams far from UTC. Naive values are treated as UTC (SQLite drops the offset). `fmt` is a strftime
    pattern, e.g. "%Y-%m-%d" for machine-readable output.
    """
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.UTC)
    try:
        zone = zoneinfo.ZoneInfo(tz or "UTC")
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        zone = zoneinfo.ZoneInfo("UTC")
    return when.astimezone(zone).strftime(fmt)


def team_tz(session: orm.Session, team_id: str | None) -> str:
    """The team's timezone name, or UTC when unknown."""
    team = session.get(models.Team, team_id) if team_id else None
    return team.timezone if team is not None and team.timezone else "UTC"


def risk(c: models.Commitment, now: dt.datetime | None = None) -> str:
    """Return on_track | at_risk | overdue | none for a commitment."""
    if c.status in CLOSED_STATUSES:
        return "none"
    now = now or models.utcnow()
    if c.due_at is None:
        return "at_risk" if c.status == "blocked" else "none"
    if c.due_at < now:
        return "overdue"
    if c.status == "blocked":
        return "at_risk"
    if c.due_at - now <= AT_RISK_WINDOW and c.status in ("proposed", "accepted"):
        return "at_risk"
    return "on_track"


def next_key(session: orm.Session, org_id: str) -> str:
    """Allocate the next ``C-<n>`` key for the org (row-locked on Postgres)."""
    q = sa.select(models.Org).where(models.Org.id == org_id)
    if db.is_postgres():
        q = q.with_for_update()
    org = session.scalar(q)
    if org is None:
        raise ValueError(f"no org {org_id}")
    org.commitment_seq += 1
    session.flush()
    return f"C-{org.commitment_seq}"


def by_source_ref(session: orm.Session, org_id: str, source_ref: str) -> models.Commitment | None:
    """Find a commitment created from the same source (dedupe across retries)."""
    return session.scalar(
        sa.select(models.Commitment).where(
            models.Commitment.org_id == org_id, models.Commitment.source_ref == source_ref
        )
    )


def create(
    session: orm.Session,
    *,
    team: models.Team,
    title: str,
    actor: str,
    detail: str = "",
    due_at: dt.datetime | None = None,
    owner_person: str | None = None,
    requester_person: str | None = None,
    requester_team: models.Team | None = None,
    priority: str = "normal",
    status: str = "proposed",
    source_kind: str = "web",
    source_url: str | None = None,
    source_ref: str | None = None,
    label: str = "internal",
    steward_name: str | None = None,
) -> models.Commitment:
    """Log a new commitment. With ``source_ref``, an existing one from the same source is returned instead."""
    if not title.strip():
        raise ValueError("A commitment needs a title.")
    if priority not in PRIORITIES:
        raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}")
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    if source_ref:
        existing = by_source_ref(session, team.org_id, source_ref)
        if existing is not None:
            return existing
    c = models.Commitment(
        org_id=team.org_id,
        key=next_key(session, team.org_id),
        owner_team_id=team.id,
        requester_team_id=requester_team.id if requester_team else None,
        title=title.strip()[:300],
        detail=detail,
        status=status,
        priority=priority,
        owner_person=owner_person,
        requester_person=requester_person,
        due_at=due_at,
        source_kind=source_kind,
        source_url=source_url,
        source_ref=source_ref,
        label=label,
    )
    session.add(c)
    session.flush()
    who = f" from {requester_team.name}" if requester_team else ""
    add_event(session, c, actor, "created", f"Logged{who}: {c.title}")
    by = steward_name or actor
    feed.activity(
        session,
        c.org_id,
        team.id,
        "commitment",
        "📌",
        f"{by} logged {c.key} for {team.name}: {c.title}",
        f"/commitments/{c.key}",
    )
    if requester_team is not None:
        feed.activity(
            session,
            c.org_id,
            requester_team.id,
            "commitment",
            "📤",
            f"{requester_team.name} asked {team.name}: {c.title} ({c.key})",
            f"/commitments/{c.key}",
        )
    return c


def add_event(session: orm.Session, c: models.Commitment, actor: str, kind: str, text: str) -> None:
    """Append to a commitment's timeline."""
    session.add(
        models.CommitmentEvent(org_id=c.org_id, commitment_id=c.id, actor=actor, kind=kind, text=text)
    )


def update(
    session: orm.Session,
    c: models.Commitment,
    actor: str,
    *,
    status: str | None = None,
    due_at: dt.datetime | None = None,
    owner_person: str | None = None,
    priority: str | None = None,
    note: str | None = None,
    clear_due: bool = False,
) -> models.Commitment:
    """Change fields and record each change on the timeline."""
    if status is not None and status != c.status:
        if status not in STATUSES:
            raise ValueError(f"status must be one of {', '.join(STATUSES)}")
        add_event(session, c, actor, "status", f"{c.status.replace('_', ' ')} → {status.replace('_', ' ')}")
        c.status = status
        c.closed_at = models.utcnow() if status in CLOSED_STATUSES else None
        icon = {"done": "✅", "dropped": "🗑️", "declined": "🙅", "blocked": "🧱", "accepted": "🤝"}.get(
            status, "🔄"
        )
        feed.activity(
            session,
            c.org_id,
            c.owner_team_id,
            "commitment",
            icon,
            f"{c.key} is now {status.replace('_', ' ')}: {c.title}",
            f"/commitments/{c.key}",
        )
    if clear_due and c.due_at is not None:
        add_event(session, c, actor, "due", "Due date removed")
        c.due_at = None
    elif due_at is not None and due_at != c.due_at:
        add_event(session, c, actor, "due", f"Due {day(due_at, team_tz(session, c.owner_team_id))}")
        c.due_at = due_at
    if owner_person is not None and owner_person != c.owner_person:
        add_event(session, c, actor, "owner", f"Owner: {owner_person}")
        c.owner_person = owner_person
    if priority is not None and priority != c.priority:
        if priority not in PRIORITIES:
            raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}")
        add_event(session, c, actor, "priority", f"Priority: {priority}")
        c.priority = priority
    if note:
        add_event(session, c, actor, "note", note)
    c.updated_at = models.utcnow()
    return c


def get(session: orm.Session, org_id: str, key: str) -> models.Commitment | None:
    """Look up by key, case-insensitively (``c-88`` works)."""
    return session.scalar(
        sa.select(models.Commitment).where(
            models.Commitment.org_id == org_id, models.Commitment.key == key.upper()
        )
    )


def open_for_team(session: orm.Session, team_id: str) -> list[models.Commitment]:
    """Open commitments a team owns, soonest due first."""
    return list(
        session.scalars(
            sa.select(models.Commitment)
            .where(models.Commitment.owner_team_id == team_id, models.Commitment.status.in_(OPEN_STATUSES))
            .order_by(models.Commitment.due_at.is_(None), models.Commitment.due_at)
        )
    )
