"""Turn database rows into the JSON shapes in docs/api.md."""

from __future__ import annotations

import datetime as dt
import typing

import sqlalchemy as sa
from sqlalchemy import orm

from keel import connections, knowledge, learning, ledger, levels, models, people, services

HEALTH_COST = {
    "overdue": 12,
    "at_risk": 4,
    "incident": 25,
    "needs_review": 6,
}  # Points off 100; an outage dominates.
SNIPPET_CHARS = 180
J = dict[str, typing.Any]


def iso(t: dt.datetime | None) -> str | None:
    """ISO-8601 UTC with a Z, or None."""
    if t is None:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.UTC)
    return t.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


def user(u: models.User | None) -> J | None:
    """User."""
    if u is None:
        return None
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "avatar_url": u.avatar_url}


class TeamIndex:
    """Team id → slug lookups for one request."""

    def __init__(self, session: orm.Session, org_id: str) -> None:
        self.teams = {
            t.id: t for t in session.scalars(sa.select(models.Team).where(models.Team.org_id == org_id))
        }

    def slug(self, team_id: str | None) -> str | None:
        """Slug for an id, or None."""
        t = self.teams.get(team_id or "")
        return t.slug if t else None


def slack_state(session: orm.Session, team: models.Team) -> tuple[str, str]:
    """(state, where) for a team's Slack home: state is demo | off | unset | unresolved | live."""
    org = session.get(models.Org, team.org_id)
    name = team.slack_channel_name or (f"#{team.slug}" if org and org.settings.get("demo") else "")
    if org is not None and org.settings.get("demo"):
        return "demo", name
    if not connections.resolve(session, team.org_id, "slack").configured:
        return "off", name
    if not team.slack_channel_id and not team.slack_channel_name:
        return "unset", ""
    if not team.slack_channel_id:
        return "unresolved", name
    return "live", name or team.slack_channel_id


def steward(st: models.Steward, team: models.Team, pending: int, slack: tuple[str, str] = ("demo", "")) -> J:
    """StewardSummary. ``slack`` is :func:`slack_state`; the status line only claims what's true."""
    lvl = levels.level_def(st.level)
    state, name = slack
    waits = (
        f"{pending} draft{'s wait' if pending != 1 else ' waits'} for you."
        if pending
        else "Nothing waits for you."
    )
    if st.paused:
        line = "Paused. Everything waits for you."
    elif state in ("demo", "live"):
        where = name or "the web desk"
        line = f"Observing {where}. Sends nothing." if st.level == 0 else f"Watching {where}. {waits}"
    elif state == "unresolved":
        line = f"Looking for {name} in Slack. Invite the Keel app to it. {waits}"
    elif state == "unset":
        line = f"On the web desk. No Slack channel set. {waits}"
    else:
        line = f"On the web desk. Slack isn't connected. {waits}"
    return {
        "id": st.id,
        "name": st.name,
        "emoji": st.emoji,
        "level": st.level,
        "level_name": lvl.name,
        "paused": st.paused,
        "status_line": line,
        "duties": list(st.duties or []),
    }


def team_summary(session: orm.Session, team: models.Team, now: dt.datetime | None = None) -> J:
    """TeamSummary with counts and health."""
    now = now or models.utcnow()
    st = session.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
    open_rows = ledger.open_for_team(session, team.id)
    risks = [ledger.risk(c, now) for c in open_rows]
    pending = (
        session.scalar(
            sa.select(sa.func.count())
            .select_from(models.Approval)
            .where(models.Approval.team_id == team.id, models.Approval.status == "pending")
        )
        or 0
    )
    incidents = (
        session.scalar(
            sa.select(sa.func.count())
            .select_from(models.Incident)
            .where(models.Incident.team_id == team.id, models.Incident.resolved_at.is_(None))
        )
        or 0
    )
    review = (
        session.scalar(
            sa.select(sa.func.count())
            .select_from(models.Operation)
            .where(models.Operation.team_id == team.id, models.Operation.status == "needs_review")
        )
        or 0
    )
    out_open = (
        session.scalar(
            sa.select(sa.func.count())
            .select_from(models.Commitment)
            .where(
                models.Commitment.requester_team_id == team.id,
                models.Commitment.status.in_(ledger.OPEN_STATUSES),
            )
        )
        or 0
    )
    counts = {
        "open": len(open_rows),
        "at_risk": risks.count("at_risk"),
        "overdue": risks.count("overdue"),
        "pending_approvals": pending,
        "incidents_open": incidents,
        "requests_in": sum(1 for c in open_rows if c.requester_team_id),
        "requests_out": out_open,
    }
    health = 100 - (
        counts["overdue"] * HEALTH_COST["overdue"]
        + counts["at_risk"] * HEALTH_COST["at_risk"]
        + incidents * HEALTH_COST["incident"]
        + review * HEALTH_COST["needs_review"]
    )
    return {
        "id": team.id,
        "slug": team.slug,
        "name": team.name,
        "color": team.color,
        "steward": steward(st, team, pending, slack_state(session, team)) if st else None,
        "health": max(0, min(100, health)),
        "counts": counts,
    }


