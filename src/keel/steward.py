"""The steward: turns team messages into ledger entries, answers at the front desk, and drafts writes.

Every write it wants to make goes through :mod:`keel.gateway`; the agent framework never calls Slack or
GitHub itself. Facts (commitments, dates, service states) come from the database, not the model.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import re
import typing
import zoneinfo

import sqlalchemy as sa
from langchain_core import language_models
from langchain_core import tools as lc_tools
from sqlalchemy import orm

from keel import brain, config, feed, gateway, knowledge, labels, learning, ledger, llm, models

log = logging.getLogger(__name__)

CHAT_HISTORY_TURNS = 12  # Recent turns the model sees; older context lives in the ledger, not the chat.
LIST_LIMIT = 8  # Items a steward lists in one chat reply before pointing to the ledger page.
AGENT_RECURSION_LIMIT = 16  # Tool loops stop here; a front-desk question never needs more steps.


def clearance_for(session: orm.Session, user: models.User | None, team: models.Team) -> str:
    """Highest label a person may see from this team's steward: members get team clearance, others org."""
    if user is None:
        return labels.audience_max_for_target("org")
    member = session.get(models.TeamMember, {"team_id": team.id, "user_id": user.id})
    if member is not None or user.role == "org_admin":
        return labels.audience_max_for_target("team")
    return labels.audience_max_for_target("org")


def team_by_slug(session: orm.Session, org_id: str, slug: str) -> models.Team | None:
    """Find a team by slug (case-insensitive)."""
    return session.scalar(
        sa.select(models.Team).where(
            models.Team.org_id == org_id, models.Team.slug == slug.lower().lstrip("#@")
        )
    )


def other_team_slugs(session: orm.Session, team: models.Team) -> tuple[str, ...]:
    """Slugs of the org's other teams."""
    return tuple(
        session.scalars(
            sa.select(models.Team.slug).where(models.Team.org_id == team.org_id, models.Team.id != team.id)
        )
    )


def channel_label(team: models.Team) -> str:
    """How the team's channel reads in the UI: '#payments (14 people)'."""
    name = team.slack_channel_name or f"#{team.slug}"
    name = name if name.startswith("#") else f"#{name}"
    return f"{name} ({team.slack_member_count} people)" if team.slack_member_count else name


def due_from_iso(day: str | None, team: models.Team) -> dt.datetime | None:
    """Turn YYYY-MM-DD from triage into end of that working day in the team's timezone."""
    if not day:
        return None
    try:
        d = dt.date.fromisoformat(day[:10])
    except ValueError:
        return None
    zone = zoneinfo.ZoneInfo(team.timezone)
    return dt.datetime.combine(d, dt.time(brain.DUE_HOUR_LOCAL), zone).astimezone(dt.UTC)


def say(
    session: orm.Session,
    team: models.Team,
    text: str,
    *,
    op_id: str,
    kind: str = "slack.post_team",
    thread_ts: str | None = None,
    commitment: models.Commitment | None = None,
    label: str = "internal",
    extra: dict[str, typing.Any] | None = None,
    context: str | None = None,
    channel: str | None = None,
    channel_label_text: str | None = None,
    audience_kind: str = "team",
) -> models.Operation | None:
    """Propose a message in the team's channel through the gateway. None when the team has no channel.

    ``context`` is the message being answered; if a person edits or rejects the draft, the lesson keeps it.
    ``channel`` sends it somewhere else instead (a DM with the person who asked), labelled ``channel_label_text``.
    """
    org = session.get(models.Org, team.org_id)
    demo = bool(org and org.settings.get("demo"))
    if not channel and not team.slack_channel_id and not demo:
        return None
    payload: dict[str, typing.Any] = {
        "channel": channel or team.slack_channel_id or f"sim-{team.slug}",
        "text": text,
    }
    if thread_ts:
        payload["thread_ts"] = thread_ts
    payload.update(extra or {})
    return gateway.propose(
        session,
        gateway.Proposal(
            team=team,
            kind=kind,
            target=channel_label_text or team.slack_channel_name or f"#{team.slug}",
            payload=payload,
            summary=text.splitlines()[0][:200],
            op_id=op_id,
            label=label,
            audience_kind=audience_kind,
            audience=channel_label_text or channel_label(team),
            commitment=commitment,
            idempotent=False,
            context=context,
        ),
    )


