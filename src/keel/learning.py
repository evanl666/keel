"""How a steward learns from its team, in the open.

Two loops, both visible and reversible on the team's Learning tab:

1. Lessons. When a person edits or rejects a draft (with a reason), drops work the steward logged from chat,
   fixes the due date or owner it read, or teaches a rule (``/keel teach``), Keel keeps a short lesson. The
   most relevant lessons go into the steward's prompts next time, retrieved per message, so it stops
   repeating the mistake. Nothing is fine-tuned and nothing is hidden: any lesson can be switched off.
2. Knowledge gaps. A question the notes can't answer becomes an open question for the team. When a teammate
   answers it in the Slack thread, that reply becomes a suggested answer; one click saves it to knowledge.

Lessons never cross teams, and each keeps the label of the text it came from, so a lesson learned from a
confidential draft is never shown to an audience that can't see confidential text.
"""

from __future__ import annotations

import collections
import dataclasses
import datetime as dt
import math
import re

import sqlalchemy as sa
from langchain_core import language_models
from sqlalchemy import orm

from keel import brain, feed, knowledge, labels, ledger, models

KINDS = ("reply", "triage", "rule")
OPEN_GAP_STATUSES = ("open", "suggested")
CHAT_SOURCES = (
    "slack",
    "github",
)  # Commitments the steward read from chat, as opposed to ones people logged.
NOT_WORK = "Not work to log."

LESSON_EXAMPLES_PER_PROMPT = 4  # Past ~4 examples, extra ones add tokens and dilute the closest match.
RULES_PER_PROMPT = (
    8  # Rules are one line each; eight covers a team's style guide without crowding the prompt.
)
MAX_ACTIVE_LESSONS = (
    200  # Per team. Past this the least-used old lessons switch off, so retrieval stays sharp.
)
DEDUPE_SIMILARITY = 0.8  # Term overlap at which two lessons say the same thing; the newer wording wins.
NOT_WORK_MATCH = 0.8  # A message this close to one a person dropped is chatter, whatever triage said.
NOT_WORK_MATCH_RULES = 0.5  # With no model there's no prompt to learn from, so match more loosely.
GAP_SAME_QUESTION = 0.6  # Term overlap at which a new question counts as an already open one.
CORRECTION_WINDOW = dt.timedelta(hours=48)  # A fix this soon after logging is about how the steward read it.
MIN_HARVEST_CHARS = 20  # Shorter thread replies are mostly "thanks" or "+1", not answers.
LESSON_FIELD_CHARS = 600  # Lessons are reminders, not documents; long drafts are clipped.
ANSWER_CHARS = 4000  # A harvested Slack answer is one message; Slack caps those near 4k characters anyway.
BM25_K1, BM25_B = 1.2, 0.75  # Standard BM25 constants, same as knowledge search.
WEEK = dt.timedelta(days=7)
TREND_WINDOW = dt.timedelta(days=30)  # Matches the promotion window, so the two numbers agree.

_ASCII_TERM = re.compile(r"[a-z0-9][a-z0-9_\-]*")
_CJK_RUN = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+")


def terms(text: str) -> list[str]:
    """Words for matching: ASCII words minus stopwords, plus character pairs for Chinese, Japanese, Korean.

    Accepts any string; returns [] for empty or punctuation-only text. A single CJK character counts as a term.
    """
    low = text.lower()
    out = [t for t in _ASCII_TERM.findall(low) if t not in knowledge.STOPWORDS]
    for run in _CJK_RUN.findall(low):
        out += [run] if len(run) == 1 else [run[i : i + 2] for i in range(len(run) - 1)]
    return out


