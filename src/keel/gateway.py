"""The action gateway. Every outgoing write passes through here, outside the agent framework.

Order: dedupe by op_id → output gate (labels, leak canaries) → authorization (level, pause) → approval or
outbox → dispatch → ack, or classify the failure → reconcile unknown outcomes by op_id → needs_review.

The outbox row is durable *intent*; it does not make delivery exactly-once. A write can land remotely and
Keel can crash before recording the ack. That case surfaces as a stale ``dispatching`` row, which becomes
``unknown`` and is reconciled by op_id before any retry. Non-idempotent writes Keel can't verify go to
``needs_review`` for a human. There is no exactly-once for posts, commands, model calls or token spend.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import typing

import sqlalchemy as sa
from sqlalchemy import orm

from keel import connections, db, errors, feed, jobs, labels, learning, levels, models
from keel.connectors import base

log = logging.getLogger(__name__)

DISPATCH_LEASE = dt.timedelta(minutes=2)  # A connector call that hasn't acked by then is treated as unknown.
RUNNER_LEASE = dt.timedelta(minutes=30)  # Runbooks can take a while; the runner must report within this.
RECONCILE_DELAY = dt.timedelta(seconds=10)  # Give the remote side a moment to make the write listable.
MAX_RECONCILE_CHECKS = 4  # Then a human decides; more checks rarely change "unsure" into an answer.
MAX_DISPATCH_ATTEMPTS = 5  # Covers rate limits and unreachable hosts; real outages need a human anyway.

KIND_TITLES: dict[str, str] = {
    "slack.post_team": "Post to {target}",
    "slack.reply_thread": "Reply in a thread in {target}",
    "slack.nudge": "Nudge in {target}",
    "slack.post_other": "Post to {target}",
    "brief.post": "Post the brief to {target}",
    "github.create_issue": "Open an issue in {target}",
    "github.comment": "Comment on {target}",
    "crossteam.request": "Ask {target}",
    "runbook.run": "Run runbook {target}",
}

TERMINAL = ("done", "reconciled", "failed", "rejected")
CONTEXT_CHARS = 2000  # The triggering message kept with a write; a lesson clips it further.
# Failures that mean the steward chose a bad target or body. Auth, permission, rate and network failures are
# setup or weather problems, so they don't count against its level.
STEWARD_FAULT_ERRORS = frozenset({errors.BAD_REQUEST, errors.NOT_FOUND})


@dataclasses.dataclass
class Proposal:
    """A write a steward (or a person) wants to make."""

    team: models.Team
    kind: str
    target: str
    payload: dict[str, typing.Any]
    summary: str
    op_id: str
    label: str = "internal"
    audience_kind: str = "team"  # team | org | external | admins
    audience: str = ""
    commitment: models.Commitment | None = None
    actor: str = "steward"  # "steward" or "user:<email>"
    idempotent: bool = False
    preview: str | None = None
    context: str | None = None  # The message that led to it; edits and rejections learn from this.


def steward_for(session: orm.Session, team_id: str) -> models.Steward:
    """Return the team's steward."""
    st = session.scalar(sa.select(models.Steward).where(models.Steward.team_id == team_id))
    if st is None:
        raise ValueError("This team has no steward yet.")
    return st


def _text_of(payload: dict[str, typing.Any]) -> str:
    return "\n".join(str(v) for k, v in payload.items() if isinstance(v, str) and not k.startswith("_"))


ROUTING_KEYS = frozenset({"channel", "repo", "to_team", "thread_ts", "issue", "priority", "service"})
BODY_KEYS = ("text", "body", "detail")


def _body_key(payload: dict[str, typing.Any]) -> str | None:
    return next((k for k in BODY_KEYS if isinstance(payload.get(k), str)), None)


def _preview_of(payload: dict[str, typing.Any]) -> str:
    """What a person reads before approving: the message itself, never routing ids like a channel id."""
    key = _body_key(payload)
    if key is None:
        return "\n".join(
            str(v)
            for k, v in payload.items()
            if isinstance(v, str) and not k.startswith("_") and k not in ROUTING_KEYS
        )
    title = payload.get("title")
    return f"{title}\n\n{payload[key]}" if isinstance(title, str) and title else payload[key]


