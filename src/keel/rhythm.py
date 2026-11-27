"""Team rhythm: daily and weekly briefs, and nudges on commitments that slip.

Brief facts are computed from the database; the model writes at most the opening headline.
"""

from __future__ import annotations

import datetime as dt
import zoneinfo

import sqlalchemy as sa
from sqlalchemy import orm

from keel import brain, feed, gateway, ledger, llm, models, steward

NUDGE_COOLDOWN = dt.timedelta(hours=24)  # One reminder a day per commitment; more feels like nagging.
WEEKLY_BRIEF_WEEKDAY = 0  # Monday: the week's plan is set then.
BRIEF_LIST_LIMIT = 6  # Lines per brief section; the rest is one click away on the ledger.
RECENT_DONE_WINDOW = dt.timedelta(days=1)
WEEK = dt.timedelta(days=7)


def _period(kind: str, now_local: dt.datetime) -> str:
    if kind == "weekly":
        year, week, _ = now_local.isocalendar()
        return f"{year}-W{week:02d}"
    return now_local.date().isoformat()


def facts(session: orm.Session, team: models.Team, kind: str, now: dt.datetime | None = None) -> dict:
    """Numbers and lists for a brief, straight from the ledger and services."""
    now = now or models.utcnow()
    window = WEEK if kind == "weekly" else RECENT_DONE_WINDOW
    open_rows = ledger.open_for_team(session, team.id)
    done = list(session.scalars(sa.select(models.Commitment).where(
        models.Commitment.owner_team_id == team.id, models.Commitment.status == "done",
        models.Commitment.closed_at >= now - window).order_by(models.Commitment.closed_at.desc())))
    outgoing = list(session.scalars(sa.select(models.Commitment).where(
        models.Commitment.requester_team_id == team.id, models.Commitment.status.in_(ledger.OPEN_STATUSES))))
    pending = session.scalar(sa.select(sa.func.count()).select_from(models.Approval).where(
        models.Approval.team_id == team.id, models.Approval.status == "pending")) or 0
    services = list(session.scalars(sa.select(models.Service).where(models.Service.team_id == team.id)))
    teams = {t.id: t for t in session.scalars(sa.select(models.Team).where(models.Team.org_id == team.org_id))}
    return {
        "open": len(open_rows),
        "overdue": sum(ledger.risk(c, now) == "overdue" for c in open_rows),
        "at_risk": sum(ledger.risk(c, now) == "at_risk" for c in open_rows),
        "needs_you": pending,
        "done": len(done),
        "services_down": [s.name for s in services if s.state == "down"],
        "risky": [(c.key, c.title, ledger.risk(c, now), c.due_at, c.owner_person) for c in open_rows
                  if ledger.risk(c, now) in ("overdue", "at_risk")],
        "done_items": [(c.key, c.title) for c in done],
        "incoming": [(c.key, c.title, teams[c.requester_team_id].name, c.status) for c in open_rows
                     if c.requester_team_id in teams],
        "outgoing": [(c.key, c.title, teams[c.owner_team_id].name, ledger.risk(c, now)) for c in outgoing
                     if c.owner_team_id in teams],
    }


def _lines(items: list, fmt) -> list[str]:
    out = [fmt(x) for x in items[:BRIEF_LIST_LIMIT]]
    if len(items) > BRIEF_LIST_LIMIT:
        out.append(f"- …and {len(items) - BRIEF_LIST_LIMIT} more")
    return out


def render(team: models.Team, st: models.Steward, kind: str, f: dict, headline: str, now_local: dt.datetime) -> tuple[str, str]:
    """Title and markdown for a brief."""
    title = (f"{team.name} · week of {now_local:%b %d}" if kind == "weekly" else f"{team.name} · {now_local:%A, %b %d}")
    md = [f"**{headline}**", ""]
    md.append(f"{f['open']} open · {f['at_risk']} at risk · {f['overdue']} overdue · "
              f"{f['done']} done {'this week' if kind == 'weekly' else 'since yesterday'}")
    if f["services_down"]:
        md += ["", "### Services", *[f"- 🔴 {name} is down" for name in f["services_down"]]]
    if f["risky"]:
        md += ["", "### Needs attention", *_lines(f["risky"], lambda r: (
            f"- {'🔴' if r[2] == 'overdue' else '🟠'} **{r[0]}** {r[1]}"
            + (f" · due {r[3]:%a %b %d}" if r[3] else "") + (f" · {r[4]}" if r[4] else "")))]
    if f["incoming"]:
        md += ["", "### Asked of us", *_lines(f["incoming"], lambda r: f"- **{r[0]}** {r[1]} · from {r[2]} · {r[3].replace('_', ' ')}")]
    if f["outgoing"]:
        md += ["", "### Waiting on others", *_lines(f["outgoing"], lambda r: f"- **{r[0]}** {r[1]} · {r[2]} · {r[3].replace('_', ' ')}")]
    if f["done_items"]:
        md += ["", "### Done", *_lines(f["done_items"], lambda r: f"- ✅ **{r[0]}** {r[1]}")]
    if f["needs_you"]:
        md += ["", f"{f['needs_you']} draft{'s' if f['needs_you'] != 1 else ''} from {st.name} wait for approval."]
    return title, "\n".join(md)


