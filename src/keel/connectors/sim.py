"""Simulated Slack and GitHub for the demo. Records writes in the database; can inject faults."""

from __future__ import annotations

import sqlalchemy as sa

from keel import db, errors, models
from keel.connectors import base

# Faults the demo script can request via payload["_sim_fault"]:
#   "503_after_commit"  – the write lands, then the response is lost (the dangerous case).
#   "503_before_commit" – the server fails before writing.
#   "403" / "401"       – permission denied / credential invalid.
FAULT_AFTER_COMMIT = "503_after_commit"


class SimConnector:
    """Stands in for Slack/GitHub in demo mode. Every write becomes a SimRecord row.

    It commits in its own session, like a remote system would: Keel's rollback can't undo it.
    """

    def __init__(self, org_id: str) -> None:
        self.org_id = org_id

    def execute(self, op: models.Operation) -> base.ExecResult:
        """Record the write, honouring an injected fault on the first attempt only."""
        system = op.kind.split(".")[0]
        fault = op.payload.get("_sim_fault") if op.attempts <= 1 else None
        if fault == "503_before_commit":
            raise errors.classify_http(system.title(), 503)
        if fault == "403":
            raise errors.classify_http(system.title(), 403, "Resource not accessible by integration")
        if fault == "401":
            raise errors.classify_http(system.title(), 401, "Bad credentials")
        ref = self._write(op, system)
        if fault == FAULT_AFTER_COMMIT:
            raise errors.classify_http("GitHub" if system == "github" else "Slack", 503)
        return base.ExecResult(remote_ref=ref)

    def _write(self, op: models.Operation, system: str) -> str:
        with db.session() as remote:
            return self._write_in(remote, op, system)

    def _write_in(self, remote, op: models.Operation, system: str) -> str:
        count = remote.scalar(sa.select(sa.func.count()).select_from(models.SimRecord).where(
            models.SimRecord.org_id == self.org_id, models.SimRecord.system == system)) or 0
        p = op.payload
        if system == "github":
            ref = f"https://github.example/{p.get('repo', 'acme/app')}/issues/{1200 + count}"
            text = f"{p.get('title', '')}\n{p.get('body', '')}"
        else:
            ref = f"slack://{p.get('channel', op.target)}/{count + 1}"
            text = p.get("text", "")
        remote.add(models.SimRecord(org_id=self.org_id, system=system, target=op.target, text=text,
                                    op_id=op.op_id, ref=ref))
        return ref

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        """The simulator's listing is authoritative: look up by op_id."""
        with db.session() as remote:
            rec = remote.scalar(sa.select(models.SimRecord).where(models.SimRecord.org_id == self.org_id,
                                                                  models.SimRecord.op_id == op.op_id))
        if rec is not None:
            return base.ReconcileResult(base.Found.YES, remote_ref=rec.ref, line="Found it: the write went through.")
        return base.ReconcileResult(base.Found.NO, line="Not there: the write never landed.")
