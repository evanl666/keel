"""The write path: outbox intent, unknown outcomes, the crash boundary, reconciliation, gates and runners."""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
import sqlalchemy as sa

from keel import db, errors, gateway, models, worker
from keel.connectors import base


class Remote:
    """A fake remote system that records writes by op_id and can fail in chosen ways."""

    def __init__(self, checkable: bool = True) -> None:
        self.writes: list[str] = []
        self.faults: list[str] = []
        self.checkable = checkable

    def factory(self, _session, _op):
        return self

    def execute(self, op: models.Operation) -> base.ExecResult:
        fault = self.faults.pop(0) if self.faults else None
        if fault == "503_before":
            raise errors.classify_http("Slack", 503)
        if fault == "unreachable":
            raise errors.classify_transport("Slack", ConnectionRefusedError(), sent=False)
        self.writes.append(op.op_id)
        if fault == "503_after":
            raise errors.classify_http("Slack", 503)
        if fault == "crash_after":
            raise KeyboardInterrupt("process died after the remote write, before the local ack")
        return base.ExecResult(remote_ref=f"ref:{op.op_id}")

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        if not self.checkable:
            return base.ReconcileResult(base.Found.UNSURE, line="This system has no listing to check.")
        if op.op_id in self.writes:
            return base.ReconcileResult(base.Found.YES, remote_ref=f"ref:{op.op_id}", line="Found it.")
        return base.ReconcileResult(base.Found.NO, line="Not there.")


@pytest.fixture
def remote(team: models.Team) -> Remote:
    r = Remote()
    gateway.set_connector_factory(r.factory)
    return r


def _propose(team: models.Team, *, text: str = "Heads up: deploy at 3pm", kind: str = "slack.post_team",
             label: str = "internal", audience_kind: str = "team", actor: str = "steward") -> str:
    with db.session() as s:
        t = s.get(models.Team, team.id)
        op = gateway.propose(s, gateway.Proposal(team=t, kind=kind, target="#payments", payload={"text": text},
                                                 summary=text[:60], op_id=f"test:{uuid.uuid4()}", label=label,
                                                 audience_kind=audience_kind, actor=actor))
        return op.id


def _op(op_id: str) -> models.Operation:
    with db.session() as s:
        op = s.get(models.Operation, op_id)
        s.expunge(op)
        return op


def _run_due_jobs_now() -> None:
    """Drain, pulling delayed reconcile jobs forward so the test needn't wait RECONCILE_DELAY."""
    for _ in range(6):
        with db.session() as s:
            s.execute(sa.update(models.Job).where(models.Job.status == "queued").values(run_at=models.utcnow()))
        if worker.drain() == 0:
            return


def test_propose_is_idempotent_on_op_id(team: models.Team, remote: Remote) -> None:
    with db.session() as s:
        t = s.get(models.Team, team.id)
        p = gateway.Proposal(team=t, kind="slack.post_team", target="#payments", payload={"text": "hi"}, summary="hi",
                             op_id="same-id")
        first = gateway.propose(s, p).id
        assert gateway.propose(s, p).id == first
        assert s.scalar(sa.select(sa.func.count()).select_from(models.Operation)) == 1


def test_happy_path_sends_once(team: models.Team, remote: Remote) -> None:
    op_id = _propose(team)
    _run_due_jobs_now()
    assert _op(op_id).status == "done"
    assert len(remote.writes) == 1


def test_503_after_remote_commit_is_reconciled_not_resent(team: models.Team, remote: Remote) -> None:
    remote.faults = ["503_after"]
    op_id = _propose(team)
    worker.drain()
    assert _op(op_id).status == "unknown"
    _run_due_jobs_now()
    op = _op(op_id)
    assert op.status == "reconciled"
    assert remote.writes.count(op.op_id) == 1


def test_503_before_commit_is_checked_then_sent_once(team: models.Team, remote: Remote) -> None:
    remote.faults = ["503_before"]
    op_id = _propose(team)
    _run_due_jobs_now()
    op = _op(op_id)
    assert op.status == "done"
    assert remote.writes.count(op.op_id) == 1
    assert op.attempts == 2


def test_crash_after_remote_success_before_local_ack(team: models.Team, remote: Remote) -> None:
    """The precise boundary: the remote write landed, the process died before recording the ack."""
    remote.faults = ["crash_after"]
    op_id = _propose(team)
    with pytest.raises(KeyboardInterrupt):
        gateway.dispatch(op_id)
    op = _op(op_id)
    assert op.status == "dispatching"  # the committed lease is the evidence of an attempt
    assert remote.writes == [op.op_id]

    assert gateway.recover_stale(now=models.utcnow() + dt.timedelta(hours=1)) == 1
    assert _op(op_id).status == "unknown"
    _run_due_jobs_now()
    op = _op(op_id)
    assert op.status == "reconciled"
    assert remote.writes.count(op.op_id) == 1, "a recovered dispatch must never be blindly resent"


