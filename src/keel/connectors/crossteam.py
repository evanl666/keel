"""Steward-to-steward requests inside one Keel install. Idempotent: op_id is the commitment's source_ref."""

from __future__ import annotations

import datetime as dt

import sqlalchemy as sa

from keel import db, errors, ledger, models
from keel.connectors import base


class CrossTeamConnector:
    """Delivers a request into another team's ledger as a proposed commitment."""

    def execute(self, op: models.Operation) -> base.ExecResult:
        """Create (or find) the commitment in the target team, in its own transaction."""
        p = op.payload
        with db.session() as s:
            target = s.scalar(
                sa.select(models.Team).where(
                    models.Team.org_id == op.org_id, models.Team.slug == p["to_team"]
                )
            )
            if target is None:
                raise errors.ConnectorError(
                    errors.NOT_FOUND, f"There's no team called {p['to_team']}.", sent=False
                )
            requester = s.get(models.Team, op.team_id)
            target_steward = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == target.id))
            due = dt.datetime.fromisoformat(p["due_at"]) if p.get("due_at") else None
            c = ledger.create(
                s,
                team=target,
                title=p["title"],
                detail=p.get("detail", ""),
                due_at=due,
                requester_team=requester,
                requester_person=p.get("requester_person"),
                priority=p.get("priority", "normal"),
                source_kind="steward",
                source_ref=op.op_id,
                label=p.get("label", "internal"),
                actor=f"{requester.name if requester else 'another team'}'s steward",
                steward_name=target_steward.name if target_steward else None,
            )
            return base.ExecResult(remote_ref=f"/commitments/{c.key}")

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        """The ledger is local and authoritative."""
        with db.session() as s:
            c = ledger.by_source_ref(s, op.org_id, op.op_id)
            if c is not None:
                return base.ReconcileResult(base.Found.YES, remote_ref=f"/commitments/{c.key}")
        return base.ReconcileResult(base.Found.NO, line="The other team's ledger has no such request.")
