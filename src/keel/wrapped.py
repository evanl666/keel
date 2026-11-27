"""Team Wrapped: a month of a team's promises as a shareable recap, in the spirit of Spotify Wrapped.

Every number comes from the ledger. The model only writes the one-line headline, from those numbers.
"""

from __future__ import annotations

import collections
import datetime as dt
import json
import logging
import typing
import zoneinfo

import sqlalchemy as sa
from langchain_core import language_models
from sqlalchemy import orm

from keel import feed, ledger, models, svg

log = logging.getLogger(__name__)

WRAPPED_DAYS = 30  # A month: long enough for a pattern, short enough that people remember the work.
MAX_DAYS = 366  # A year-in-review is the longest recap that still means something.
TOP_CLOSERS = 3  # Names on the card; more than three stops being a shout-out.
CLOSER_MIN_KEPT = 5  # A team needs this many closes before "The Closers" is earned rather than luck.
SPEEDRUN_HOURS = 2  # Asked and done within a couple of hours feels instant to the person asking.
OPTIMIST_OVERDUE = 3  # Three or more overdue right now is a pattern, not an accident.


def _aware(t: dt.datetime | None) -> dt.datetime | None:
    if t is None:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.UTC)


def persona(facts: dict[str, typing.Any]) -> dict[str, str]:
    """A playful one-word identity for the month, picked by plain rules so it's explainable."""
    kept, rate = facts["kept"], facts["on_time_rate"]
    if not facts["made"] and not kept:
        return {"name": "The Calm Before", "line": "A quiet month. Nothing promised, nothing broken."}
    if rate is not None and rate >= 0.9 and kept >= CLOSER_MIN_KEPT:
        return {"name": "The Closers", "line": "Say it, ship it. Almost everything landed on time."}
    if kept and facts["helped_other_teams"] * 3 >= kept and facts["helped_other_teams"] >= 2:
        return {"name": "The Good Neighbours", "line": "A big share of the wins were other teams' asks."}
    if facts["overdue_now"] >= OPTIMIST_OVERDUE or (rate is not None and rate < 0.5):
        return {"name": "The Optimists", "line": "Big plans, flexible calendars."}
    fastest = facts.get("fastest")
    if fastest and fastest["hours"] < SPEEDRUN_HOURS:
        return {"name": "The Speedrunners", "line": "Some asks were done before the thread went cold."}
    return {"name": "The Steady Hands", "line": "Promises in, work out, no drama."}