def ask_team(
    session: orm.Session,
    team: models.Team,
    to_slug: str,
    title: str,
    *,
    op_id: str,
    detail: str = "",
    due_at: dt.datetime | None = None,
    requester_person: str | None = None,
    priority: str = "normal",
    actor: str = "steward",
) -> models.Operation:
    """Ask another team's steward for work. Lands as a proposed commitment in their ledger."""
    target = team_by_slug(session, team.org_id, to_slug)
    if target is None:
        raise ValueError(f"There's no team called {to_slug}.")
    if target.id == team.id:
        raise ValueError("That's this team. Log it as a commitment instead.")
    return gateway.propose(
        session,
        gateway.Proposal(
            team=team,
            kind="crossteam.request",
            target=target.name,
            op_id=op_id,
            actor=actor,
            payload={
                "to_team": target.slug,
                "title": title,
                "detail": detail,
                "priority": priority,
                "due_at": due_at.isoformat() if due_at else None,
                "requester_person": requester_person,
                "label": "internal",
            },
            summary=f"Ask {target.name}: {title}",
            label="internal",
            audience_kind="org",
            audience=f"{target.name} team",
            idempotent=True,
            context=detail or title,
        ),
    )


# ---------------------------------------------------------------- inbox (Slack / GitHub messages)


@dataclasses.dataclass
class Handled:
    """What the steward did with one message."""

    outcome: str
    commitment: models.Commitment | None = None
    reply: str | None = None


def handle_message(
    session: orm.Session,
    team: models.Team,
    text: str,
    *,
    source_ref: str,
    person: str | None,
    source_kind: str = "slack",
    source_url: str | None = None,
    thread_ts: str | None = None,
    model: language_models.BaseChatModel | None = None,
    directed: bool = False,
    channel: str | None = None,
    in_thread: bool = False,
    reply_channel: str | None = None,
    reply_label: str | None = None,
    mention: str | None = None,
    clearance: str | None = None,
) -> Handled:
    """Triage one channel message and act on it. ``directed`` = the steward was @-mentioned or DM'd.

    ``channel`` and ``in_thread`` let a teammate's reply under an open question become its suggested answer.
    The team's lessons shape triage and answers (see :mod:`keel.learning`).
    ``reply_channel`` answers in a DM instead of the team channel; ``mention`` (a Slack user id) is tagged in
    replies that can't sit under the message (slash commands); ``clearance`` caps what a DM answer may cite.
    """
    steward = gateway.steward_for(session, team.id)
    thread_ref = f"{channel}:{thread_ts}" if channel and thread_ts else None
    harvested = (
        learning.harvest(session, team, thread_ref, text, person) if in_thread and thread_ref else None
    )
    open_keys = tuple(c.key for c in ledger.open_for_team(session, team.id))
    lessons = learning.relevant(session, team.id, text, labels.audience_max_for_target("team"))
    t = brain.triage(
        model,
        text,
        steward=steward.name,
        team=team.name,
        now=models.utcnow(),
        tz=team.timezone,
        team_slugs=other_team_slugs(session, team),
        open_keys=open_keys,
        lessons=learning.render(lessons),
    )
    threshold = learning.NOT_WORK_MATCH if model is not None else learning.NOT_WORK_MATCH_RULES
    if t.kind in ("request", "promise") and learning.not_work_match(lessons, text, threshold):
        t = brain.Triage(kind="chatter")
    if harvested is not None and t.kind in ("chatter", "question"):
        return Handled(outcome="gap_answer")
    handled = Handled(outcome=t.kind)
    if steward.level == 0:
        # Observe: keep the ledger, send nothing.
        directed = False

    if t.kind in ("request", "promise", "incident") and t.title:
        due = due_from_iso(t.due, team)
        if t.for_team and t.for_team != team.slug and team_by_slug(session, team.org_id, t.for_team):
            ask_team(
                session,
                team,
                t.for_team,
                t.title,
                op_id=f"{source_ref}:ask",
                detail=text,
                due_at=due,
                requester_person=person,
                priority=t.priority,
            )
            handled.outcome = "crossteam"
            handled.reply = t.reply or f"I'll ask {t.for_team} and track it."
        else:
            c = ledger.create(
                session,
                team=team,
                title=t.title,
                detail=text,
                due_at=due,
                owner_person=t.owner_person or (person if t.kind == "promise" else None),
                requester_person=person if t.kind == "request" else None,
                priority="urgent" if t.kind == "incident" else t.priority,
                status="accepted" if t.kind == "promise" else "proposed",
                source_kind=source_kind,
                source_url=source_url,
                source_ref=source_ref,
                actor=steward.name,
                steward_name=steward.name,
            )
            handled.commitment = c
            handled.reply = f"{c.key}: {t.reply or 'Logged.'}"
    elif t.kind == "update" and t.commitment_key:
        c = ledger.get(session, team.org_id, t.commitment_key)
        if c is not None and t.new_status:
            ledger.update(
                session, c, person or steward.name, status=t.new_status, note=f"From chat: {text[:200]}"
            )
            handled.commitment = c
            handled.reply = t.reply or f"Updated {c.key}."
        else:
            handled.reply = f"I can't find {t.commitment_key}." if c is None else None
    elif t.kind == "question" and directed:
        found = knowledge.search(
            session, [team.id], text, clearance or labels.audience_max_for_target("team")
        )
        answer = learning.answer(
            session,
            team,
            model,
            text,
            found,
            steward=steward.name,
            asked_by=person or "",
            thread_ref=thread_ref,
            lessons=learning.render(lessons),
        )
        handled.reply = answer.text
        if answer.gap is None:
            handled.reply += source_footer(found.passages, team)
    if handled.reply and (directed or handled.commitment is not None or handled.outcome == "crossteam"):
        say(
            session,
            team,
            f"<@{mention}> {handled.reply}" if mention else handled.reply,
            op_id=f"{source_ref}:reply",
            kind="slack.reply_thread",
            thread_ts=thread_ts,
            commitment=handled.commitment,
            context=text,
            channel=reply_channel,
            channel_label_text=reply_label,
            audience_kind="org"
            if clearance and clearance != labels.audience_max_for_target("team")
            else "team",
        )
    return handled