def _check_canaries(session: orm.Session, p: Proposal, steward: models.Steward) -> str | None:
    """Return a block line if the text carries a canary its audience may not see; trips it and demotes."""
    text = _text_of(p.payload)
    for canary in session.scalars(sa.select(models.Canary).where(models.Canary.org_id == p.team.org_id)):
        if canary.token not in text:
            continue
        same_team = canary.team_id == p.team.id
        if same_team and labels.audience_allows(
            labels.audience_max_for_target(p.audience_kind), "restricted"
        ):
            continue
        canary.tripped_at = models.utcnow()
        levels.set_level(
            session, steward, min(steward.level, 1), "A leak canary appeared in outgoing text.", "keel"
        )
        steward.paused = True
        feed.CANARY_TRIPS.labels(team=p.team.slug).inc()
        feed.audit(
            session, p.team.org_id, "keel", "canary.tripped", p.op_id, f"canary {canary.id}", p.team.id
        )
        feed.activity(
            session,
            p.team.org_id,
            p.team.id,
            "level",
            "🚨",
            f"{steward.name} tried to send restricted text. Blocked, paused and moved to L1.",
            "/operations",
        )
        return (
            f"Blocked: this text contains a restricted marker from team knowledge. {steward.name} is paused "
            "and back at L1 until someone checks."
        )
    return None


def propose(session: orm.Session, p: Proposal) -> models.Operation:
    """Record a write and decide: block, wait for approval, or queue for dispatch. Idempotent on op_id."""
    existing = session.scalar(
        sa.select(models.Operation).where(
            models.Operation.org_id == p.team.org_id, models.Operation.op_id == p.op_id
        )
    )
    if existing is not None:
        return existing
    steward = steward_for(session, p.team.id)
    op = models.Operation(
        org_id=p.team.org_id,
        team_id=p.team.id,
        op_id=p.op_id,
        kind=p.kind,
        target=p.target,
        summary=p.summary[:500],
        payload=p.payload,
        label=p.label,
        audience=p.audience,
        idempotent=p.idempotent,
        status="intent_recorded",
        commitment_id=p.commitment.id if p.commitment else None,
        created_by=p.actor,
        context=p.context[:CONTEXT_CHARS] if p.context else None,
    )
    session.add(op)
    session.flush()
    human = p.actor.startswith("user:")

    block = _check_canaries(session, p, steward)
    if block is None and not labels.audience_allows(labels.audience_max_for_target(p.audience_kind), p.label):
        block = (
            f"Blocked: the text is labeled {p.label}, and {p.audience or p.target} is only cleared for "
            f"{labels.audience_max_for_target(p.audience_kind)}."
        )
    if block is not None:
        op.status, op.error_class, op.error_line = "rejected", errors.BLOCKED, block
        feed.OPS_TOTAL.labels(kind=op.kind, status="blocked").inc()
        feed.audit(session, op.org_id, p.actor, "operation.blocked", op.op_id, block, op.team_id)
        return op

    reason = None
    if not human:
        lvl = levels.level_def(steward.level)
        need = levels.min_level_for(p.kind)
        if steward.level == 0:
            op.status, op.error_line = "rejected", f"{steward.name} is at L0 Observe and sends nothing."
            return op
        if steward.paused:
            reason = f"{steward.name} is paused, so everything waits for you."
        elif steward.level < need:
            reason = (
                f"{steward.name} is at L{steward.level} {lvl.name}: this needs approval until "
                f"L{need} {levels.level_def(need).name}."
            )
    if reason is not None:
        op.status = "awaiting_approval"
        title = KIND_TITLES.get(p.kind, "{target}").format(target=p.target)
        session.add(
            models.Approval(
                org_id=op.org_id,
                team_id=op.team_id,
                operation_id=op.id,
                title=title,
                preview=p.preview or _preview_of(p.payload),
                reason=reason,
            )
        )
        feed.activity(
            session,
            op.org_id,
            op.team_id,
            "approval",
            "✋",
            f"{steward.name} drafted: {title}. It waits for you.",
            "/approvals",
        )
    else:
        _queue_dispatch(session, op)
    feed.audit(
        session, op.org_id, p.actor, "operation.proposed", op.op_id, f"{op.kind} → {op.status}", op.team_id
    )
    return op


def _queue_dispatch(session: orm.Session, op: models.Operation, run_at: dt.datetime | None = None) -> None:
    op.status = "intent_recorded"
    jobs.enqueue(
        session,
        op.org_id,
        "dispatch",
        {"op": op.id},
        run_at=run_at,
        dedupe_key=f"dispatch:{op.id}:{op.attempts}",
    )


