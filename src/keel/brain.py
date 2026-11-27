"""How a steward understands messages. Facts come from the database; the model reads and writes words.

Every model path has a rule-based fallback, so Keel keeps working (more plainly) when no model is set or a
call fails. The demo runs entirely on the rules.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import typing
import zoneinfo

import pydantic
from langchain_core import language_models

from keel import feed, knowledge

log = logging.getLogger(__name__)

DUE_HOUR_LOCAL = 18  # "By Friday" means end of Friday's working day in the team's timezone.

Kind = typing.Literal["request", "promise", "question", "update", "incident", "chatter"]


class Triage(pydantic.BaseModel):
    """What a team message means for the ledger."""

    kind: Kind = pydantic.Field(
        description="request: someone asks for work; promise: someone commits to work; "
        "question: wants information; update: status of existing work; "
        "incident: something is broken now; chatter: none of these"
    )
    title: str | None = pydantic.Field(
        default=None, description="Short imperative title of the work, max 80 chars"
    )
    owner_person: str | None = pydantic.Field(default=None, description="Who will do it, if stated")
    due: str | None = pydantic.Field(
        default=None, description="Due date as YYYY-MM-DD if stated or clearly implied"
    )
    priority: typing.Literal["low", "normal", "high", "urgent"] = "normal"
    for_team: str | None = pydantic.Field(
        default=None, description="Slug of another team that should do it, if any"
    )
    commitment_key: str | None = pydantic.Field(
        default=None, description="Existing key like C-88 the message is about"
    )
    new_status: typing.Literal["accepted", "in_progress", "blocked", "done", "dropped"] | None = None
    reply: str | None = pydantic.Field(
        default=None, description="One or two short, calm sentences to reply with"
    )


WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def _end_of_day(day: dt.date, tz: str) -> dt.datetime:
    zone = zoneinfo.ZoneInfo(tz)
    return dt.datetime.combine(day, dt.time(DUE_HOUR_LOCAL), zone).astimezone(dt.UTC)


def parse_due(text: str, now: dt.datetime, tz: str = "UTC") -> dt.datetime | None:
    """Find a due date in free text ("by Friday", "tomorrow", "Dec 3", "2026-12-03", "in 3 days").

    Returns an aware UTC datetime at the end of that working day, or None when there is no date.
    """
    t = text.lower()
    today = now.astimezone(zoneinfo.ZoneInfo(tz)).date()
    if m := re.search(r"\b(20\d\d)-(\d\d)-(\d\d)\b", t):
        try:
            return _end_of_day(dt.date(int(m[1]), int(m[2]), int(m[3])), tz)
        except ValueError:
            return None
    if re.search(r"\b(today|tonight|eod|end of day)\b", t):
        return _end_of_day(today, tz)
    if "tomorrow" in t:
        return _end_of_day(today + dt.timedelta(days=1), tz)
    if m := re.search(r"\bin (\d{1,2}) days?\b", t):
        return _end_of_day(today + dt.timedelta(days=int(m[1])), tz)
    if re.search(r"\b(next week)\b", t):
        return _end_of_day(today + dt.timedelta(days=7 - today.weekday()), tz)
    if re.search(r"\b(end of (the )?week|eow)\b", t):
        return _end_of_day(today + dt.timedelta(days=(4 - today.weekday()) % 7), tz)
    if m := re.search(r"\b(" + "|".join(MONTHS) + r")[a-z]*\.? (\d{1,2})\b", t):
        month, day = MONTHS.index(m[1]) + 1, int(m[2])
        try:
            d = dt.date(today.year, month, day)
        except ValueError:
            return None
        if d < today:
            d = d.replace(year=today.year + 1)
        return _end_of_day(d, tz)
    for i, name in enumerate(WEEKDAYS):
        if m := re.search(rf"\b(next )?({name}|{name[:3]})\b", t):
            ahead = (i - today.weekday()) % 7 or 7
            if m[1]:
                ahead += 7
            return _end_of_day(today + dt.timedelta(days=ahead), tz)
    return None


REQUEST_RE = re.compile(
    r"\b(can|could|would) (you|someone|somebody|we|y'all|your team)\b|\bplease\b|\bneed(s|ed)? (you|someone|this|a|an|the)\b|\bask(ing)? (you|for)\b",
    re.IGNORECASE,
)
PROMISE_RE = re.compile(
    r"\b(i'll|i will|i can take|i'm on it|on it\b|will do|we'll|we will|i'll take|let me (take|handle|do))",
    re.IGNORECASE,
)
UPDATE_RE = re.compile(
    r"\b(C-\d+)\b.*\b(done|shipped|merged|finished|blocked|stuck|started|in progress|dropped|cancel+ed)\b",
    re.IGNORECASE,
)
INCIDENT_RE = re.compile(
    r"\b(is down|outage|5\d\d errors?|error rate|paging|sev ?[12]|incident|broken in prod)\b", re.IGNORECASE
)
QUESTION_RE = re.compile(r"\?\s*$|^(who|what|where|when|why|how|is|are|does|do|can)\b", re.IGNORECASE)
STATUS_WORDS = {
    "done": "done",
    "shipped": "done",
    "merged": "done",
    "finished": "done",
    "blocked": "blocked",
    "stuck": "blocked",
    "started": "in_progress",
    "in progress": "in_progress",
    "dropped": "dropped",
    "cancelled": "dropped",
    "canceled": "dropped",
}


def _title_from(text: str) -> str:
    t = re.sub(r"<@[A-Z0-9]+>|^(@[\w.\-]+[,:]?\s*)+", "", text.strip()).strip()
    t = re.sub(r"^(hey|hi|hello)\b[^,]*,?\s*", "", t, flags=re.IGNORECASE)
    t = re.sub(
        r"^(can|could|would) (you|someone|somebody|your team)( please)?\s*", "", t, flags=re.IGNORECASE
    )
    t = re.sub(r"^(please|i'll|i will|we'll|we will)\s+", "", t, flags=re.IGNORECASE)
    t = re.sub(
        r"\s*\b(by|before|until|on) (today|tomorrow|eod|end of (the )?(day|week)|next week|"
        r"(mon|tues|wednes|thurs|fri|satur|sun)day|\w+ \d{1,2}|20\d\d-\d\d-\d\d)\b.*$",
        "",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(
        r"\s*\b(today|tonight|tomorrow|eod|asap|next week|this week)\b[.!?]*$", "", t, flags=re.IGNORECASE
    )
    t = t.rstrip(" ?.!")
    return (t[:1].upper() + t[1:])[:80] if t else "Follow up"


def rule_triage(text: str, now: dt.datetime, tz: str = "UTC", team_slugs: tuple[str, ...] = ()) -> Triage:
    """Classify a message with regular expressions. Used without a model and as the fallback."""
    due = parse_due(text, now, tz)
    due_s = due.astimezone(zoneinfo.ZoneInfo(tz)).date().isoformat() if due else None
    for_team = next(
        (s for s in team_slugs if re.search(rf"(@|#|\b){re.escape(s)}\b", text, re.IGNORECASE)), None
    )
    if m := UPDATE_RE.search(text):
        word = m[2].lower()
        return Triage(
            kind="update",
            commitment_key=m[1].upper(),
            new_status=STATUS_WORDS.get(word, "in_progress"),
            reply=f"Noted: {m[1].upper()} is {STATUS_WORDS.get(word, 'in_progress').replace('_', ' ')}.",
        )
    if INCIDENT_RE.search(text):
        return Triage(
            kind="incident",
            title=_title_from(text),
            priority="urgent",
            reply="Logged as urgent. I'll keep the thread updated.",
        )
    if PROMISE_RE.search(text):
        return Triage(
            kind="promise",
            title=_title_from(text),
            due=due_s,
            reply="Logged it" + (f", due {due_s}." if due_s else ". When should it be done?"),
        )
    asks_team = for_team is not None and re.search(
        rf"\b(can|could|would)\s+(the\s+)?[@#]?{re.escape(for_team)}(\s+team)?\b", text, re.IGNORECASE
    )
    if REQUEST_RE.search(text) or asks_team:
        title = _title_from(
            re.sub(
                rf"^(can|could|would)\s+(the\s+)?[@#]?{re.escape(for_team)}(\s+team)?\s+(please\s+)?",
                "",
                text.strip(),
                flags=re.IGNORECASE,
            )
            if asks_team
            else text
        )
        return Triage(
            kind="request",
            title=title,
            due=due_s,
            for_team=for_team,
            priority="high" if re.search(r"\b(urgent|asap|blocker)\b", text, re.IGNORECASE) else "normal",
            reply="Logged the request" + (f", due {due_s}." if due_s else ". Who can take it?"),
        )
    if QUESTION_RE.search(text.strip()):
        return Triage(kind="question")
    return Triage(kind="chatter")


TRIAGE_PROMPT = """You are {steward}, the steward of the {team} team. Read one message from the team's channel
and decide what it means for the team's commitments ledger. Today is {today} ({weekday}) in {tz}.
Other teams (slugs): {teams}. Known open commitments: {open_keys}.
Be conservative: chatter and thanks are "chatter". Only use "request" or "promise" when someone asks for or
commits to concrete work. Resolve relative dates ("Friday") to YYYY-MM-DD. Keep replies short and calm, no emoji."""


def triage(
    model: language_models.BaseChatModel | None,
    text: str,
    *,
    steward: str,
    team: str,
    now: dt.datetime,
    tz: str = "UTC",
    team_slugs: tuple[str, ...] = (),
    open_keys: tuple[str, ...] = (),
) -> Triage:
    """Classify with the model; fall back to rules if there is no model or the call fails."""
    if model is None:
        return rule_triage(text, now, tz, team_slugs)
    local = now.astimezone(zoneinfo.ZoneInfo(tz))
    prompt = TRIAGE_PROMPT.format(
        steward=steward,
        team=team,
        today=local.date().isoformat(),
        weekday=local.strftime("%A"),
        tz=tz,
        teams=", ".join(team_slugs) or "none",
        open_keys=", ".join(open_keys[:40]) or "none",
    )
    try:
        result = model.with_structured_output(Triage).invoke(
            [{"role": "system", "content": prompt}, {"role": "user", "content": text}]
        )
        feed.MODEL_CALLS.labels(purpose="triage", outcome="ok").inc()
        return typing.cast(Triage, result)
    except Exception as exc:
        log.warning("triage model call failed, using rules: %s", exc)
        feed.MODEL_CALLS.labels(purpose="triage", outcome="error").inc()
        return rule_triage(text, now, tz, team_slugs)


ANSWER_PROMPT = """You are {steward}, the steward of the {team} team, answering at the team's front desk.
Answer only from the passages below. If they don't contain the answer, say so in one sentence and offer to
log the question for the team. Cite passage titles in brackets like [Runbook: payments]. Two to five short
sentences, plain and calm.