SOURCE_LINKS = 3  # Enough to check the answer; more turns a reply into a reading list.


def source_footer(passages: list[knowledge.Passage], team: models.Team) -> str:
    """'Sources: <link|title> · …' in Slack's link format, one per doc. Empty when nothing was cited."""
    seen: dict[str, str] = {}
    for p in passages:
        if p.doc_id not in seen and len(seen) < SOURCE_LINKS:
            seen[p.doc_id] = f"<{knowledge.link(p, team.slug, config.get().base_url)}|{p.title}>"
    return f"\n\nSources: {' · '.join(seen.values())}" if seen else ""


def process_inbox(event_id: str, session: orm.Session) -> str:
    """Handle one stored inbound event. Safe to run twice: the event is marked processed."""
    ev = session.get(models.InboxEvent, event_id)
    if ev is None or ev.processed_at is not None:
        return "skipped"
    p = ev.payload
    team = session.get(models.Team, ev.team_id) if ev.team_id else None
    if team is None:
        ev.processed_at, ev.outcome = models.utcnow(), "no team for this channel"
        feed.INBOX_EVENTS.labels(source=ev.source, result="no_team").inc()
        return ev.outcome
    model = llm.for_org(session, ev.org_id)
    parent = p.get("thread_ts")
    in_thread = bool(parent) and parent != p.get("ts")
    is_dm = ev.source == "slack" and (p.get("channel") or "").startswith("D")
    asker = (
        session.scalar(
            sa.select(models.User).where(
                models.User.org_id == ev.org_id, models.User.slack_user_id == p.get("user")
            )
        )
        if is_dm and p.get("user")
        else None
    )
    res = handle_message(
        session,
        team,
        p.get("text", ""),
        source_ref=f"{ev.source}:{ev.external_id}",
        person=p.get("user_name") or p.get("user"),
        source_kind=ev.source,
        source_url=p.get("permalink"),
        thread_ts=(parent if in_thread else None) if is_dm else (p.get("thread_ts") or p.get("ts")),
        model=model,
        directed=bool(p.get("directed")),
        channel=p.get("channel"),
        in_thread=in_thread,
        reply_channel=p.get("channel") if is_dm else None,
        reply_label=f"DM with {p.get('user_name') or 'a teammate'}" if is_dm else None,
        mention=p.get("user") if ev.source == "slack" and not p.get("ts") and not is_dm else None,
        clearance=clearance_for(session, asker, team) if is_dm else None,
    )
    ev.processed_at, ev.outcome = models.utcnow(), res.outcome
    feed.INBOX_EVENTS.labels(source=ev.source, result=res.outcome).inc()
    if res.outcome not in ("chatter", "gap_answer"):
        feed.activity(
            session,
            ev.org_id,
            team.id,
            "inbox",
            "💬",
            f"Read a {ev.source.title()} message: {res.outcome}"
            + (f" → {res.commitment.key}" if res.commitment else ""),
            f"/commitments/{res.commitment.key}" if res.commitment else None,
        )
    return res.outcome