def approve(
    session: orm.Session, approval: models.Approval, user: models.User, edited_preview: str | None = None
) -> models.Approval:
    """Approve a draft (optionally edited). Records a promotion sample."""
    if approval.status != "pending":
        raise ValueError(f"This approval is already {approval.status}.")
    op = approval.operation
    before = approval.preview
    edited = edited_preview is not None and edited_preview.strip() != approval.preview.strip()
    if edited:
        key = _body_key(op.payload)
        if key is not None:
            new = dict(op.payload)
            title, sep, rest = edited_preview.partition("\n\n")
            if isinstance(new.get("title"), str) and new["title"] and sep:
                new["title"], new[key] = title.strip(), rest
            else:
                new[key] = edited_preview
            op.payload = new
        approval.preview = edited_preview or approval.preview
    approval.status, approval.decided_by, approval.decided_at = "approved", user.email, models.utcnow()
    steward = steward_for(session, op.team_id)
    levels.record_sample(session, steward, op.kind, "edited" if edited else "approved")
    if edited:
        learning.from_approval(session, approval, before, user.name)
    _queue_dispatch(session, op)
    feed.audit(
        session,
        op.org_id,
        f"user:{user.email}",
        "approval.approved",
        op.op_id,
        "edited" if edited else "",
        op.team_id,
    )
    feed.activity(
        session,
        op.org_id,
        op.team_id,
        "approval",
        "👍",
        f"{user.name} approved: {approval.title}",
        "/operations",
    )
    return approval


def reject(
    session: orm.Session, approval: models.Approval, user: models.User, reason: str = ""
) -> models.Approval:
    """Reject a draft. Records a sample; repeated rejections demote the steward."""
    if approval.status != "pending":
        raise ValueError(f"This approval is already {approval.status}.")
    op = approval.operation
    approval.status, approval.decided_by, approval.decided_at = "rejected", user.email, models.utcnow()
    op.status, op.error_line = "rejected", f"Rejected by {user.name}" + (f": {reason}" if reason else ".")
    steward = steward_for(session, op.team_id)
    levels.record_sample(session, steward, op.kind, "rejected")
    learning.from_rejection(session, approval, reason, user.name)
    feed.audit(session, op.org_id, f"user:{user.email}", "approval.rejected", op.op_id, reason, op.team_id)
    feed.activity(
        session,
        op.org_id,
        op.team_id,
        "approval",
        "✋",
        f"{user.name} rejected: {approval.title}",
        "/approvals",
    )
    return approval


ConnectorFactory = typing.Callable[[orm.Session, models.Operation], base.Connector]
_factory_override: ConnectorFactory | None = None


def set_connector_factory(factory: ConnectorFactory | None) -> None:
    """Replace connector lookup (tests)."""
    global _factory_override
    _factory_override = factory


def connector_for(session: orm.Session, op: models.Operation) -> base.Connector:
    """Pick the connector for an operation kind."""
    if _factory_override is not None:
        return _factory_override(session, op)
    from keel.connectors import crossteam, github, runner, sim, slack

    system = op.kind.split(".")[0]
    if system == "crossteam":
        return crossteam.CrossTeamConnector()
    if system == "runbook":
        return runner.RunnerConnector()
    org = session.get(models.Org, op.org_id)
    if org is not None and org.settings.get("demo"):
        return sim.SimConnector(op.org_id)
    if system in ("slack", "brief"):
        res = connections.resolve(session, op.org_id, "slack")
        if not res.configured:
            raise errors.ConnectorError(
                errors.AUTH_INVALID, "Slack isn't connected. Connect it in Setup.", sent=False
            )
        return slack.SlackConnector(res.secrets["bot_token"])
    if system == "github":
        auth = github.auth_for_org(session, op.org_id)
        if auth is None:
            raise errors.ConnectorError(
                errors.AUTH_INVALID, "GitHub isn't connected. Connect it in Setup.", sent=False
            )
        return github.GitHubConnector(auth)
    raise errors.ConnectorError(errors.BAD_REQUEST, f"No connector handles {op.kind}.", sent=False)