Passages:
{passages}"""


def answer(
    model: language_models.BaseChatModel | None,
    question: str,
    found: knowledge.SearchResult,
    *,
    steward: str,
    team: str,
) -> str:
    """Answer a question from visible passages only."""
    if not found.passages:
        return f"I don't have anything on that in {team}'s notes yet. I can log the question for the team."
    if model is None:
        best = found.passages[0]
        snippet = best.text.strip().replace("\n", " ")
        if len(snippet) > 420:
            snippet = snippet[:420].rsplit(" ", 1)[0] + "…"
        return f"From [{best.title}]: {snippet}"
    ctx = "\n\n".join(f"[{p.title}] (label: {p.label})\n{p.text}" for p in found.passages)
    try:
        reply = model.invoke(
            [
                {"role": "system", "content": ANSWER_PROMPT.format(steward=steward, team=team, passages=ctx)},
                {"role": "user", "content": question},
            ]
        )
        feed.MODEL_CALLS.labels(purpose="answer", outcome="ok").inc()
        return str(reply.content).strip()
    except Exception as exc:
        log.warning("answer model call failed, using rules: %s", exc)
        feed.MODEL_CALLS.labels(purpose="answer", outcome="error").inc()
        return answer(None, question, found, steward=steward, team=team)


HEADLINE_PROMPT = """You are {steward}, steward of the {team} team. Write the opening of today's brief: at most
two short sentences, calm and specific, naming the one or two things that matter most. No emoji, no greeting
fluff, no facts beyond the JSON. Facts:
{facts}"""


def headline(
    model: language_models.BaseChatModel | None, facts: dict[str, typing.Any], *, steward: str, team: str
) -> str:
    """One or two sentences opening a brief. Facts come from the database, never from the model."""

    def rules() -> str:
        overdue, at_risk, needs = facts.get("overdue", 0), facts.get("at_risk", 0), facts.get("needs_you", 0)
        down = facts.get("services_down", [])
        if down:
            return f"{', '.join(down)} {'is' if len(down) == 1 else 'are'} down, so that comes first."
        if overdue:
            return f"{overdue} commitment{'s are' if overdue != 1 else ' is'} overdue. Worth a look before standup."
        if at_risk or needs:
            parts = []
            if at_risk:
                parts.append(f"{at_risk} at risk")
            if needs:
                parts.append(f"{needs} waiting on you")
            return f"A steady day: {' and '.join(parts)}."
        return "All quiet. Nothing is overdue or at risk."

    if model is None:
        return rules()
    try:
        reply = model.invoke(
            HEADLINE_PROMPT.format(steward=steward, team=team, facts=json.dumps(facts, default=str))
        )
        feed.MODEL_CALLS.labels(purpose="headline", outcome="ok").inc()
        return str(reply.content).strip()
    except Exception as exc:
        log.warning("headline model call failed, using rules: %s", exc)
        feed.MODEL_CALLS.labels(purpose="headline", outcome="error").inc()
        return rules()
