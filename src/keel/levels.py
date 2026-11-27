"""Authorization levels L0–L4: what a steward may do on its own, and how it earns more."""

from __future__ import annotations

import dataclasses
import datetime as dt

import sqlalchemy as sa
from sqlalchemy import orm

from keel import feed, models

PROMOTION_MIN_SAMPLES = 50  # Enough human verdicts that a 95% approval rate is not luck (±~6% at 50).
PROMOTION_MIN_APPROVAL_RATE = 0.95  # One rejection in twenty is the most we tolerate before trusting more.
PROMOTION_WINDOW_DAYS = 30  # Old verdicts say little about today's prompts, tools and team.
DEMOTION_ERROR_LIMIT = 3  # Three rejected drafts or steward-caused failed writes in a day → down one level.
DEMOTION_ERROR_WINDOW = dt.timedelta(hours=24)
MAX_LEVEL = 4


@dataclasses.dataclass(frozen=True)
class LevelDef:
    """One rung of the ladder."""

    level: int
    name: str
    can: str


LEVELS: tuple[LevelDef, ...] = (
    LevelDef(0, "Observe", "Reads and keeps the ledger. Sends nothing."),
    LevelDef(1, "Draft", "Drafts every message and change. You approve each one."),
    LevelDef(2, "Assist", "Posts in its own team channel, threads and reminders. Asks before anything else."),
    LevelDef(3, "Act", "Also files issues, comments, and asks other teams' stewards. Asks before runbooks."),
    LevelDef(4, "Operate", "Also runs allow-listed runbooks through the outbound runner."),
)

# Minimum level at which a steward may do this action without a human approving it first.
ACTION_MIN_LEVEL: dict[str, int] = {
    "slack.post_team": 2,
    "slack.reply_thread": 2,
    "slack.nudge": 2,
    "brief.post": 2,
    "slack.post_other": 3,
    "github.comment": 3,
    "github.create_issue": 3,
    "crossteam.request": 3,
    "runbook.run": 4,
}
DEFAULT_ACTION_MIN_LEVEL = 3  # Unknown actions need Act; safer than letting new kinds slip through at L2.


def level_def(level: int) -> LevelDef:
    """Return the definition for ``level`` (0..4)."""
    if not 0 <= level <= MAX_LEVEL:
        raise ValueError(f"level must be 0..{MAX_LEVEL}, got {level}")
    return LEVELS[level]


def min_level_for(action_kind: str) -> int:
    """Minimum level for ``action_kind`` to run without approval."""
    return ACTION_MIN_LEVEL.get(action_kind, DEFAULT_ACTION_MIN_LEVEL)


def may_act_alone(level: int, action_kind: str) -> bool:
    """True when a steward at ``level`` may do ``action_kind`` without approval."""
    return level >= min_level_for(action_kind)


@dataclasses.dataclass
class PromotionStatus:
    """Where a steward stands on the way to the next level."""

    samples: int
    approval_rate: float | None
    eligible_for: int | None


def approval_rate(outcomes: list[str]) -> float | None:
    """Share of verdicts approved without edits. Returns None for an empty list.

    Accepts a list of outcome strings ("approved", "edited", "rejected", "error").
    """
    if not outcomes:
        return None
    return sum(1 for o in outcomes if o == "approved") / len(outcomes)


def promotion_status(
    session: orm.Session, steward: models.Steward, now: dt.datetime | None = None
) -> PromotionStatus:
    """Compute samples and approval rate in the window, and whether the next level is earned."""
    now = now or models.utcnow()
    since = now - dt.timedelta(days=PROMOTION_WINDOW_DAYS)
    outcomes = list(
        session.scalars(
            sa.select(models.LevelSample.outcome).where(
                models.LevelSample.team_id == steward.team_id, models.LevelSample.at >= since
            )
        )
    )
    rate = approval_rate(outcomes)
    eligible = None
    if (
        steward.level < MAX_LEVEL
        and len(outcomes) >= PROMOTION_MIN_SAMPLES
        and rate is not None
        and rate >= PROMOTION_MIN_APPROVAL_RATE
    ):
        eligible = steward.level + 1
    return PromotionStatus(samples=len(outcomes), approval_rate=rate, eligible_for=eligible)


def set_level(session: orm.Session, steward: models.Steward, to: int, reason: str, actor: str) -> None:
    """Change a steward's level and record why. Does nothing when the level is unchanged."""
    level_def(to)
    if to == steward.level:
        return
    session.add(
        models.LevelEvent(
            org_id=steward.org_id,
            team_id=steward.team_id,
            from_level=steward.level,
            to_level=to,
            reason=reason,
            actor=actor,
        )
    )
    steward.level = to


def record_sample(session: orm.Session, steward: models.Steward, action_kind: str, outcome: str) -> None:
    """Record a human verdict, or a write that failed through the steward's fault ("error").

    Rejections and errors pile up toward demotion. Approvals can earn the next level, which Keel announces
    once; a person still makes the promotion.
    """
    session.add(
        models.LevelSample(
            org_id=steward.org_id, team_id=steward.team_id, action_kind=action_kind, outcome=outcome
        )
    )
    if outcome in ("approved", "edited"):
        session.flush()
        announce_if_eligible(session, steward)
        return
    if outcome not in ("rejected", "error") or steward.level == 0:
        return
    session.flush()
    since = models.utcnow() - DEMOTION_ERROR_WINDOW
    last_change = session.scalar(
        sa.select(sa.func.max(models.LevelEvent.at)).where(models.LevelEvent.team_id == steward.team_id)
    )
    if last_change is not None and last_change > since:
        since = last_change  # Errors before the last level change were already acted on.
    recent_bad = session.scalar(
        sa.select(sa.func.count())
        .select_from(models.LevelSample)
        .where(
            models.LevelSample.team_id == steward.team_id,
            models.LevelSample.at >= since,
            models.LevelSample.outcome.in_(("rejected", "error")),
        )
    )
    if recent_bad is not None and recent_bad >= DEMOTION_ERROR_LIMIT:
        set_level(
            session,
            steward,
            steward.level - 1,
            f"{recent_bad} rejected or failed actions in the last 24 hours.",
            "keel",
        )


PROMOTION_ACTIVITY_KIND = "promotion"


def announce_if_eligible(session: orm.Session, steward: models.Steward) -> bool:
    """Post one feed line when the steward has earned its next level. True when it posted.

    Posts at most once per level: nothing more until the level changes (promoted, demoted or reset).
    """
    status = promotion_status(session, steward)
    if status.eligible_for is None or status.approval_rate is None:
        return False
    last_change = session.scalar(
        sa.select(sa.func.max(models.LevelEvent.at)).where(models.LevelEvent.team_id == steward.team_id)
    )
    q = (
        sa.select(sa.func.count())
        .select_from(models.Activity)
        .where(models.Activity.team_id == steward.team_id, models.Activity.kind == PROMOTION_ACTIVITY_KIND)
    )
    if last_change is not None:
        q = q.where(models.Activity.at > last_change)
    if session.scalar(q):
        return False
    nxt = level_def(status.eligible_for)
    team = session.get(models.Team, steward.team_id)
    feed.activity(
        session,
        steward.org_id,
        steward.team_id,
        PROMOTION_ACTIVITY_KIND,
        "🎓",
        f"{steward.name} earned L{nxt.level} {nxt.name}: {status.samples} drafts in "
        f"{PROMOTION_WINDOW_DAYS} days, {status.approval_rate:.0%} sent unedited. Promote it when you're ready.",
        f"/teams/{team.slug}/level" if team else None,
    )
    return True