# ---------------------------------------------------------------- front desk chat (web)


@dataclasses.dataclass
class Turn:
    """A steward reply with the sources it used and the actions it took."""

    text: str
    sources: list[dict[str, str]] = dataclasses.field(default_factory=list)
    actions: list[dict[str, str | None]] = dataclasses.field(default_factory=list)
    label: str = "public"
    withheld: int = 0


def _fmt_commitment(c: models.Commitment, tz: str = "UTC") -> str:
    due = f", due {ledger.day(c.due_at, tz)}" if c.due_at else ""
    who = f", {c.owner_person}" if c.owner_person else ""
    return f"{c.key} {c.title} ({c.status.replace('_', ' ')}{due}{who}; {ledger.risk(c).replace('_', ' ')})"


class Desk:
    """Tools a steward uses at the front desk, bound to one session, team and person."""

    def __init__(
        self, session: orm.Session, team: models.Team, user: models.User | None, turn_id: str
    ) -> None:
        self.s, self.team, self.user, self.turn_id = session, team, user, turn_id
        self.clearance = clearance_for(session, user, team)
        self.steward = gateway.steward_for(session, team.id)
        self.turn = Turn(text="")
        self._n = 0

    @property
    def actor(self) -> str:
        return f"user:{self.user.email}" if self.user else "steward"

    def _op_id(self, what: str) -> str:
        self._n += 1
        return f"chat:{self.turn_id}:{self._n}:{what}"

    def _search(self, query: str) -> knowledge.SearchResult:
        found = knowledge.search(self.s, [self.team.id], query, self.clearance)
        self.turn.withheld = max(self.turn.withheld, found.withheld)
        for p in found.passages:
            if p.title not in {x["title"] for x in self.turn.sources}:
                self.turn.sources.append({"title": p.title, "source": p.source, "label": p.label})
        self.turn.label = labels.strictest([self.turn.label, found.label])
        return found

    def search_knowledge(self, query: str) -> str:
        """Search this team's notes, runbooks and decisions. Returns passages with titles to cite."""
        found = self._search(query)
        if not found.passages:
            return "No matching notes." + (
                f" {found.withheld} matching doc(s) are above this person's clearance."
                if found.withheld
                else ""
            )
        return "\n\n".join(f"[{p.title}]\n{p.text}" for p in found.passages)

    def list_commitments(self, which: str = "open") -> str:
        """List this team's commitments. which: open | at_risk | overdue | incoming (from other teams) | outgoing."""
        if which == "outgoing":
            rows = list(
                self.s.scalars(
                    sa.select(models.Commitment).where(
                        models.Commitment.requester_team_id == self.team.id,
                        models.Commitment.status.in_(ledger.OPEN_STATUSES),
                    )
                )
            )
        else:
            rows = ledger.open_for_team(self.s, self.team.id)
            if which in ("at_risk", "overdue"):
                rows = [c for c in rows if ledger.risk(c) == which]
            elif which == "incoming":
                rows = [c for c in rows if c.requester_team_id]
        if not rows:
            return f"Nothing {which.replace('_', ' ')}."
        lines = [_fmt_commitment(c, self.team.timezone) for c in rows[:LIST_LIMIT]]
        more = f"\n…and {len(rows) - LIST_LIMIT} more on the ledger page." if len(rows) > LIST_LIMIT else ""
        return "\n".join(lines) + more

    def get_commitment(self, key: str) -> str:
        """Details and timeline of one commitment by key, like C-88."""
        c = ledger.get(self.s, self.team.org_id, key)
        if c is None:
            return f"No commitment {key}."
        events = "\n".join(f"- {e.at:%b %d %H:%M} {e.actor}: {e.text}" for e in c.events[-6:])
        return f"{_fmt_commitment(c, self.team.timezone)}\n{c.detail[:400]}\nTimeline:\n{events}"

    def log_commitment(
        self, title: str, due: str | None = None, owner_person: str | None = None, priority: str = "normal"
    ) -> str:
        """Log new work this team will do. due: YYYY-MM-DD or words like 'Friday'. priority: low|normal|high|urgent."""
        due_at = (
            due_from_iso(due, self.team)
            if due and re.match(r"\d{4}-\d\d-\d\d", due)
            else (brain.parse_due(due, models.utcnow(), self.team.timezone) if due else None)
        )
        c = ledger.create(
            self.s,
            team=self.team,
            title=title,
            due_at=due_at,
            owner_person=owner_person,
            requester_person=self.user.name if self.user else None,
            priority=priority,
            source_kind="web",
            source_ref=self._op_id("log"),
            actor=self.steward.name,
            steward_name=self.steward.name,
        )
        self.turn.actions.append(
            {"kind": "commitment", "text": f"Logged {c.key}: {c.title}", "link": f"/commitments/{c.key}"}
        )
        return f"Logged {_fmt_commitment(c, self.team.timezone)}"

    def update_commitment(
        self, key: str, status: str | None = None, due: str | None = None, note: str | None = None
    ) -> str:
        """Change a commitment's status (accepted|in_progress|blocked|done|dropped), due date, or add a note."""
        c = ledger.get(self.s, self.team.org_id, key)
        if c is None:
            return f"No commitment {key}."
        due_at = brain.parse_due(due, models.utcnow(), self.team.timezone) if due else None
        try:
            ledger.update(
                self.s,
                c,
                self.user.name if self.user else self.steward.name,
                status=status,
                due_at=due_at,
                note=note,
            )
        except ValueError as exc:
            return str(exc)
        self.turn.actions.append(
            {"kind": "commitment", "text": f"Updated {c.key}", "link": f"/commitments/{c.key}"}
        )
        return f"Updated {_fmt_commitment(c, self.team.timezone)}"

    def ask_team(self, team: str, title: str, due: str | None = None, detail: str = "") -> str:
        """Ask another team (by slug) for work. Their steward logs it in their ledger; we track it."""
        due_at = brain.parse_due(due, models.utcnow(), self.team.timezone) if due else None
        try:
            op = ask_team(
                self.s,
                self.team,
                team,
                title,
                op_id=self._op_id("ask"),
                detail=detail,
                due_at=due_at,
                requester_person=self.user.name if self.user else None,
                actor=self.actor,
            )
        except ValueError as exc:
            return str(exc)
        if op.status == "awaiting_approval":
            self.turn.actions.append(
                {
                    "kind": "approval",
                    "text": f"Drafted a request to {team}; it waits for approval",
                    "link": "/approvals",
                }
            )
            return f"Drafted. It waits for approval because {self.steward.name} is at L{self.steward.level}."
        self.turn.actions.append(
            {"kind": "operation", "text": f"Asked {team}: {title}", "link": "/operations"}
        )
        return f"Sent to {team}'s steward. It will show up in their ledger."

    def service_status(self) -> str:
        """Current state of this team's services and any open incidents."""
        rows = list(self.s.scalars(sa.select(models.Service).where(models.Service.team_id == self.team.id)))
        if not rows:
            return "This team has no services registered."
        out = []
        for svc in rows:
            inc = self.s.scalar(
                sa.select(models.Incident).where(
                    models.Incident.service_id == svc.id, models.Incident.resolved_at.is_(None)
                )
            )
            out.append(
                f"{svc.name}: {svc.state}"
                + (f" (incident open since {inc.opened_at:%H:%M} UTC)" if inc else "")
            )
        return "\n".join(out)

    def draft_post(self, text: str) -> str:
        """Post a message in this team's channel. It goes through approval unless the steward's level allows it."""
        op = say(self.s, self.team, text, op_id=self._op_id("post"), label="internal")
        if op is None:
            return "This team has no channel connected."
        if op.status == "rejected":
            return op.error_line or "Blocked."
        verb = "Drafted for approval" if op.status == "awaiting_approval" else "Queued to post"
        self.turn.actions.append(
            {
                "kind": "approval" if op.status == "awaiting_approval" else "operation",
                "text": f"{verb}: {op.summary}",
                "link": "/approvals",
            }
        )
        return f"{verb}."

    def note_open_question(self, question: str) -> str:
        """Log a question the notes don't answer as an open question for the team, so someone fills it in.

        Use it whenever search_knowledge doesn't answer what the person asked.
        """
        if not question.strip():
            return "Say the question first."
        gap = learning.log_gap(
            self.s, self.team, question, asked_by=self.user.name if self.user else "a visitor"
        )
        self.turn.actions.append(
            {
                "kind": "question",
                "text": "Added to open questions" + (f" (asked {gap.count}×)" if gap.count > 1 else ""),
                "link": f"/teams/{self.team.slug}/learning",
            }
        )
        return f"Logged as an open question for {self.team.name}."

    def tools(self) -> list[lc_tools.BaseTool]:
        """The desk methods as LangChain tools."""
        return [
            lc_tools.StructuredTool.from_function(getattr(self, name))
            for name in (
                "search_knowledge",
                "list_commitments",
                "get_commitment",
                "log_commitment",
                "update_commitment",
                "ask_team",
                "service_status",
                "draft_post",
                "note_open_question",
            )
        ]


