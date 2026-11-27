"""REST routes for the web app (see docs/api.md)."""

from __future__ import annotations

import datetime as dt
import re
import typing

import fastapi
import pydantic
import sqlalchemy as sa

from keel import (
    demo,
    feed,
    gateway,
    jobs,
    knowledge,
    labels,
    ledger,
    levels,
    models,
    rhythm,
    services,
    steward,
    worker,
)
from keel.api import deps, serial

router = fastapi.APIRouter(prefix="/api")
OVERVIEW_ACTIVITY = 30
LIST_LIMIT = 500  # Most rows a list endpoint returns; the UI filters client-side below this.
AUDIT_LIMIT = 300
CHAT_LIMIT = 100
PALETTE = ("#7C5CFF", "#10B981", "#F59E0B", "#EF4444", "#3B82F6", "#EC4899", "#14B8A6", "#8B5CF6")
EMOJIS = ("🦉", "🦫", "🐙", "🦊", "🐢", "🦔", "🐝", "🦜")


def _parse_due(value: str | None, team: models.Team) -> dt.datetime | None:
    if not value:
        return None
    try:
        t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        t = None
    if t is not None:
        if len(value) <= 10:
            return steward.due_from_iso(value, team)
        return t if t.tzinfo else t.replace(tzinfo=dt.UTC)
    from keel import brain

    parsed = brain.parse_due(value, models.utcnow(), team.timezone)
    if parsed is None:
        raise ValueError(f"I can't read the date {value!r}. Use YYYY-MM-DD.")
    return parsed


# ---------------------------------------------------------------- overview and teams

@router.get("/overview")
def overview(s: deps.Session, u: deps.User) -> dict:
    """Org overview: teams, cross-team graph, totals and recent activity."""
    org = s.get(models.Org, u.org_id)
    idx = serial.TeamIndex(s, u.org_id)
    now = models.utcnow()
    teams = [serial.team_summary(s, t, now) for t in sorted(idx.teams.values(), key=lambda t: t.created_at)]
    edges: dict[tuple[str, str], dict] = {}
    for c in s.scalars(sa.select(models.Commitment).where(models.Commitment.org_id == u.org_id,
                                                          models.Commitment.requester_team_id.is_not(None),
                                                          models.Commitment.status.in_(ledger.OPEN_STATUSES))):
        key = (idx.slug(c.requester_team_id) or "", idx.slug(c.owner_team_id) or "")
        e = edges.setdefault(key, {"from_team": key[0], "to_team": key[1], "open": 0, "at_risk": 0})
        e["open"] += 1
        e["at_risk"] += ledger.risk(c, now) in ("at_risk", "overdue")
    done_7d = s.scalar(sa.select(sa.func.count()).select_from(models.Commitment).where(
        models.Commitment.org_id == u.org_id, models.Commitment.status == "done",
        models.Commitment.closed_at >= now - dt.timedelta(days=7))) or 0
    review = s.scalar(sa.select(sa.func.count()).select_from(models.Operation).where(
        models.Operation.org_id == u.org_id, models.Operation.status == "needs_review")) or 0
    acts = s.scalars(sa.select(models.Activity).where(models.Activity.org_id == u.org_id)
                     .order_by(models.Activity.id.desc()).limit(OVERVIEW_ACTIVITY))
    totals = {k: sum(t["counts"][k] for t in teams) for k in ("open", "at_risk", "overdue", "pending_approvals", "incidents_open")}
    return {"org": {"id": org.id, "name": org.name}, "teams": teams, "cross_team": list(edges.values()),
            "totals": {**totals, "done_7d": done_7d, "ops_needs_review": review},
            "activity": [serial.activity(a, idx) for a in acts]}


@router.get("/teams")
def list_teams(s: deps.Session, u: deps.User) -> list[dict]:
    """All teams in the org."""
    rows = s.scalars(sa.select(models.Team).where(models.Team.org_id == u.org_id).order_by(models.Team.created_at))
    return [serial.team_summary(s, t) for t in rows]


class NewTeam(pydantic.BaseModel):
    name: str
    slug: str | None = None
    steward_name: str | None = None
    emoji: str | None = None
    color: str | None = None
    slack_channel: str | None = None
    github_repo: str | None = None