def activity(a: models.Activity, idx: TeamIndex) -> J:
    """ActivityItem."""
    return {
        "id": str(a.id),
        "at": iso(a.at),
        "team_slug": idx.slug(a.team_id),
        "kind": a.kind,
        "icon": a.icon,
        "text": a.text,
        "link": a.link,
    }


def commitment(c: models.Commitment, idx: TeamIndex, now: dt.datetime | None = None) -> J:
    """Commitment."""
    return {
        "key": c.key,
        "title": c.title,
        "detail": c.detail,
        "status": c.status,
        "risk": ledger.risk(c, now),
        "priority": c.priority,
        "owner_team": idx.slug(c.owner_team_id),
        "requester_team": idx.slug(c.requester_team_id),
        "owner_person": c.owner_person,
        "requester_person": c.requester_person,
        "due_at": iso(c.due_at),
        "created_at": iso(c.created_at),
        "updated_at": iso(c.updated_at),
        "source_url": c.source_url,
        "source_kind": c.source_kind,
        "label": c.label,
    }


def operation(op: models.Operation, idx: TeamIndex) -> J:
    """Operation."""
    return {
        "id": op.id,
        "op_id": op.op_id,
        "team_slug": idx.slug(op.team_id),
        "kind": op.kind,
        "target": op.target,
        "summary": op.summary,
        "status": op.status,
        "attempts": op.attempts,
        "error_class": op.error_class,
        "error_line": op.error_line,
        "remote_ref": op.remote_ref,
        "created_at": iso(op.created_at),
        "updated_at": iso(op.updated_at),
    }


def commitment_detail(session: orm.Session, c: models.Commitment, idx: TeamIndex) -> J:
    """CommitmentDetail."""
    ops = session.scalars(
        sa.select(models.Operation)
        .where(models.Operation.commitment_id == c.id)
        .order_by(models.Operation.created_at)
    )
    return {
        **commitment(c, idx),
        "events": [
            {"id": e.id, "at": iso(e.at), "actor": e.actor, "kind": e.kind, "text": e.text} for e in c.events
        ],
        "operations": [operation(op, idx) for op in ops],
    }


def approval(session: orm.Session, a: models.Approval, idx: TeamIndex) -> J:
    """Approval."""
    op = a.operation
    key = None
    if op.commitment_id:
        c = session.get(models.Commitment, op.commitment_id)
        key = c.key if c else None
    return {
        "id": a.id,
        "team_slug": idx.slug(a.team_id),
        "created_at": iso(a.created_at),
        "kind": op.kind,
        "title": a.title,
        "preview": a.preview,
        "reason": a.reason,
        "label": op.label,
        "audience": op.audience or op.target,
        "commitment_key": key,
        "status": a.status,
    }


def level_info(session: orm.Session, st: models.Steward) -> J:
    """LevelInfo."""
    ps = levels.promotion_status(session, st)
    hist = session.scalars(
        sa.select(models.LevelEvent)
        .where(models.LevelEvent.team_id == st.team_id)
        .order_by(models.LevelEvent.at.desc())
    )
    return {
        "level": st.level,
        "level_name": levels.level_def(st.level).name,
        "levels": [{"level": d.level, "name": d.name, "can": d.can} for d in levels.LEVELS],
        "samples": ps.samples,
        "approval_rate": ps.approval_rate,
        "min_samples": levels.PROMOTION_MIN_SAMPLES,
        "min_approval_rate": levels.PROMOTION_MIN_APPROVAL_RATE,
        "eligible_for": ps.eligible_for,
        "history": [
            {"at": iso(h.at), "from": h.from_level, "to": h.to_level, "reason": h.reason, "actor": h.actor}
            for h in hist
        ],
    }


def knowledge_doc(d: models.KnowledgeDoc, content: bool = False) -> J:
    """KnowledgeDoc (with ``content`` when asked)."""
    out = {
        "id": d.id,
        "title": d.title,
        "source": d.source,
        "label": d.label,
        "updated_at": iso(d.updated_at),
        "snippet": " ".join(d.content.split())[:SNIPPET_CHARS],
        "chars": len(d.content),
        "origin": d.origin,
        "source_url": d.source_url,
        "review_by": d.review_by.isoformat() if d.review_by else None,
        "stale": knowledge.is_stale(d),
        "sync_id": d.sync_id,
    }
    if content:
        out["content"] = d.content
    return out


def knowledge_source(src: models.KnowledgeSource, docs: int) -> J:
    """KnowledgeSource."""
    return {
        "id": src.id,
        "kind": src.kind,
        "target": src.target,
        "label": src.label,
        "last_synced_at": iso(src.last_synced_at),
        "status": src.status,
        "status_line": src.status_line,
        "docs": docs,
    }


def person(session: orm.Session, u: models.User) -> J:
    """Person: an account with its teams."""
    return {
        **user(u),
        "disabled": u.disabled,
        "sso": bool(u.sso_subject) and not u.password_hash,
        "slack_linked": bool(u.slack_user_id),
        "github_login": u.github_login,
        "teams": [
            {"slug": t.slug, "name": t.name, "role": people.api_team_role(r)}
            for t, r in people.teams_of(session, u)
        ],
        "created_at": iso(u.created_at),
        "last_seen_at": iso(u.last_seen_at),
    }