CHAT_PROMPT = """You are {steward}, the AI steward of the {team} team at {org}. You keep the team's
commitments ledger, answer questions from the team's notes, ask other teams for work, watch services, and
draft posts. You are at level L{level} ({level_name}): {can}

Rules:
- Use tools for facts. Never invent commitments, dates, owners, or service states.
- Log work only when the person clearly asks for it or commits to it.
- Cite notes as [Title] when you use them. If notes don't cover it, say so plainly and call note_open_question.
- Other teams: {teams}.
- Today is {today} in {tz}. The person talking to you: {person}.
- Replies are short (one to four sentences or a short list), calm and plain. No emoji."""


def _rule_chat(desk: Desk, text: str) -> None:
    t = text.strip()
    low = t.lower()
    others = other_team_slugs(desk.s, desk.team)
    if m := re.match(
        r"^(?:please\s+)?ask\s+(?:@|#)?([a-z0-9\-]+)(?:\s+team)?\s+(?:to\s+)?(.+)$", t, re.IGNORECASE
    ):
        due = brain.parse_due(m[2], models.utcnow(), desk.team.timezone)
        title = brain.title_from(m[2])
        desk.turn.text = desk.ask_team(m[1].lower(), title, due=m[2] if due else None, detail=t)
        return
    if m := re.search(r"\b(C-\d+)\b", t, re.IGNORECASE):
        tri = brain.rule_triage(t, models.utcnow(), desk.team.timezone, others)
        if tri.kind == "update" and tri.new_status:
            desk.turn.text = desk.update_commitment(m[1], status=tri.new_status)
        else:
            desk.turn.text = desk.get_commitment(m[1])
        return
    if re.search(r"\b(at risk|risky)\b", low):
        desk.turn.text = desk.list_commitments("at_risk")
        return
    if "overdue" in low or "late" in low:
        desk.turn.text = desk.list_commitments("overdue")
        return
    if re.search(
        r"\b(what'?s open|open items|status|what are we (on|doing|working on)|ledger|commitments)\b", low
    ):
        desk.turn.text = desk.list_commitments("open")
        return
    if re.search(r"\b(services?|uptime|is .* (up|down))\b", low):
        desk.turn.text = desk.service_status()
        return
    tri = brain.rule_triage(t, models.utcnow(), desk.team.timezone, others)
    if tri.kind in ("request", "promise") and tri.title:
        if tri.for_team:
            desk.turn.text = desk.ask_team(tri.for_team, tri.title, due=tri.due, detail=t)
        else:
            desk.turn.text = desk.log_commitment(tri.title, due=tri.due, priority=tri.priority)
        return
    found = desk._search(t)
    if tri.kind != "question":
        # Not a question ("hi", "thanks"): answer from notes if they match, but don't log an open question.
        desk.turn.text = brain.answer(None, t, found, steward=desk.steward.name, team=desk.team.name)
        return
    reply = learning.answer(
        desk.s,
        desk.team,
        None,
        t,
        found,
        steward=desk.steward.name,
        asked_by=desk.user.name if desk.user else "a visitor",
    )
    desk.turn.text = reply.text
    if reply.gap is not None:
        desk.turn.actions.append(
            {
                "kind": "question",
                "text": "Added to open questions",
                "link": f"/teams/{desk.team.slug}/learning",
            }
        )


