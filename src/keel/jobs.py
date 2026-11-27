"""Job queue in the database. Postgres uses FOR UPDATE SKIP LOCKED; SQLite uses a guarded update."""

from __future__ import annotations

import datetime as dt
import typing

import sqlalchemy as sa
from sqlalchemy import exc as sa_exc
from sqlalchemy import orm

from keel import db, models

JOB_LEASE = dt.timedelta(minutes=5)  # Longest a job may run before another worker may take it over.
MAX_JOB_ATTEMPTS = 5  # After this a job is parked as failed with its last error, for a human to see.
RETRY_BACKOFF_S = (5, 30, 120, 600)  # Grows so a down dependency isn't hammered; last value repeats.


def enqueue(session: orm.Session, org_id: str, kind: str, payload: dict[str, typing.Any] | None = None,
            run_at: dt.datetime | None = None, dedupe_key: str | None = None) -> models.Job | None:
    """Add a job. With ``dedupe_key``, a second enqueue while the first is pending is ignored (returns None)."""
    if dedupe_key is not None:
        existing = session.scalar(sa.select(models.Job).where(models.Job.dedupe_key == dedupe_key))
        if existing is not None:
            if existing.status in ("queued", "running"):
                return None
            session.delete(existing)
            session.flush()
    job = models.Job(org_id=org_id, kind=kind, payload=payload or {}, run_at=run_at or models.utcnow(),
                     dedupe_key=dedupe_key)
    try:
        with session.begin_nested():
            session.add(job)
    except sa_exc.IntegrityError:
        return None
    return job


def claim(worker_id: str, limit: int = 10) -> list[str]:
    """Claim up to ``limit`` ready jobs for ``worker_id``; returns their ids."""
    now = models.utcnow()
    ready = sa.or_(
        sa.and_(models.Job.status == "queued", models.Job.run_at <= now),
        sa.and_(models.Job.status == "running", models.Job.lease_until < now),
    )
    with db.session() as s:
        q = sa.select(models.Job.id).where(ready).order_by(models.Job.run_at).limit(limit)
        if db.is_postgres():
            q = q.with_for_update(skip_locked=True)
        ids = list(s.scalars(q))
        claimed: list[str] = []
        for job_id in ids:
            res = s.execute(
                sa.update(models.Job)
                .where(models.Job.id == job_id, ready)
                .values(status="running", locked_by=worker_id, lease_until=now + JOB_LEASE,
                        attempts=models.Job.attempts + 1)
            )
            if res.rowcount == 1:
                claimed.append(job_id)
    return claimed


def finish(job_id: str) -> None:
    """Mark a job done."""
    with db.session() as s:
        s.execute(sa.update(models.Job).where(models.Job.id == job_id).values(status="done", lease_until=None))


def fail(job_id: str, error: str) -> None:
    """Record a failure; requeue with backoff until MAX_JOB_ATTEMPTS, then park it as failed."""
    with db.session() as s:
        job = s.get(models.Job, job_id)
        if job is None:
            return
        job.last_error = error[:2000]
        if job.attempts >= MAX_JOB_ATTEMPTS:
            job.status = "failed"
        else:
            delay = RETRY_BACKOFF_S[min(job.attempts - 1, len(RETRY_BACKOFF_S) - 1)]
            job.status, job.run_at = "queued", models.utcnow() + dt.timedelta(seconds=delay)
        job.lease_until = None


def depth(session: orm.Session) -> int:
    """Number of jobs waiting or running."""
    return session.scalar(sa.select(sa.func.count()).select_from(models.Job).where(
        models.Job.status.in_(("queued", "running")))) or 0
