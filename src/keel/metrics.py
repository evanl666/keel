"""Prometheus gauges read from the database at scrape time, so every replica reports the same numbers."""

from __future__ import annotations

import logging
import threading
import typing

import prometheus_client
import sqlalchemy as sa
from prometheus_client import core

from keel import db, ledger, models

log = logging.getLogger(__name__)
_lock = threading.Lock()
_registered = False


class StateCollector:
    """Queue depth, open work, waiting approvals, stewards by level, stale knowledge."""

    def collect(self) -> typing.Iterator[core.Metric]:
        try:
            with db.session() as s:
                yield from self._collect(s)
        except Exception:  # A scrape must never fail because the DB blinked; /readyz reports that.
            log.debug("state metrics unavailable", exc_info=True)

    def _collect(self, s: sa.orm.Session) -> typing.Iterator[core.Metric]:
        jobs = core.GaugeMetricFamily(
            "keel_jobs_queued", "Jobs waiting or running, by kind.", labels=["kind"]
        )
        for kind, n in s.execute(
            sa.select(models.Job.kind, sa.func.count())
            .where(models.Job.status.in_(("queued", "running")))
            .group_by(models.Job.kind)
        ):
            jobs.add_metric([kind], n)
        yield jobs

        inbox = core.GaugeMetricFamily(
            "keel_inbox_unprocessed", "Inbound Slack/GitHub events not handled yet."
        )
        inbox.add_metric(
            [],
            s.scalar(
                sa.select(sa.func.count())
                .select_from(models.InboxEvent)
                .where(models.InboxEvent.processed_at.is_(None))
            )
            or 0,
        )
        yield inbox

        commitments = core.GaugeMetricFamily(
            "keel_commitments_open", "Open commitments by team.", labels=["team"]
        )
        approvals = core.GaugeMetricFamily(
            "keel_approvals_pending", "Drafts waiting for a person, by team.", labels=["team"]
        )
        stewards = core.GaugeMetricFamily(
            "keel_steward_level", "Each steward's level (0-5).", labels=["team"]
        )
        stale = core.GaugeMetricFamily(
            "keel_knowledge_stale", "Knowledge docs past their review date, by team.", labels=["team"]
        )
        today = models.utcnow().date()
        for team in s.scalars(sa.select(models.Team)):
            commitments.add_metric(
                [team.slug],
                s.scalar(
                    sa.select(sa.func.count())
                    .select_from(models.Commitment)
                    .where(
                        models.Commitment.owner_team_id == team.id,
                        models.Commitment.status.in_(ledger.OPEN_STATUSES),
                    )
                )
                or 0,
            )
            approvals.add_metric(
                [team.slug],
                s.scalar(
                    sa.select(sa.func.count())
                    .select_from(models.Approval)
                    .where(models.Approval.team_id == team.id, models.Approval.status == "pending")
                )
                or 0,
            )
            st = s.scalar(sa.select(models.Steward.level).where(models.Steward.team_id == team.id))
            if st is not None:
                stewards.add_metric([team.slug], st)
            stale.add_metric(
                [team.slug],
                s.scalar(
                    sa.select(sa.func.count())
                    .select_from(models.KnowledgeDoc)
                    .where(models.KnowledgeDoc.team_id == team.id, models.KnowledgeDoc.review_by < today)
                )
                or 0,
            )
        yield from (commitments, approvals, stewards, stale)


def ensure_registered() -> None:
    """Register the DB collector once per process."""
    global _registered
    with _lock:
        if not _registered:
            prometheus_client.REGISTRY.register(StateCollector())
            _registered = True


def serve_worker_metrics(port: int) -> bool:
    """Expose /metrics for ``keel worker`` (counters only; the web process reports DB state). False when off."""
    if not port:
        return False
    prometheus_client.start_http_server(port)
    log.info("worker metrics on :%d/metrics", port)
    return True