def chat(
    session: orm.Session, team: models.Team, user: models.User | None, text: str
) -> list[models.ChatMessage]:
    """One front-desk exchange. Stores both messages; returns the steward's new replies."""
    if not text.strip():
        raise ValueError("Say something first.")
    org = session.get(models.Org, team.org_id)
    user_msg = models.ChatMessage(
        org_id=team.org_id,
        team_id=team.id,
        role="user",
        text=text.strip()[:4000],
        user_id=user.id if user else None,
    )
    session.add(user_msg)
    session.flush()
    desk = Desk(session, team, user, user_msg.id[:12])
    model = llm.for_org(session, team.org_id)
    if model is None:
        _rule_chat(desk, text)
    else:
        try:
            _agent_chat(session, desk, model, org, text)
        except Exception as exc:
            log.warning("chat model failed, using rules: %s", exc)
            feed.MODEL_CALLS.labels(purpose="chat", outcome="error").inc()
            desk.turn = Turn(text="")
            _rule_chat(desk, text)
    turn = desk.turn
    if turn.withheld:
        turn.text += f"\n\n_{turn.withheld} matching note(s) are restricted for you, so I left them out._"
    reply = models.ChatMessage(
        org_id=team.org_id,
        team_id=team.id,
        role="steward",
        text=turn.text or "Done.",
        meta={
            "sources": turn.sources,
            "actions": turn.actions,
            "label": turn.label,
            "withheld": turn.withheld,
        },
    )
    session.add(reply)
    feed.activity(
        session,
        team.org_id,
        team.id,
        "chat",
        desk.steward.emoji,
        f"{desk.steward.name} answered {user.name if user else 'someone'} at the front desk",
        f"/teams/{team.slug}/front-desk",
    )
    session.flush()
    return [reply]