def test_unknown_on_uncheckable_system_pauses_for_review(team: models.Team) -> None:
    remote = Remote(checkable=False)
    remote.faults = ["503_after"]
    gateway.set_connector_factory(remote.factory)
    op_id = _propose(team)
    _run_due_jobs_now()
    op = _op(op_id)
    assert op.status == "needs_review"
    assert "couldn't tell" in op.error_line
    assert remote.writes.count(op.op_id) == 1


def test_unreachable_retries_later(team: models.Team, remote: Remote) -> None:
    remote.faults = ["unreachable"]
    op_id = _propose(team)
    worker.drain()
    op = _op(op_id)
    assert op.status == "intent_recorded" and op.next_attempt_at is not None
    assert remote.writes == []
    with db.session() as s:  # let the backoff elapse
        s.execute(sa.update(models.Operation).values(next_attempt_at=models.utcnow() - dt.timedelta(seconds=1)))
    _run_due_jobs_now()
    assert _op(op_id).status == "done"
    assert len(remote.writes) == 1


def test_level_gate_waits_for_approval(team: models.Team, remote: Remote) -> None:
    op_id = _propose(team, kind="github.create_issue")  # L2 steward; opening issues needs a higher level
    assert _op(op_id).status == "awaiting_approval"
    worker.drain()
    assert remote.writes == []
    with db.session() as s:
        approval = s.scalar(sa.select(models.Approval))
        user = s.scalar(sa.select(models.User))
        gateway.approve(s, approval, user)
    _run_due_jobs_now()
    assert _op(op_id).status == "done"


def test_label_gate_blocks_confidential_to_other_team(team: models.Team, remote: Remote) -> None:
    op_id = _propose(team, label="confidential", audience_kind="org")
    op = _op(op_id)
    assert (op.status, op.error_class) == ("rejected", errors.BLOCKED)
    assert "only cleared for internal" in op.error_line
    worker.drain()
    assert remote.writes == []


def test_canary_blocks_pauses_and_demotes(team: models.Team, remote: Remote) -> None:
    with db.session() as s:
        s.add(models.Canary(org_id=team.org_id, team_id=team.id, token="kc-test-canary"))
    op_id = _propose(team, text="FYI from the postmortem: kc-test-canary", audience_kind="org")
    assert _op(op_id).status == "rejected"
    with db.session() as s:
        steward = gateway.steward_for(s, team.id)
        assert steward.paused and steward.level == 1
        assert s.scalar(sa.select(models.Canary)).tripped_at is not None
    assert remote.writes == []


def test_human_writes_skip_the_level_gate_but_not_the_label_gate(team: models.Team, remote: Remote) -> None:
    assert _op(_propose(team, kind="github.create_issue", actor="user:ada@test.example")).status == "intent_recorded"
    blocked = _op(_propose(team, label="restricted", actor="user:ada@test.example"))
    assert blocked.status == "rejected"


def test_resolve_retry_and_cancel(team: models.Team) -> None:
    remote = Remote(checkable=False)
    remote.faults = ["503_after"]
    gateway.set_connector_factory(remote.factory)
    op_id = _propose(team)
    _run_due_jobs_now()
    with db.session() as s:
        op, user = s.get(models.Operation, op_id), s.scalar(sa.select(models.User))
        gateway.resolve(s, op, "done", user)
        assert op.status == "done"
        with pytest.raises(ValueError):
            gateway.resolve(s, op, "cancel", user)
        with pytest.raises(ValueError):
            gateway.resolve(s, op, "maybe", user)


def test_runner_claims_once_and_failure_is_final(team: models.Team) -> None:
    with db.session() as s:
        t = s.get(models.Team, team.id)
        op = models.Operation(org_id=t.org_id, team_id=t.id, op_id="run:1", kind="runbook.run", target="restart",
                              summary="Restart api", payload={}, status="dispatching", created_by="steward", remote_ref="runner:pending",
                              attempts=1, lease_until=models.utcnow() + dt.timedelta(minutes=5))
        s.add(op)
    with db.session() as s:
        claimed = gateway.runner_claim(s, "box-1")
        assert claimed is not None and claimed.remote_ref == "runner:box-1"
    with db.session() as s:
        assert gateway.runner_claim(s, "box-2") is None
        op = s.scalar(sa.select(models.Operation).where(models.Operation.op_id == "run:1"))
        gateway.runner_report(s, op, ok=False, output="step 1\nexit 2: permission denied")
        assert op.status == "failed"
        assert op.error_line.endswith("exit 2: permission denied")
        with pytest.raises(ValueError):
            gateway.runner_report(s, op, ok=True, output="")