def create_team(s: sa.orm.Session, org: models.Org, body: NewTeam, actor: models.User | None,
                level: int | None = None) -> models.Team:
    """Create a team with its steward at the org's default level."""
    name = body.name.strip()
    if not name:
        raise ValueError("A team needs a name.")
    slug = (body.slug or re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")[:60]
    if not slug:
        raise ValueError("Pick a slug with letters or numbers.")
    if s.scalar(sa.select(models.Team.id).where(models.Team.org_id == org.id, models.Team.slug == slug)):
        raise ValueError(f"There's already a team called {slug}.")
    n = s.scalar(sa.select(sa.func.count()).select_from(models.Team).where(models.Team.org_id == org.id)) or 0
    channel = (body.slack_channel or "").strip()
    team = models.Team(org_id=org.id, slug=slug, name=name, color=body.color or PALETTE[n % len(PALETTE)],
                       github_repos=[body.github_repo.strip()] if body.github_repo else [])
    if channel:
        if re.fullmatch(r"[CG][A-Z0-9]{6,}", channel):
            team.slack_channel_id = channel
        else:
            team.slack_channel_name = channel if channel.startswith("#") else f"#{channel}"
    s.add(team)
    s.flush()
    level = int(org.settings.get("default_level", 1)) if level is None else level
    s.add(models.Steward(org_id=org.id, team_id=team.id, name=(body.steward_name or "Pip").strip()[:60],
                         emoji=body.emoji or EMOJIS[n % len(EMOJIS)], level=level, duties=list(demo.ALL_DUTIES)))
    if actor is not None:
        s.add(models.TeamMember(team_id=team.id, user_id=actor.id, role="team_admin"))
    feed.activity(s, org.id, team.id, "level", "🎉", f"{name} got a steward: {body.steward_name or 'Pip'} at L{level}",
                  f"/teams/{slug}")
    feed.audit(s, org.id, f"user:{actor.email}" if actor else "keel apply", "team.created", slug, f"level={level}",
               team.id)
    s.flush()
    return team


@router.post("/teams")
def post_team(body: NewTeam, s: deps.Session, u: deps.Admin) -> dict:
    """Create a team (org admin)."""
    team = create_team(s, s.get(models.Org, u.org_id), body, u)
    return serial.team_summary(s, team)


@router.get("/teams/{slug}")
def get_team(slug: str, s: deps.Session, u: deps.User) -> dict:
    """Team home: summary, today's brief and activity."""
    team = deps.team_or_404(s, u, slug)
    idx = serial.TeamIndex(s, u.org_id)
    today = s.scalar(sa.select(models.Brief).where(models.Brief.team_id == team.id)
                     .order_by(models.Brief.created_at.desc()))
    acts = s.scalars(sa.select(models.Activity).where(models.Activity.team_id == team.id)
                     .order_by(models.Activity.id.desc()).limit(OVERVIEW_ACTIVITY))
    return {**serial.team_summary(s, team), "today": serial.brief(today, idx) if today else None,
            "activity": [serial.activity(a, idx) for a in acts]}


class StewardPatch(pydantic.BaseModel):
    paused: bool | None = None
    name: str | None = None
    emoji: str | None = None
    duties: list[str] | None = None


@router.patch("/teams/{slug}/steward")
def patch_steward(slug: str, body: StewardPatch, s: deps.Session, u: deps.User) -> dict:
    """Pause/resume, rename, or change duties."""
    team = deps.team_or_404(s, u, slug)
    deps.require_team_admin(s, u, team.id, "change the steward")
    st = gateway.steward_for(s, team.id)
    if body.paused is not None and body.paused != st.paused:
        st.paused = body.paused
        feed.activity(s, u.org_id, team.id, "level", "⏸️" if st.paused else "▶️",
                      f"{u.name} {'paused' if st.paused else 'resumed'} {st.name}", f"/teams/{slug}")
    if body.name:
        st.name = body.name.strip()[:60]
    if body.emoji:
        st.emoji = body.emoji[:16]
    if body.duties is not None:
        bad = set(body.duties) - set(demo.ALL_DUTIES)
        if bad:
            raise ValueError(f"Unknown duties: {', '.join(sorted(bad))}.")
        st.duties = body.duties
    feed.audit(s, u.org_id, f"user:{u.email}", "steward.updated", slug, body.model_dump_json(exclude_none=True), team.id)
    pending = s.scalar(sa.select(sa.func.count()).select_from(models.Approval).where(
        models.Approval.team_id == team.id, models.Approval.status == "pending")) or 0
    return serial.steward(st, team, pending)


@router.get("/teams/{slug}/level")
def get_level(slug: str, s: deps.Session, u: deps.User) -> dict:
    """Level ladder, promotion progress and history."""
    team = deps.team_or_404(s, u, slug)
    return serial.level_info(s, gateway.steward_for(s, team.id))


class LevelChange(pydantic.BaseModel):
    level: int
    reason: str = ""


@router.post("/teams/{slug}/level")
def post_level(slug: str, body: LevelChange, s: deps.Session, u: deps.User) -> dict:
    """Change the steward's level (team admin)."""
    team = deps.team_or_404(s, u, slug)
    deps.require_team_admin(s, u, team.id, "change the level")
    st = gateway.steward_for(s, team.id)
    levels.set_level(s, st, body.level, body.reason.strip() or f"Set by {u.name}.", f"user:{u.email}")
    return serial.level_info(s, st)


# ---------------------------------------------------------------- commitments

@router.get("/commitments")
def list_commitments(s: deps.Session, u: deps.User, team: str | None = None, status: str | None = None,
                     risk: str | None = None) -> list[dict]:
    """Ledger rows, filtered by team, status (or 'open'/'closed') and risk."""
    q = sa.select(models.Commitment).where(models.Commitment.org_id == u.org_id)
    if team:
        t = deps.team_or_404(s, u, team)
        q = q.where(sa.or_(models.Commitment.owner_team_id == t.id, models.Commitment.requester_team_id == t.id))
    if status == "open":
        q = q.where(models.Commitment.status.in_(ledger.OPEN_STATUSES))
    elif status == "closed":
        q = q.where(models.Commitment.status.in_(ledger.CLOSED_STATUSES))
    elif status:
        q = q.where(models.Commitment.status == status)
    rows = s.scalars(q.order_by(models.Commitment.updated_at.desc()).limit(LIST_LIMIT))
    idx, now = serial.TeamIndex(s, u.org_id), models.utcnow()
    out = [serial.commitment(c, idx, now) for c in rows]
    return [c for c in out if c["risk"] == risk] if risk else out


class NewCommitment(pydantic.BaseModel):
    team: str
    title: str
    detail: str = ""
    due_at: str | None = None
    owner_person: str | None = None
    priority: str = "normal"
    requester_team: str | None = None


@router.post("/commitments")
def post_commitment(body: NewCommitment, s: deps.Session, u: deps.User) -> dict:
    """Log a commitment by hand."""
    team = deps.team_or_404(s, u, body.team)
    req = deps.team_or_404(s, u, body.requester_team) if body.requester_team else None
    c = ledger.create(s, team=team, title=body.title, detail=body.detail, due_at=_parse_due(body.due_at, team),
                      owner_person=body.owner_person, requester_team=req, requester_person=u.name if req else None,
                      priority=body.priority, status="accepted", source_kind="web", actor=u.name,
                      steward_name=u.name)
    feed.audit(s, u.org_id, f"user:{u.email}", "commitment.created", c.key, c.title, team.id)
    return serial.commitment(c, serial.TeamIndex(s, u.org_id))


def _commitment_or_404(s: sa.orm.Session, u: models.User, key: str) -> models.Commitment:
    c = ledger.get(s, u.org_id, key)
    if c is None:
        raise fastapi.HTTPException(404, f"There's no commitment {key.upper()}.")
    return c


@router.get("/commitments/{key}")
def get_commitment(key: str, s: deps.Session, u: deps.User) -> dict:
    """One commitment with timeline and operations."""
    return serial.commitment_detail(s, _commitment_or_404(s, u, key), serial.TeamIndex(s, u.org_id))


class CommitmentPatch(pydantic.BaseModel):
    status: str | None = None
    due_at: str | None = None
    owner_person: str | None = None
    priority: str | None = None
    note: str | None = None


@router.patch("/commitments/{key}")
def patch_commitment(key: str, body: CommitmentPatch, s: deps.Session, u: deps.User) -> dict:
    """Update status, due date, owner, priority, or add a note."""
    c = _commitment_or_404(s, u, key)
    team = s.get(models.Team, c.owner_team_id)
    fields = body.model_dump(exclude_unset=True)
    clear_due = "due_at" in fields and not body.due_at
    ledger.update(s, c, u.name, status=body.status, due_at=_parse_due(body.due_at, team) if body.due_at else None,
                  owner_person=body.owner_person, priority=body.priority, note=body.note, clear_due=clear_due)
    feed.audit(s, u.org_id, f"user:{u.email}", "commitment.updated", c.key, body.model_dump_json(exclude_none=True),
               c.owner_team_id)
    s.flush()
    s.refresh(c)
    return serial.commitment_detail(s, c, serial.TeamIndex(s, u.org_id))


# ---------------------------------------------------------------- approvals and operations

@router.get("/approvals")
def list_approvals(s: deps.Session, u: deps.User, team: str | None = None, status: str | None = "pending") -> list[dict]:
    """Drafts waiting for a person (or decided ones with status=approved|rejected|all)."""
    q = sa.select(models.Approval).where(models.Approval.org_id == u.org_id)
    if team:
        q = q.where(models.Approval.team_id == deps.team_or_404(s, u, team).id)
    if status and status != "all":
        q = q.where(models.Approval.status == status)
    idx = serial.TeamIndex(s, u.org_id)
    return [serial.approval(s, a, idx) for a in s.scalars(q.order_by(models.Approval.created_at.desc()).limit(LIST_LIMIT))]


def _approval_or_404(s: sa.orm.Session, u: models.User, approval_id: str) -> models.Approval:
    a = s.get(models.Approval, approval_id)
    if a is None or a.org_id != u.org_id:
        raise fastapi.HTTPException(404, "That approval doesn't exist.")
    deps.require_team_member(s, u, a.team_id, "approve its drafts")
    return a


class ApproveBody(pydantic.BaseModel):
    edited_preview: str | None = None


@router.post("/approvals/{approval_id}/approve")
def approve(approval_id: str, s: deps.Session, u: deps.User, body: ApproveBody | None = None) -> dict:
    """Approve (optionally edited) and queue it to send."""
    a = gateway.approve(s, _approval_or_404(s, u, approval_id), u, (body or ApproveBody()).edited_preview)
    return serial.approval(s, a, serial.TeamIndex(s, u.org_id))


class RejectBody(pydantic.BaseModel):
    reason: str = ""


@router.post("/approvals/{approval_id}/reject")
def reject(approval_id: str, s: deps.Session, u: deps.User, body: RejectBody | None = None) -> dict:
    """Reject a draft."""
    a = gateway.reject(s, _approval_or_404(s, u, approval_id), u, (body or RejectBody()).reason)
    return serial.approval(s, a, serial.TeamIndex(s, u.org_id))


@router.get("/operations")
def list_operations(s: deps.Session, u: deps.User, team: str | None = None, status: str | None = None) -> list[dict]:
    """Outgoing writes and their delivery state."""
    q = sa.select(models.Operation).where(models.Operation.org_id == u.org_id)
    if team:
        q = q.where(models.Operation.team_id == deps.team_or_404(s, u, team).id)
    if status:
        q = q.where(models.Operation.status.in_(status.split(",")))
    idx = serial.TeamIndex(s, u.org_id)
    return [serial.operation(op, idx) for op in s.scalars(q.order_by(models.Operation.created_at.desc()).limit(LIST_LIMIT))]


class ResolveBody(pydantic.BaseModel):
    outcome: typing.Literal["done", "retry", "cancel"]


@router.post("/operations/{op_id}/resolve")
def resolve(op_id: str, body: ResolveBody, s: deps.Session, u: deps.User) -> dict:
    """A person settles an unclear or failed operation."""
    op = s.get(models.Operation, op_id)
    if op is None or op.org_id != u.org_id:
        raise fastapi.HTTPException(404, "That operation doesn't exist.")
    deps.require_team_member(s, u, op.team_id, "settle its operations")
    gateway.resolve(s, op, body.outcome, u)
    return serial.operation(op, serial.TeamIndex(s, u.org_id))


# ---------------------------------------------------------------- knowledge, services, briefs, chat

@router.get("/teams/{slug}/knowledge")
def list_knowledge(slug: str, s: deps.Session, u: deps.User) -> list[dict]:
    """Team docs, hiding ones above the person's clearance."""
    team = deps.team_or_404(s, u, slug)
    clearance = steward.clearance_for(s, u, team)
    rows = s.scalars(sa.select(models.KnowledgeDoc).where(models.KnowledgeDoc.team_id == team.id)
                     .order_by(models.KnowledgeDoc.updated_at.desc()))
    return [serial.knowledge_doc(d) for d in rows if labels.audience_allows(clearance, d.label)]


class NewDoc(pydantic.BaseModel):
    title: str
    content: str
    label: str = "internal"
    source: str | None = None


@router.post("/teams/{slug}/knowledge")
def post_knowledge(slug: str, body: NewDoc, s: deps.Session, u: deps.User) -> dict:
    """Add a doc to the team's knowledge."""
    team = deps.team_or_404(s, u, slug)
    deps.require_team_member(s, u, team.id, "add knowledge")
    return serial.knowledge_doc(knowledge.add(s, team, body.title, body.content, body.label, body.source,
                                              actor=f"user:{u.email}"))


class Ask(pydantic.BaseModel):
    question: str


@router.post("/teams/{slug}/ask")
def ask(slug: str, body: Ask, s: deps.Session, u: deps.User) -> dict:
    """Ask the team's knowledge a question. Restricted sources are withheld and counted."""
    from keel import brain, llm

    team = deps.team_or_404(s, u, slug)
    if not body.question.strip():
        raise ValueError("Ask a question first.")
    found = knowledge.search(s, [team.id], body.question, steward.clearance_for(s, u, team))
    st = gateway.steward_for(s, team.id)
    text = brain.answer(llm.for_org(s, u.org_id), body.question, found, steward=st.name, team=team.name)
    return {"answer": text, "label": found.label, "withheld": found.withheld,
            "sources": [{"title": p.title, "source": p.source, "label": p.label} for p in found.passages]}


@router.get("/teams/{slug}/services")
def list_services(slug: str, s: deps.Session, u: deps.User) -> list[dict]:
    """Services the team's steward watches."""
    team = deps.team_or_404(s, u, slug)
    rows = s.scalars(sa.select(models.Service).where(models.Service.team_id == team.id).order_by(models.Service.name))
    return [serial.service(s, svc) for svc in rows]


class NewService(pydantic.BaseModel):
    name: str
    url: str
    owner: str | None = None


@router.post("/teams/{slug}/services")
def post_service(slug: str, body: NewService, s: deps.Session, u: deps.User) -> dict:
    """Start watching a service."""
    team = deps.team_or_404(s, u, slug)
    deps.require_team_admin(s, u, team.id, "add services")
    svc = services.add(s, team, body.name, body.url, body.owner)
    jobs.enqueue(s, u.org_id, "check_service", {"service": svc.id}, dedupe_key=f"check:{svc.id}:first")
    return serial.service(s, svc)


@router.post("/services/{service_id}/runbooks/{runbook_id}/run")
def run_runbook(service_id: str, runbook_id: str, s: deps.Session, u: deps.User) -> dict:
    """Run a runbook through the outbound runner (team admin)."""
    svc = s.get(models.Service, service_id)
    if svc is None or svc.org_id != u.org_id:
        raise fastapi.HTTPException(404, "That service doesn't exist.")
    deps.require_team_admin(s, u, svc.team_id, "run runbooks")
    op = services.run_runbook(s, svc, runbook_id, f"user:{u.email}")
    return serial.operation(op, serial.TeamIndex(s, u.org_id))


@router.get("/teams/{slug}/briefs")
def list_briefs(slug: str, s: deps.Session, u: deps.User) -> list[dict]:
    """Briefs, newest first."""
    team = deps.team_or_404(s, u, slug)
    idx = serial.TeamIndex(s, u.org_id)
    rows = s.scalars(sa.select(models.Brief).where(models.Brief.team_id == team.id)
                     .order_by(models.Brief.created_at.desc()).limit(60))
    return [serial.brief(b, idx) for b in rows]


class BriefBody(pydantic.BaseModel):
    kind: typing.Literal["daily", "weekly"] = "daily"


@router.post("/teams/{slug}/briefs")
def post_brief(slug: str, body: BriefBody, s: deps.Session, u: deps.User) -> dict:
    """Write (or refresh) today's brief now."""
    team = deps.team_or_404(s, u, slug)
    b = rhythm.make_brief(s, team, body.kind, post=False)
    return serial.brief(b, serial.TeamIndex(s, u.org_id))


@router.get("/teams/{slug}/chat")
def get_chat(slug: str, s: deps.Session, u: deps.User) -> list[dict]:
    """Front-desk history."""
    team = deps.team_or_404(s, u, slug)
    rows = list(s.scalars(sa.select(models.ChatMessage).where(models.ChatMessage.team_id == team.id)
                          .order_by(models.ChatMessage.at.desc()).limit(CHAT_LIMIT)))[::-1]
    return [serial.chat_message(m) for m in rows]


class ChatBody(pydantic.BaseModel):
    message: str


@router.post("/teams/{slug}/chat")
def post_chat(slug: str, body: ChatBody, s: deps.Session, u: deps.User) -> list[dict]:
    """Talk to the steward."""
    team = deps.team_or_404(s, u, slug)
    return [serial.chat_message(m) for m in steward.chat(s, team, u, body.message)]


# ---------------------------------------------------------------- audit, checkups, demo

@router.get("/audit")
def list_audit(s: deps.Session, u: deps.User, team: str | None = None) -> list[dict]:
    """Audit log, newest first."""
    q = sa.select(models.AuditLog).where(models.AuditLog.org_id == u.org_id)
    if team:
        q = q.where(models.AuditLog.team_id == deps.team_or_404(s, u, team).id)
    idx = serial.TeamIndex(s, u.org_id)
    return [serial.audit(a, idx) for a in s.scalars(q.order_by(models.AuditLog.at.desc()).limit(AUDIT_LIMIT))]


class CheckupBody(pydantic.BaseModel):
    repo: str


@router.post("/checkups")
def post_checkup(body: CheckupBody, s: deps.Session, u: deps.User) -> dict:
    """Start a repo checkup; poll GET /checkups/{id}."""
    repo = body.repo.strip().removeprefix("https://github.com/").strip("/")
    row = models.Checkup(org_id=u.org_id, repo=repo)
    s.add(row)
    s.flush()
    jobs.enqueue(s, u.org_id, "checkup", {"checkup": row.id}, dedupe_key=f"checkup:{row.id}")
    feed.audit(s, u.org_id, f"user:{u.email}", "checkup.started", repo)
    return serial.checkup(row)


@router.get("/checkups")
def list_checkups(s: deps.Session, u: deps.User) -> list[dict]:
    """Past checkups."""
    rows = s.scalars(sa.select(models.Checkup).where(models.Checkup.org_id == u.org_id)
                     .order_by(models.Checkup.created_at.desc()).limit(50))
    return [serial.checkup(c) for c in rows]


@router.get("/checkups/{checkup_id}")
def get_checkup(checkup_id: str, s: deps.Session, u: deps.User) -> dict:
    """One checkup."""
    row = s.get(models.Checkup, checkup_id)
    if row is None or row.org_id != u.org_id:
        raise fastapi.HTTPException(404, "That checkup doesn't exist.")
    return serial.checkup(row)


@router.post("/demo/tick")
def demo_tick(u: deps.User) -> dict:
    """Play the next scripted demo event (demo orgs only)."""
    from keel import db

    with db.session() as s:
        org = s.get(models.Org, u.org_id)
        if not org.settings.get("demo"):
            raise fastapi.HTTPException(400, "This only works in demo mode.")
        before = s.scalar(sa.select(sa.func.max(models.Activity.id))) or 0
        title = demo.tick(s, org)
    worker.drain()
    with db.session() as s:
        idx = serial.TeamIndex(s, u.org_id)
        latest = s.scalar(sa.select(models.Activity).where(models.Activity.org_id == u.org_id,
                                                           models.Activity.id > before)
                          .order_by(models.Activity.id.desc()))
        return {"event": serial.activity(latest, idx) if latest else None, "title": title,
                "remaining": len(demo.STEPS) - int(s.get(models.Org, u.org_id).settings.get("demo_step", 0))}