def _agent_chat(
    session: orm.Session, desk: Desk, model: language_models.BaseChatModel, org: models.Org | None, text: str
) -> None:
    import langchain.agents

    from keel import levels

    st = desk.steward
    lvl = levels.level_def(st.level)
    now = models.utcnow().astimezone(zoneinfo.ZoneInfo(desk.team.timezone))
    prompt = CHAT_PROMPT.format(
        steward=st.name,
        team=desk.team.name,
        org=org.name if org else "the company",
        level=st.level,
        level_name=lvl.name,
        can=lvl.can,
        teams=", ".join(other_team_slugs(session, desk.team)) or "none",
        today=now.strftime("%A %Y-%m-%d %H:%M"),
        tz=desk.team.timezone,
        person=desk.user.name if desk.user else "a visitor",
    )
    if st.persona:
        prompt += f"\n\nPersona: {st.persona}"
    lessons = learning.render(learning.relevant(session, desk.team.id, text, desk.clearance))
    if lessons:
        prompt += "\n\n" + lessons
    history = list(
        session.scalars(
            sa.select(models.ChatMessage)
            .where(models.ChatMessage.team_id == desk.team.id)
            .order_by(models.ChatMessage.at.desc())
            .limit(CHAT_HISTORY_TURNS + 1)
        )
    )[::-1]
    msgs = [{"role": "user" if m.role == "user" else "assistant", "content": m.text} for m in history]
    if not msgs or msgs[-1]["content"] != text.strip():
        msgs.append({"role": "user", "content": text})
    agent = langchain.agents.create_agent(model, tools=desk.tools(), system_prompt=prompt)
    out = agent.invoke({"messages": msgs}, config={"recursion_limit": AGENT_RECURSION_LIMIT})
    feed.MODEL_CALLS.labels(purpose="chat", outcome="ok").inc()
    desk.turn.text = str(out["messages"][-1].content).strip()