def make_brief(session: orm.Session, team: models.Team, kind: str = "daily", post: bool = True,
               now: dt.datetime | None = None) -> models.Brief:
    """Build (or return today's) brief for a team and propose posting it to the team channel."""
    if kind not in ("daily", "weekly"):
        raise ValueError("kind must be daily or weekly")
    now = now or models.utcnow()
    local = now.astimezone(zoneinfo.ZoneInfo(team.timezone))
    period = _period(kind, local)
    existing = session.scalar(sa.select(models.Brief).where(models.Brief.team_id == team.id, models.Brief.kind == kind,
                                                            models.Brief.period == period))
    st = gateway.steward_for(session, team.id)
    f = facts(session, team, kind, now)
    model_facts = {k: v for k, v in f.items() if isinstance(v, (int, list)) and k not in ("risky", "incoming", "outgoing", "done_items")}
    model_facts["risky"] = [f"{r[0]} {r[1]} ({r[2]})" for r in f["risky"]]
    head = brain.headline(llm.for_org(session, team.org_id), model_facts, steward=st.name, team=team.name)
    title, md = render(team, st, kind, f, head, local)
    if existing is not None:
        existing.title, existing.markdown, existing.data = title, md, {"headline": head}
        brief = existing
        feed.activity(session, team.org_id, team.id, "brief", "🔁",
                      f"{st.name} refreshed the {kind} brief for {team.name}", f"/teams/{team.slug}?tab=briefs")
    else:
        brief = models.Brief(org_id=team.org_id, team_id=team.id, kind=kind, title=title, markdown=md,
                             data={"headline": head}, period=period)
        session.add(brief)
        session.flush()
        feed.activity(session, team.org_id, team.id, "brief", "☀️" if kind == "daily" else "🗓️",
                      f"{st.name} wrote the {kind} brief for {team.name}", f"/teams/{team.slug}?tab=briefs")
        if post:
            steward.say(session, team, f"*{title}*\n{md}", op_id=f"brief:{team.id}:{kind}:{period}", kind="brief.post")
    return brief


def due_briefs(session: orm.Session, now: dt.datetime | None = None) -> list[tuple[str, str]]:
    """(team_id, kind) pairs whose brief hour has come today and that have no brief yet."""
    now = now or models.utcnow()
    out = []
    for team in session.scalars(sa.select(models.Team)):
        st = session.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
        if st is None or "rhythm" not in (st.duties or []):
            continue
        local = now.astimezone(zoneinfo.ZoneInfo(team.timezone))
        if local.weekday() >= 5 or local.hour < team.brief_hour:
            continue
        kinds = ["daily"] + (["weekly"] if local.weekday() == WEEKLY_BRIEF_WEEKDAY else [])
        for kind in kinds:
            exists = session.scalar(sa.select(models.Brief.id).where(
                models.Brief.team_id == team.id, models.Brief.kind == kind, models.Brief.period == _period(kind, local)))
            if exists is None:
                out.append((team.id, kind))
    return out


def nudge(session: orm.Session, now: dt.datetime | None = None) -> int:
    """Remind owners of at-risk or overdue commitments, at most once per NUDGE_COOLDOWN. Returns count."""
    now = now or models.utcnow()
    count = 0
    rows = session.scalars(sa.select(models.Commitment).where(models.Commitment.status.in_(ledger.OPEN_STATUSES)))
    for c in rows:
        r = ledger.risk(c, now)
        if r not in ("at_risk", "overdue"):
            continue
        if c.last_nudged_at is not None and now - c.last_nudged_at < NUDGE_COOLDOWN:
            continue
        team = session.get(models.Team, c.owner_team_id)
        st = session.scalar(sa.select(models.Steward).where(models.Steward.team_id == c.owner_team_id))
        if team is None or st is None or "ledger" not in (st.duties or []):
            continue
        who = f"{c.owner_person}, " if c.owner_person else ""
        when = f"was due {c.due_at:%a %b %d}" if r == "overdue" else (f"is due {c.due_at:%a %b %d}" if c.due_at else "is blocked")
        text = f"{who}{c.key} ({c.title}) {when}. Still on track? Reply with a new date or 'done'."
        steward.say(session, team, text, op_id=f"nudge:{c.id}:{now:%Y-%m-%d}", kind="slack.nudge", commitment=c)
        c.last_nudged_at = now
        ledger.add_event(session, c, st.name, "nudge", f"Reminded{(' ' + c.owner_person) if c.owner_person else ''}")
        count += 1
    return count