def dispatch(op_row_id: str) -> str:
    """Send one queued operation. Returns its status afterwards. Safe to call twice."""
    now = models.utcnow()
    with db.session() as s:
        q = sa.select(models.Operation).where(models.Operation.id == op_row_id)
        if db.is_postgres():
            q = q.with_for_update(skip_locked=True)
        op = s.scalar(q)
        if op is None or op.status != "intent_recorded":
            return op.status if op else "missing"
        if op.next_attempt_at is not None and op.next_attempt_at > now:
            jobs.enqueue(
                s,
                op.org_id,
                "dispatch",
                {"op": op.id},
                run_at=op.next_attempt_at,
                dedupe_key=f"dispatch:{op.id}:{op.attempts}:wait",
            )
            return op.status
        op.status, op.attempts = "dispatching", op.attempts + 1
        op.lease_until = now + (RUNNER_LEASE if op.kind == "runbook.run" else DISPATCH_LEASE)
    # The dispatching row is committed before the call: a crash from here on leaves evidence.
    with db.session() as s:
        op = s.get(models.Operation, op_row_id)
        assert op is not None
        try:
            connector = connector_for(s, op)
            with feed.OPS_DISPATCH_SECONDS.labels(kind=op.kind).time():
                result = connector.execute(op)
        except errors.ConnectorError as exc:
            _on_error(s, op, exc)
            return op.status
        if result.pending:
            op.remote_ref = result.remote_ref
            return op.status
        _on_ack(s, op, result.remote_ref, "acked")
        return op.status


def _on_ack(s: orm.Session, op: models.Operation, remote_ref: str, how: str) -> None:
    op.status = "done" if how == "acked" else "reconciled"
    op.remote_ref, op.error_class, op.error_line, op.lease_until = remote_ref, None, None, None
    feed.OPS_TOTAL.labels(kind=op.kind, status=op.status).inc()
    steward = steward_for(s, op.team_id)
    if op.commitment_id:
        c = s.get(models.Commitment, op.commitment_id)
        if c is not None:
            from keel import ledger

            ledger.add_event(s, c, steward.name, "operation", f"{op.summary} ({how})")
    verb = "Sent" if how == "acked" else "Confirmed after a lost response"
    feed.activity(
        s,
        op.org_id,
        op.team_id,
        "operation",
        "📨" if how == "acked" else "🔎",
        f"{verb}: {op.summary}",
        "/operations",
    )


def _on_error(s: orm.Session, op: models.Operation, exc: errors.ConnectorError) -> None:
    op.error_class, op.error_line, op.lease_until = exc.error_class, exc.line, None
    if exc.error_class == errors.UNKNOWN_OUTCOME:
        op.status = "unknown"
        jobs.enqueue(
            s,
            op.org_id,
            "reconcile",
            {"op": op.id, "check": 1},
            run_at=models.utcnow() + RECONCILE_DELAY,
            dedupe_key=f"reconcile:{op.id}:{op.attempts}:1",
        )
        feed.activity(
            s,
            op.org_id,
            op.team_id,
            "operation",
            "❔",
            f"Unclear if it went through: {op.summary}. Checking.",
            "/operations",
        )
        return
    if exc.error_class in (errors.RATE_LIMITED, errors.UNREACHABLE) and op.attempts < MAX_DISPATCH_ATTEMPTS:
        op.next_attempt_at = models.utcnow() + dt.timedelta(seconds=exc.retry_after_s or 30)
        _queue_dispatch(s, op, run_at=op.next_attempt_at)
        return
    op.status = "failed"
    feed.OPS_TOTAL.labels(kind=op.kind, status="failed").inc()
    if op.created_by == "steward" and exc.error_class in STEWARD_FAULT_ERRORS:
        levels.record_sample(s, steward_for(s, op.team_id), op.kind, "error")
    if exc.error_class == errors.AUTH_INVALID:
        connections.mark(s, op.org_id, op.kind.split(".")[0], "error", exc.line)
    feed.activity(
        s, op.org_id, op.team_id, "operation", "⚠️", f"Couldn't do it: {op.summary}. {exc.line}", "/operations"
    )


