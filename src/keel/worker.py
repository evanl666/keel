"""Background worker: runs queued jobs and periodic timers. One process or many; the DB coordinates them."""

from __future__ import annotations

import datetime as dt
import logging
import os
import socket
import threading
import time
import typing

import sqlalchemy as sa

from keel import checkup, db, feed, gateway, jobs, models, rhythm, services, steward

log = logging.getLogger(__name__)

POLL_INTERVAL_S = 1.0  # Idle wait between queue polls; low enough that the UI feels live.
TIMER_INTERVAL_S = 5.0  # How often timers (service checks, briefs, stale leases) are evaluated.
NUDGE_INTERVAL = dt.timedelta(hours=1)  # Nudges are rate-limited per commitment anyway; hourly is plenty.
CLAIM_BATCH = 10

Handler = typing.Callable[[dict[str, typing.Any]], None]


def _dispatch(p: dict) -> None:
    gateway.dispatch(p["op"])


def _reconcile(p: dict) -> None:
    gateway.reconcile(p["op"], int(p.get("check", 1)))


def _inbox(p: dict) -> None:
    with db.session() as s:
        steward.process_inbox(p["event"], s)


def _check_service(p: dict) -> None:
    with db.session() as s:
        svc = s.get(models.Service, p["service"])
        if svc is not None:
            services.check(s, svc)


def _brief(p: dict) -> None:
    with db.session() as s:
        team = s.get(models.Team, p["team"])
        if team is not None:
            rhythm.make_brief(s, team, p.get("kind", "daily"))


def _checkup(p: dict) -> None:
    with db.session() as s:
        row = s.get(models.Checkup, p["checkup"])
        if row is not None and row.status == "running":
            checkup.run(s, row)


def _nudge(_p: dict) -> None:
    with db.session() as s:
        rhythm.nudge(s)


HANDLERS: dict[str, Handler] = {
    "dispatch": _dispatch,
    "reconcile": _reconcile,
    "process_inbox": _inbox,
    "check_service": _check_service,
    "brief": _brief,
    "checkup": _checkup,
    "nudge": _nudge,
}


def run_job(job_id: str) -> None:
    """Run one claimed job and record the outcome."""
    with db.session() as s:
        job = s.get(models.Job, job_id)
        if job is None:
            return
        kind, payload = job.kind, dict(job.payload)
    handler = HANDLERS.get(kind)
    try:
        if handler is None:
            raise ValueError(f"no handler for job kind {kind}")
        handler(payload)
    except Exception as exc:
        log.exception("job %s (%s) failed", job_id, kind)
        feed.JOBS.labels(kind=kind, outcome="error").inc()
        jobs.fail(job_id, f"{type(exc).__name__}: {exc}")
        return
    feed.JOBS.labels(kind=kind, outcome="ok").inc()
    jobs.finish(job_id)


def drain(max_rounds: int = 50, worker_id: str = "drain") -> int:
    """Run ready jobs until the queue is idle (tests, demo ticks). Returns jobs run."""
    ran = 0
    for _ in range(max_rounds):
        ids = jobs.claim(worker_id, CLAIM_BATCH)
        if not ids:
            break
        for job_id in ids:
            run_job(job_id)
            ran += 1
    return ran


def timers(now: dt.datetime | None = None, last_nudge: dict[str, dt.datetime] | None = None) -> None:
    """Schedule periodic work. Every enqueue is deduplicated, so several workers can run this safely."""
    now = now or models.utcnow()
    gateway.recover_stale(now)
    with db.session() as s:
        due = s.scalars(
            sa.select(models.Service).where(
                sa.or_(models.Service.next_check_at.is_(None), models.Service.next_check_at <= now)
            )
        )
        for svc in due:
            jobs.enqueue(
                s,
                svc.org_id,
                "check_service",
                {"service": svc.id},
                dedupe_key=f"check:{svc.id}:{int(now.timestamp()) // services.MIN_INTERVAL_S}",
            )
        for team_id, kind in rhythm.due_briefs(s, now):
            team = s.get(models.Team, team_id)
            if team is not None:
                jobs.enqueue(
                    s,
                    team.org_id,
                    "brief",
                    {"team": team_id, "kind": kind},
                    dedupe_key=f"brief:{team_id}:{kind}:{now:%Y-%m-%d}",
                )
        if (
            last_nudge is not None
            and now - last_nudge.get("at", dt.datetime.min.replace(tzinfo=dt.UTC)) >= NUDGE_INTERVAL
        ):
            org = s.scalar(sa.select(models.Org))
            if org is not None:
                jobs.enqueue(s, org.id, "nudge", {}, dedupe_key=f"nudge:{now:%Y-%m-%dT%H}")
            last_nudge["at"] = now


class Worker:
    """Polls the queue on a thread. ``start()`` for in-process use; ``run_forever()`` for ``keel worker``."""

    def __init__(self, name: str | None = None) -> None:
        self.id = name or f"{socket.gethostname()}:{os.getpid()}"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_nudge: dict[str, dt.datetime] = {}

    def loop_once(self) -> int:
        """One pass: timers if due, then a batch of jobs. Returns jobs run."""
        ids = jobs.claim(self.id, CLAIM_BATCH)
        for job_id in ids:
            if self._stop.is_set():
                break
            run_job(job_id)
        return len(ids)

    def run_forever(self) -> None:
        """Run until stopped."""
        log.info("worker %s started", self.id)
        next_timer = 0.0
        while not self._stop.is_set():
            try:
                if time.monotonic() >= next_timer:
                    timers(last_nudge=self._last_nudge)
                    next_timer = time.monotonic() + TIMER_INTERVAL_S
                if self.loop_once() == 0:
                    self._stop.wait(POLL_INTERVAL_S)
            except Exception:
                log.exception("worker loop error")
                self._stop.wait(TIMER_INTERVAL_S)
        log.info("worker %s stopped", self.id)

    def start(self) -> None:
        """Run on a daemon thread."""
        self._thread = threading.Thread(target=self.run_forever, name="keel-worker", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        """Ask the loop to stop and wait for the current job."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