def similarity(a: str, b: str) -> float:
    """Jaccard overlap of the two texts' terms, 0.0..1.0. Returns 0.0 when either has no terms."""
    ta, tb = set(terms(a)), set(terms(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


MENTION_RE = re.compile(r"<@[A-Z0-9]+>\s*|^(@[\w.\-]+[,:]?\s*)+")


def _clip(text: str | None, limit: int = LESSON_FIELD_CHARS) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _steward_name(session: orm.Session, team: models.Team) -> str:
    name = session.scalar(sa.select(models.Steward.name).where(models.Steward.team_id == team.id))
    return name or "The steward"


def _learning_link(team: models.Team) -> str:
    return f"/teams/{team.slug}/learning"


# ---------------------------------------------------------------- lessons


def headline(lesson: models.Lesson) -> str:
    """One plain line saying what the lesson is, for the feed and the Learning tab."""
    quote = _clip(lesson.situation, 80)
    if lesson.kind == "rule":
        return lesson.note
    if lesson.kind == "triage" and lesson.after == NOT_WORK:
        return f"“{quote}” isn't work to log"
    if lesson.kind == "triage":
        return f"Read “{quote}” as: {lesson.after}"
    if lesson.after:
        return f"A better reply to “{quote}”"
    return f"Don't reply to “{quote}” like that" + (f": {lesson.note}" if lesson.note else "")


def _dedupe_key(kind: str, situation: str, note: str, after: str) -> str:
    return note if kind == "rule" else f"{situation} {after if after == NOT_WORK else ''}"


def add_lesson(
    session: orm.Session,
    team: models.Team,
    *,
    kind: str,
    author: str,
    situation: str = "",
    before: str = "",
    after: str = "",
    note: str = "",
    label: str = "internal",
    source: str = "",
) -> models.Lesson:
    """Store a lesson, or refresh one that says the same thing. Switches off the oldest unused past the cap.

    Raises ValueError for an unknown kind or label, a rule with no words, or a lesson with nothing to learn.
    """
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    labels.rank(label)
    situation, before, after, note = (
        _clip(MENTION_RE.sub("", situation or "")),
        _clip(before),
        _clip(after),
        _clip(note),
    )
    if kind == "rule" and not note:
        raise ValueError("A rule needs some words.")
    if not (situation or note or after):
        raise ValueError("A lesson needs a situation, a fix or a note.")
    key = _dedupe_key(kind, situation, note, after)
    same = next(
        (
            row
            for row in session.scalars(
                sa.select(models.Lesson).where(
                    models.Lesson.team_id == team.id, models.Lesson.kind == kind, models.Lesson.active
                )
            )
            if similarity(key, _dedupe_key(row.kind, row.situation, row.note, row.after)) >= DEDUPE_SIMILARITY
        ),
        None,
    )
    if same is not None:
        same.situation, same.before, same.after, same.note = situation, before, after, note
        same.label = labels.strictest([same.label, label])
        same.source, same.author, same.updated_at = source, author, models.utcnow()
        feed.audit(session, team.org_id, author, "lesson.updated", same.id, headline(same)[:200], team.id)
        return same
    lesson = models.Lesson(
        org_id=team.org_id,
        team_id=team.id,
        kind=kind,
        situation=situation,
        before=before,
        after=after,
        note=note,
        label=label,
        source=source,
        author=author,
    )
    session.add(lesson)
    session.flush()
    _enforce_cap(session, team)
    feed.activity(
        session,
        team.org_id,
        team.id,
        "learning",
        "🧠",
        f"{_steward_name(session, team)} learned: {headline(lesson)}",
        _learning_link(team),
    )
    feed.audit(session, team.org_id, author, "lesson.added", lesson.id, headline(lesson)[:200], team.id)
    return lesson


def _enforce_cap(session: orm.Session, team: models.Team) -> None:
    active = list(
        session.scalars(
            sa.select(models.Lesson)
            .where(models.Lesson.team_id == team.id, models.Lesson.active)
            .order_by(models.Lesson.uses, models.Lesson.created_at)
        )
    )
    for row in active[: max(0, len(active) - MAX_ACTIVE_LESSONS)]:
        row.active = False


def set_active(session: orm.Session, lesson: models.Lesson, active: bool, actor: str) -> models.Lesson:
    """Switch a lesson on or off. Off lessons stay listed but never reach a prompt."""
    lesson.active = active
    feed.audit(
        session,
        lesson.org_id,
        actor,
        "lesson.on" if active else "lesson.off",
        lesson.id,
        headline(lesson)[:200],
        lesson.team_id,
    )
    return lesson


def teach(session: orm.Session, team: models.Team, rule: str, author: str) -> models.Lesson:
    """A person tells the steward a rule in plain words, e.g. "Reply in Chinese when asked in Chinese"."""
    return add_lesson(session, team, kind="rule", note=rule, author=author, source="teach")


def from_approval(
    session: orm.Session, approval: models.Approval, before: str, author: str
) -> models.Lesson | None:
    """Learn from a draft a person edited before sending. None when nothing changed or a person wrote it."""
    op = approval.operation
    if op.created_by != "steward" or before.strip() == approval.preview.strip():
        return None
    team = session.get(models.Team, op.team_id)
    assert team is not None
    return add_lesson(
        session,
        team,
        kind="reply",
        situation=op.context or op.summary,
        before=before,
        after=approval.preview,
        label=op.label,
        source=f"approval:{approval.id}",
        author=author,
    )


def from_rejection(
    session: orm.Session, approval: models.Approval, reason: str, author: str
) -> models.Lesson | None:
    """Learn from a rejected draft. Needs a reason: a bare "no" says too little to learn from."""
    op = approval.operation
    if op.created_by != "steward" or not reason.strip():
        return None
    team = session.get(models.Team, op.team_id)
    assert team is not None
    return add_lesson(
        session,
        team,
        kind="triage" if op.kind == "crossteam.request" else "reply",
        situation=op.context or op.summary,
        before=approval.preview,
        note=reason,
        label=op.label,
        source=f"approval:{approval.id}",
        author=author,
    )


@dataclasses.dataclass(frozen=True)
class Snapshot:
    """What a commitment looked like before a person changed it."""

    status: str
    due_at: dt.datetime | None
    owner_person: str | None

    @classmethod
    def of(cls, c: models.Commitment) -> Snapshot:
        """Take one before an update."""
        return cls(c.status, c.due_at, c.owner_person)


def from_commitment_change(
    session: orm.Session, c: models.Commitment, was: Snapshot, author: str, note: str | None = None
) -> models.Lesson | None:
    """Learn from a person fixing what the steward read from chat soon after it logged it.

    Dropped before anyone started it → "not work". A new due date or owner → how to read such messages.
    Anything else (or anything outside the correction window) teaches nothing and returns None.
    """
    if c.source_kind not in CHAT_SOURCES or not c.source_ref:
        return None
    created = c.created_at if c.created_at.tzinfo else c.created_at.replace(tzinfo=dt.UTC)
    if models.utcnow() - created > CORRECTION_WINDOW:
        return None
    team = session.get(models.Team, c.owner_team_id)
    assert team is not None
    situation = c.detail or c.title
    common = {"situation": situation, "label": c.label, "source": f"commitment:{c.key}", "author": author}
    if c.status in ("dropped", "declined") and was.status in ("proposed", "accepted"):
        return add_lesson(
            session,
            team,
            kind="triage",
            before=f"Logged as work: {c.title}",
            after=NOT_WORK,
            note=note or "",
            **common,
        )
    fixes = []
    if c.due_at is not None and c.due_at != was.due_at:
        old = ledger.day(was.due_at, team.timezone) if was.due_at else "no due date"
        fixes.append(f"due {ledger.day(c.due_at, team.timezone)} (I had {old})")
    if c.owner_person and c.owner_person != was.owner_person:
        fixes.append(f"owner {c.owner_person} (I had {was.owner_person or 'nobody'})")
    if not fixes:
        return None
    return add_lesson(
        session, team, kind="triage", before=f"Logged: {c.title}", after="; ".join(fixes), **common
    )


def _rank(query: str, rows: list[models.Lesson], top_k: int) -> list[models.Lesson]:
    q = terms(query)
    if not q or not rows:
        return []
    docs = [terms(f"{r.situation} {r.note}") for r in rows]
    avg = sum(len(d) for d in docs) / len(docs) or 1.0
    df: collections.Counter[str] = collections.Counter()
    for d in docs:
        df.update(set(d))
    scored = []
    for row, d in zip(rows, docs, strict=True):
        tf = collections.Counter(d)
        score = sum(
            math.log(1 + (len(docs) - df[t] + 0.5) / (df[t] + 0.5))
            * tf[t]
            * (BM25_K1 + 1)
            / (tf[t] + BM25_K1 * (1 - BM25_B + BM25_B * len(d) / avg))
            for t in q
            if t in tf
        )
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda x: -x[0])
    return [row for _, row in scored[:top_k]]


def relevant(
    session: orm.Session,
    team_id: str,
    text: str,
    clearance: str,
    kinds: tuple[str, ...] = ("reply", "triage"),
    *,
    mark_used: bool = True,
) -> list[models.Lesson]:
    """Lessons for one prompt: the team's newest rules, the examples closest to ``text``, then recent edits.

    Only active lessons the audience may see (``clearance``) are returned. Returns [] when there are none.
    """
    rows = [
        r
        for r in session.scalars(
            sa.select(models.Lesson)
            .where(models.Lesson.team_id == team_id, models.Lesson.active)
            .order_by(models.Lesson.updated_at.desc())
        )
        if labels.audience_allows(clearance, r.label)
    ]
    rules = [r for r in rows if r.kind == "rule"][:RULES_PER_PROMPT]
    examples = _rank(text, [r for r in rows if r.kind in kinds], LESSON_EXAMPLES_PER_PROMPT)
    if "reply" in kinds:
        # Edits are mostly about style (length, tone, format), which carries over to any topic: when few
        # lessons match the words, the newest edits fill the rest.
        newest = [r for r in rows if r.kind == "reply" and r.after and r not in examples]
        examples += newest[: LESSON_EXAMPLES_PER_PROMPT - len(examples)]
    out = rules + examples
    if mark_used:
        now = models.utcnow()
        for r in out:
            r.uses += 1
            r.last_used_at = now
    return out


def render(lessons: list[models.Lesson]) -> str:
    """Lessons as a prompt section. Returns "" for an empty list, so callers can always append it."""
    if not lessons:
        return ""
    lines = ["Lessons from this team. Follow them; they override your defaults."]
    if any(r.kind == "reply" and r.after for r in lessons):
        lines.append("Where the team rewrote your draft, match their version's length, tone and format.")
    for r in lessons:
        if r.kind == "rule":
            lines.append(f"- Rule: {r.note}")
        elif r.kind == "triage" and r.after == NOT_WORK:
            why = f" ({r.note})" if r.note else ""
            lines.append(f'- Message: "{r.situation}" → not work to log; a person dropped it{why}.')
        elif r.kind == "triage":
            lines.append(f'- Message: "{r.situation}" → {r.after}.')
        elif r.after:
            lines.append(
                f'- Message: "{r.situation}" → your draft: "{r.before}" → the team sent: "{r.after}".'
            )
        else:
            lines.append(f'- Message: "{r.situation}" → your draft "{r.before}" was rejected: {r.note}.')
    return "\n".join(lines)


def not_work_match(lessons: list[models.Lesson], text: str, threshold: float) -> models.Lesson | None:
    """The "not work" lesson closest to ``text`` at or above ``threshold``, if any."""
    best, best_score = None, threshold
    for r in lessons:
        if r.kind != "triage" or r.after != NOT_WORK:
            continue
        score = similarity(r.situation, text)
        if score >= best_score:
            best, best_score = r, score
    return best


# ---------------------------------------------------------------- knowledge gaps


def log_gap(
    session: orm.Session,
    team: models.Team,
    question: str,
    *,
    asked_by: str = "",
    thread_ref: str | None = None,
) -> models.KnowledgeGap:
    """Record a question the notes couldn't answer. The same open question again just counts up."""
    q = _clip(MENTION_RE.sub("", question or ""), ANSWER_CHARS)
    q = q[:1].upper() + q[1:]
    if not q:
        raise ValueError("A question needs some words.")
    now = models.utcnow()
    same = next(
        (
            g
            for g in session.scalars(
                sa.select(models.KnowledgeGap).where(
                    models.KnowledgeGap.team_id == team.id,
                    models.KnowledgeGap.status.in_(OPEN_GAP_STATUSES),
                )
            )
            if similarity(q, g.question) >= GAP_SAME_QUESTION
        ),
        None,
    )
    if same is not None:
        same.count += 1
        same.last_asked_at = now
        same.thread_ref = thread_ref or same.thread_ref
        return same
    gap = models.KnowledgeGap(
        org_id=team.org_id,
        team_id=team.id,
        question=q,
        asked_by=asked_by[:200],
        thread_ref=thread_ref,
        created_at=now,
        last_asked_at=now,
    )
    session.add(gap)
    session.flush()
    feed.activity(
        session,
        team.org_id,
        team.id,
        "learning",
        "❓",
        f"Open question for {team.name}: {_clip(q, 120)}",
        _learning_link(team),
    )
    return gap


@dataclasses.dataclass
class Reply:
    """An answer to a question, and the open question it logged when the notes fell short."""

    text: str
    gap: models.KnowledgeGap | None = None


def answer(
    session: orm.Session,
    team: models.Team,
    model: language_models.BaseChatModel | None,
    question: str,
    found: knowledge.SearchResult,
    *,
    steward: str,
    asked_by: str = "",
    thread_ref: str | None = None,
    lessons: str = "",
) -> Reply:
    """Answer from the notes; when they don't cover it, log an open question and say so.

    A question whose only matches are above the asker's clearance isn't a gap: the notes exist.
    """
    a = brain.answer_full(model, question, found, steward=steward, team=team.name, lessons=lessons)
    if a.known or (found.withheld and not found.passages):
        return Reply(a.text)
    gap = log_gap(session, team, question, asked_by=asked_by, thread_ref=thread_ref)
    return Reply(f"{a.text} I've added it to {team.name}'s open questions.", gap)


def harvest(
    session: orm.Session, team: models.Team, thread_ref: str, text: str, person: str | None
) -> models.KnowledgeGap | None:
    """Take a teammate's thread reply under an open question as its suggested answer.

    Ignores short replies and the asker's own follow-ups. Returns the gap it filled in, or None.
    """
    answer = text.strip()
    if not thread_ref or len(answer) < MIN_HARVEST_CHARS:
        return None
    gap = session.scalar(
        sa.select(models.KnowledgeGap).where(
            models.KnowledgeGap.team_id == team.id,
            models.KnowledgeGap.thread_ref == thread_ref,
            models.KnowledgeGap.status.in_(OPEN_GAP_STATUSES),
        )
    )
    if gap is None or (person and person == gap.asked_by):
        return None
    gap.suggested_answer, gap.suggested_by, gap.status = _clip(answer, ANSWER_CHARS), person, "suggested"
    feed.activity(
        session,
        team.org_id,
        team.id,
        "learning",
        "💡",
        f"{person or 'Someone'} answered “{_clip(gap.question, 100)}”. Save it to knowledge?",
        _learning_link(team),
    )
    return gap


def fill(
    session: orm.Session,
    gap: models.KnowledgeGap,
    user: models.User,
    *,
    content: str | None = None,
    title: str | None = None,
    label: str = "internal",
) -> models.KnowledgeDoc:
    """Save an answer to the team's knowledge and close the question. Uses the suggested answer by default."""
    if gap.status not in OPEN_GAP_STATUSES:
        raise ValueError(f"This question is already {gap.status}.")
    answer = (content if content is not None else gap.suggested_answer or "").strip()
    if not answer:
        raise ValueError("Write the answer first.")
    team = session.get(models.Team, gap.team_id)
    assert team is not None
    doc = knowledge.add(
        session,
        team,
        (title or "").strip() or _clip(gap.question, 120),
        f"Q: {gap.question}\n\n{answer}",
        label,
        source=f"keel://{team.slug}/gap-{gap.id[:8]}",
        actor=f"user:{user.email}",
    )
    gap.status, gap.doc_id, gap.closed_by, gap.closed_at = "filled", doc.id, user.name, models.utcnow()
    return doc


def dismiss(session: orm.Session, gap: models.KnowledgeGap, user: models.User) -> models.KnowledgeGap:
    """Close a question nobody needs answered."""
    if gap.status not in OPEN_GAP_STATUSES:
        raise ValueError(f"This question is already {gap.status}.")
    gap.status, gap.closed_by, gap.closed_at = "dismissed", user.name, models.utcnow()
    feed.audit(
        session, gap.org_id, f"user:{user.email}", "gap.dismissed", gap.id, gap.question[:200], gap.team_id
    )
    return gap


# ---------------------------------------------------------------- numbers for the tab and the brief


def _unedited_rate(session: orm.Session, team_id: str, start: dt.datetime, end: dt.datetime) -> float | None:
    outcomes = list(
        session.scalars(
            sa.select(models.LevelSample.outcome).where(
                models.LevelSample.team_id == team_id,
                models.LevelSample.at >= start,
                models.LevelSample.at < end,
            )
        )
    )
    if not outcomes:
        return None
    return sum(o == "approved" for o in outcomes) / len(outcomes)


def stats(session: orm.Session, team: models.Team, now: dt.datetime | None = None) -> dict:
    """Counts for the Learning tab: lessons, how often they're used, open questions, and the trend."""
    now = now or models.utcnow()
    lessons = list(session.scalars(sa.select(models.Lesson).where(models.Lesson.team_id == team.id)))
    gaps = list(session.scalars(sa.select(models.KnowledgeGap).where(models.KnowledgeGap.team_id == team.id)))

    def recent(t: dt.datetime | None) -> bool:
        return t is not None and (t if t.tzinfo else t.replace(tzinfo=dt.UTC)) >= now - WEEK

    return {
        "lessons_active": sum(r.active for r in lessons),
        "rules": sum(r.active and r.kind == "rule" for r in lessons),
        "learned_this_week": sum(recent(r.created_at) for r in lessons),
        "used_this_week": sum(recent(r.last_used_at) for r in lessons),
        "open_questions": sum(g.status in OPEN_GAP_STATUSES for g in gaps),
        "suggested_answers": sum(g.status == "suggested" for g in gaps),
        "filled_total": sum(g.status == "filled" for g in gaps),
        "unedited_rate": _unedited_rate(session, team.id, now - TREND_WINDOW, now),
        "unedited_rate_before": _unedited_rate(session, team.id, now - 2 * TREND_WINDOW, now - TREND_WINDOW),
    }


def brief_facts(session: orm.Session, team: models.Team, now: dt.datetime) -> dict:
    """What the weekly brief says about learning: lessons from the week and the most-asked open questions."""
    learned = list(
        session.scalars(
            sa.select(models.Lesson)
            .where(models.Lesson.team_id == team.id, models.Lesson.created_at >= now - WEEK)
            .order_by(models.Lesson.created_at.desc())
        )
    )
    asked = list(
        session.scalars(
            sa.select(models.KnowledgeGap)
            .where(
                models.KnowledgeGap.team_id == team.id,
                models.KnowledgeGap.status.in_(OPEN_GAP_STATUSES),
            )
            .order_by(models.KnowledgeGap.count.desc(), models.KnowledgeGap.last_asked_at.desc())
        )
    )
    return {
        "learned": [(headline(r), r.label) for r in learned],
        "open_questions": [(g.question, g.count, g.status == "suggested") for g in asked],
    }