def reconcile(op_row_id: str, check: int) -> str:
    """Find out whether an unknown-outcome write happened. Returns the status afterwards."""
    with db.session() as s:
        op = s.get(models.Operation, op_row_id)
        if op is None or op.status != "unknown":
            return op.status if op else "missing"
        checkable = True
        try:
            connector = connector_for(s, op)
            checkable = getattr(connector, "checkable", True)
            found = connector.reconcile(op)
        except errors.ConnectorError as exc:
            found = base.ReconcileResult(base.Found.UNSURE, line=exc.line)
        if found.found is base.Found.YES:
            _on_ack(s, op, found.remote_ref or "", "reconciled")
            return op.status
        if found.found is base.Found.NO and op.attempts < MAX_DISPATCH_ATTEMPTS:
            # An authoritative listing says it never landed, so sending again can't duplicate it.
            op.error_line = f"{found.line} Sending again."
            _queue_dispatch(s, op)
            return op.status
        if found.found is base.Found.UNSURE and checkable and check < MAX_RECONCILE_CHECKS:
            jobs.enqueue(
                s,
                op.org_id,
                "reconcile",
                {"op": op.id, "check": check + 1},
                run_at=models.utcnow() + RECONCILE_DELAY * (2**check),
                dedupe_key=f"reconcile:{op.id}:{op.attempts}:{check + 1}",
            )
            return op.status
        op.status = "needs_review"
        op.error_line = (
            f"Keel couldn't tell if this went through. {found.line} Check, then mark it done or retry."
        ).strip()
        feed.OPS_TOTAL.labels(kind=op.kind, status="needs_review").inc()
        feed.activity(
            s, op.org_id, op.team_id, "operation", "🧐", f"Needs a look: {op.summary}", "/operations"
        )
        return op.status


def runner_claim(session: orm.Session, runner_name: str) -> models.Operation | None:
    """Hand the oldest waiting runbook run to a runner. Each run is handed out once."""
    q = (
        sa.select(models.Operation)
        .where(
            models.Operation.kind == "runbook.run",
            models.Operation.status == "dispatching",
            models.Operation.remote_ref == "runner:pending",
        )
        .order_by(models.Operation.created_at)
        .limit(1)
    )
    if db.is_postgres():
        q = q.with_for_update(skip_locked=True)
    op = session.scalar(q)
    if op is not None:
        op.remote_ref = f"runner:{runner_name}"
        feed.activity(
            session,
            op.org_id,
            op.team_id,
            "operation",
            "🏃",
            f"Runner {runner_name} started: {op.summary}",
            "/operations",
        )
    return op


def runner_report(session: orm.Session, op: models.Operation, ok: bool, output: str) -> models.Operation:
    """Record what a runner did. A failed command is final: Keel never re-runs a command on its own."""
    if op.status != "dispatching" or not (op.remote_ref or "").startswith("runner:"):
        raise ValueError(f"This run is {op.status}; nothing to report.")
    line = (output.strip().splitlines() or [""])[-1][:300]
    if ok:
        _on_ack(session, op, op.remote_ref or "runner", "acked")
        op.error_line = line or None
    else:
        _on_error(
            session, op, errors.ConnectorError(errors.BAD_REQUEST, f"The command failed: {line}", sent=True)
        )
    return op


def recover_stale(now: dt.datetime | None = None) -> int:
    """Turn ``dispatching`` rows whose lease ran out (crash, lost runner) into ``unknown``. Returns count."""
    now = now or models.utcnow()
    count = 0
    with db.session() as s:
        stale = list(
            s.scalars(
                sa.select(models.Operation).where(
                    models.Operation.status == "dispatching", models.Operation.lease_until < now
                )
            )
        )
        for op in stale:
            op.status, op.error_class = "unknown", errors.UNKNOWN_OUTCOME
            op.error_line = (
                "Keel stopped hearing back while sending this, so it may have gone through. Checking first."
            )
            op.lease_until = None
            jobs.enqueue(
                s,
                op.org_id,
                "reconcile",
                {"op": op.id, "check": 1},
                dedupe_key=f"reconcile:{op.id}:{op.attempts}:1",
            )
            count += 1
    return count


def resolve(session: orm.Session, op: models.Operation, outcome: str, user: models.User) -> models.Operation:
    """A person settles an operation: done (it went through), retry, or cancel."""
    if op.status in ("done", "reconciled", "rejected") and outcome != "retry":
        raise ValueError(f"This operation is already {op.status}.")
    if outcome == "done":
        op.status, op.error_line = "done", f"Marked done by {user.name}."
    elif outcome == "retry":
        if op.status not in ("needs_review", "failed", "unknown"):
            raise ValueError("Only failed or unclear operations can be retried.")
        op.error_class, op.error_line, op.next_attempt_at = None, None, None
        _queue_dispatch(session, op)
    elif outcome == "cancel":
        op.status, op.error_line = "rejected", f"Cancelled by {user.name}."
    else:
        raise ValueError("outcome must be done, retry or cancel")
    feed.audit(session, op.org_id, f"user:{user.email}", f"operation.{outcome}", op.op_id, "", op.team_id)
    return op