def invite(session: orm.Session, inv: models.Invite) -> J:
    """Invite (never the token)."""
    names = {
        t.slug: t.name
        for t in session.scalars(sa.select(models.Team).where(models.Team.org_id == inv.org_id))
    }
    return {
        "id": inv.id,
        "email": inv.email,
        "role": inv.role,
        "teams": [
            {"slug": t["slug"], "name": names.get(t["slug"], t["slug"]), "role": t.get("role", "member")}
            for t in inv.teams
        ],
        "invited_by": inv.invited_by,
        "created_at": iso(inv.created_at),
        "expires_at": iso(inv.expires_at),
        "status": people.invite_status(inv),
    }


def member(u: models.User, m: models.TeamMember) -> J:
    """Member of a team."""
    return {
        "user_id": u.id,
        "name": u.name,
        "email": u.email,
        "role": people.api_team_role(m.role),
        "avatar_url": u.avatar_url,
    }


def team_settings(session: orm.Session, team: models.Team) -> J:
    """TeamSettings."""
    state, _ = slack_state(session, team)
    return {
        "slack_channel": team.slack_channel_name or team.slack_channel_id,
        "slack_channel_id": team.slack_channel_id,
        "slack_connected": state in ("unset", "unresolved", "live"),
        "github_repos": list(team.github_repos or []),
        "timezone": team.timezone,
        "brief_hour": team.brief_hour,
        "sso_groups": list(team.sso_groups or []),
    }


def lesson(r: models.Lesson) -> J:
    """Lesson, with its one-line headline."""
    return {
        "id": r.id,
        "kind": r.kind,
        "headline": learning.headline(r),
        "situation": r.situation,
        "before": r.before,
        "after": r.after,
        "note": r.note,
        "label": r.label,
        "source": r.source,
        "author": r.author,
        "active": r.active,
        "uses": r.uses,
        "last_used_at": iso(r.last_used_at),
        "created_at": iso(r.created_at),
    }


def gap(g: models.KnowledgeGap) -> J:
    """Open (or closed) question."""
    return {
        "id": g.id,
        "question": g.question,
        "asked_by": g.asked_by,
        "count": g.count,
        "status": g.status,
        "suggested_answer": g.suggested_answer,
        "suggested_by": g.suggested_by,
        "doc_id": g.doc_id,
        "closed_by": g.closed_by,
        "created_at": iso(g.created_at),
        "last_asked_at": iso(g.last_asked_at),
        "closed_at": iso(g.closed_at),
    }


def service(session: orm.Session, svc: models.Service) -> J:
    """Service with stats and sparkline."""
    st = services.stats(session, svc)
    inc = services.open_incident(session, svc)
    inc_j = None
    if inc is not None:
        c = session.get(models.Commitment, inc.commitment_id) if inc.commitment_id else None
        inc_j = {
            "id": inc.id,
            "opened_at": iso(inc.opened_at),
            "summary": inc.summary,
            "commitment_key": c.key if c else None,
        }
    return {
        "id": svc.id,
        "name": svc.name,
        "url": svc.url,
        "owner": svc.owner,
        "state": svc.state,
        "uptime_24h": st["uptime_24h"],
        "latency_p50_ms": st["latency_p50_ms"],
        "checks": [
            {"at": iso(c.at), "ok": c.ok, "latency_ms": c.latency_ms, "status_code": c.status_code}
            for c in st["checks"]
        ],
        "open_incident": inc_j,
        "runbooks": [
            {"id": r["id"], "name": r["name"], "min_level": r.get("min_level", 4)} for r in svc.runbooks
        ],
    }


def brief(b: models.Brief, idx: TeamIndex) -> J:
    """Brief."""
    return {
        "id": b.id,
        "team_slug": idx.slug(b.team_id),
        "kind": b.kind,
        "created_at": iso(b.created_at),
        "title": b.title,
        "markdown": b.markdown,
    }


def chat_message(m: models.ChatMessage) -> J:
    """ChatMessage."""
    out: J = {"role": m.role, "text": m.text, "at": iso(m.at)}
    if m.role == "steward":
        out["sources"] = (m.meta or {}).get("sources", [])
        out["actions"] = (m.meta or {}).get("actions", [])
    return out


def audit(a: models.AuditLog, idx: TeamIndex) -> J:
    """AuditEntry."""
    return {
        "id": a.id,
        "at": iso(a.at),
        "actor": a.actor,
        "action": a.action,
        "target": a.target,
        "detail": a.detail,
        "team_slug": idx.slug(a.team_id),
    }


def checkup(c: models.Checkup) -> J:
    """CheckupReport."""
    return {
        "id": c.id,
        "repo": c.repo,
        "status": c.status,
        "error_line": c.error_line,
        "score": c.score,
        "grade": c.grade,
        "findings": c.findings or [],
        "stats": c.stats or {},
        "created_at": iso(c.created_at),
    }
