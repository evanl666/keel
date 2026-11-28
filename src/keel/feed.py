"""Activity feed and audit log helpers, plus Prometheus metrics."""

from __future__ import annotations

import datetime as dt

import prometheus_client
import sqlalchemy as sa
from sqlalchemy import orm

from keel import models

OPS_TOTAL = prometheus_client.Counter(
    "keel_operations_total", "Operations by final status", ["kind", "status"]
)
OPS_DISPATCH_SECONDS = prometheus_client.Histogram(
    "keel_operation_dispatch_seconds", "Connector call time", ["kind"]
)
MODEL_CALLS = prometheus_client.Counter("keel_model_calls_total", "Model calls", ["purpose", "outcome"])
INBOX_EVENTS = prometheus_client.Counter("keel_inbox_events_total", "Inbound events", ["source", "result"])
JOBS = prometheus_client.Counter("keel_jobs_total", "Jobs run", ["kind", "outcome"])
SERVICE_UP = prometheus_client.Gauge("keel_service_up", "1 when the last check passed", ["team", "service"])
CANARY_TRIPS = prometheus_client.Counter("keel_canary_trips_total", "Leakage canaries tripped", ["team"])


def activity(
    session: orm.Session,
    org_id: str,
    team_id: str | None,
    kind: str,
    icon: str,
    text: str,
    link: str | None = None,
) -> models.Activity:
    """Append one line to the live activity feed."""
    item = models.Activity(org_id=org_id, team_id=team_id, kind=kind, icon=icon, text=text, link=link)
    session.add(item)
    return item


def audit(
    session: orm.Session,
    org_id: str,
    actor: str,
    action: str,
    target: str,
    detail: str = "",
    team_id: str | None = None,
) -> None:
    """Append an audit record. The app never edits or deletes these."""
    session.add(
        models.AuditLog(
            org_id=org_id, team_id=team_id, actor=actor, action=action, target=target, detail=detail
        )
    )


def prune_audit(session: orm.Session, keep_days: int) -> int:
    """Delete audit rows older than ``keep_days`` (0 keeps everything). The one sanctioned deletion."""
    if keep_days <= 0:
        return 0
    cutoff = models.utcnow() - dt.timedelta(days=keep_days)
    n = session.execute(sa.delete(models.AuditLog).where(models.AuditLog.at < cutoff)).rowcount or 0
    if n:
        audit(session, _org_id(session), "keel", "audit.pruned", f"{n} rows", f"older than {keep_days} days")
    return n


def _org_id(session: orm.Session) -> str:
    return session.scalar(sa.select(models.Org.id).order_by(models.Org.created_at)) or ""