def compute(
    session: orm.Session, team: models.Team, days: int = WRAPPED_DAYS, now: dt.datetime | None = None
) -> dict[str, typing.Any]:
    """Recap the team's last ``days`` days. Raises ValueError for a period under one day or over a year."""
    if not 1 <= days <= MAX_DAYS:
        raise ValueError(f"Pick a period from 1 to {MAX_DAYS} days.")
    now = _aware(now) or models.utcnow()
    since = now - dt.timedelta(days=days)
    tz = zoneinfo.ZoneInfo(team.timezone or "UTC")
    owned = list(
        session.scalars(sa.select(models.Commitment).where(models.Commitment.owner_team_id == team.id))
    )
    asked = list(
        session.scalars(
            sa.select(models.Commitment).where(
                models.Commitment.requester_team_id == team.id, models.Commitment.owner_team_id != team.id
            )
        )
    )
    in_window = [c for c in owned if since <= _aware(c.created_at) <= now]
    closed = [c for c in owned if c.closed_at and since <= _aware(c.closed_at) <= now]
    done = sorted((c for c in closed if c.status == "done"), key=lambda c: _aware(c.closed_at))
    on_time = [c for c in done if c.due_at is None or _aware(c.closed_at) <= _aware(c.due_at)]

    streak = best = 0
    for c in done:
        streak = streak + 1 if c in on_time else 0
        best = max(best, streak)

    fastest = min(done, key=lambda c: _aware(c.closed_at) - _aware(c.created_at), default=None)
    names = {
        t.id: t.name for t in session.scalars(sa.select(models.Team).where(models.Team.org_id == team.org_id))
    }
    partners: collections.Counter[str] = collections.Counter()
    for c in done:
        if c.requester_team_id and c.requester_team_id != team.id:
            partners[c.requester_team_id] += 1
    for c in asked:
        if c.status == "done" and c.closed_at and since <= _aware(c.closed_at) <= now:
            partners[c.owner_team_id] += 1
    closers = collections.Counter(c.owner_person for c in done if c.owner_person)
    weekdays = collections.Counter(_aware(c.closed_at).astimezone(tz).strftime("%A") for c in done)
    open_now = [c for c in owned if c.status in ledger.OPEN_STATUSES]
    oldest = min(open_now, key=lambda c: _aware(c.created_at), default=None)

    facts: dict[str, typing.Any] = {
        "team": team.name,
        "days": days,
        "from": ledger.day(since, team.timezone),
        "to": ledger.day(now, team.timezone),
        "made": len(in_window),
        "kept": len(done),
        "on_time": len(on_time),
        "on_time_rate": round(len(on_time) / len(done), 3) if done else None,
        "dropped": sum(c.status in ("dropped", "declined") for c in closed),
        "overdue_now": sum(ledger.risk(c, now) == "overdue" for c in open_now),
        "longest_on_time_streak": best,
        "helped_other_teams": sum(1 for c in done if c.requester_team_id and c.requester_team_id != team.id),
        "fastest": (
            {
                "key": fastest.key,
                "title": fastest.title,
                "hours": round(
                    (_aware(fastest.closed_at) - _aware(fastest.created_at)).total_seconds() / 3600, 1
                ),
            }
            if fastest
            else None
        ),
        "best_partner": (
            {
                "team": names.get(partners.most_common(1)[0][0], "another team"),
                "count": partners.most_common(1)[0][1],
            }
            if partners
            else None
        ),
        "top_closers": [{"who": who, "kept": n} for who, n in closers.most_common(TOP_CLOSERS)],
        "busiest_day": weekdays.most_common(1)[0][0] if weekdays else None,
        "oldest_open": (
            {"key": oldest.key, "title": oldest.title, "days": (now - _aware(oldest.created_at)).days}
            if oldest
            else None
        ),
    }
    facts["persona"] = persona(facts)
    return facts


HEADLINE_CHARS = 75  # the card's quote line fits about 80 characters at its font size
HEADLINE_PROMPT = """Write the headline of a team's monthly recap card, like Spotify Wrapped but for work
promises. One sentence under {max_chars} characters (it must fit one line), warm and a little playful, specific to the
facts. Use only facts
from the JSON; never invent names or numbers. No emoji, no hashtags, no quotes. Facts:
{facts}"""


def headline(model: language_models.BaseChatModel | None, facts: dict[str, typing.Any]) -> str:
    """The card's one-liner. Falls back to the persona line without a model or when the call fails."""
    fallback = facts["persona"]["line"]
    if model is None:
        return fallback
    try:
        reply = model.invoke(
            HEADLINE_PROMPT.format(max_chars=HEADLINE_CHARS, facts=json.dumps(facts, default=str))
        )
        feed.MODEL_CALLS.labels(purpose="wrapped", outcome="ok").inc()
        text = " ".join(str(reply.content).split()).strip("\"'“” ")
        return text or fallback
    except Exception as exc:
        log.warning("wrapped headline call failed, using rules: %s", exc)
        feed.MODEL_CALLS.labels(purpose="wrapped", outcome="error").inc()
        return fallback


def card(facts: dict[str, typing.Any]) -> str:
    """The 1200×630 share card for a recap."""
    rate = facts["on_time_rate"]
    rows = [("Promises", f"{facts['kept']} kept · {facts['made']} new")]
    if facts["fastest"]:
        f = facts["fastest"]
        took = f"{round(f['hours'] * 60)} min" if f["hours"] < 1 else f"{f['hours']:g} h"
        rows.append(("Fastest close", f"{f['key']} in {took}"))
    if facts["best_partner"]:
        bp = facts["best_partner"]
        rows.append(("Best partner", f"{bp['team']} ({bp['count']})"))
    rows.append(("This month you were", facts["persona"]["name"]))
    return svg.card(
        svg.Card(
            eyebrow=f"Team Wrapped · {facts['from']} → {facts['to']}",
            title=facts["team"],
            big="—" if rate is None else f"{round(rate * 100)}%",
            big_caption="kept on time" if rate is not None else "nothing closed yet",
            rows=rows,
            quote=facts.get("headline") or facts["persona"]["line"],
            accent=svg.color_for_rate(rate) if rate is not None else svg.COLORS["purple"],
        )
    )
