"""The steward learns: lessons from corrections, open questions from gaps in the notes, answers from threads."""

from __future__ import annotations

import datetime as dt
import typing
import uuid

import pytest
import sqlalchemy as sa
from alembic import autogenerate
from alembic.runtime import migration
from fastapi import testclient

from keel import (
    db,
    errors,
    gateway,
    knowledge,
    learning,
    ledger,
    levels,
    models,
    rhythm,
    slack_app,
    steward,
    worker,
)
from keel.api import app as app_module
from keel.connectors import base

PROMISE = "lol I'll fix the coffee machine by Friday"


def _team(s: sa.orm.Session, team: models.Team) -> models.Team:
    t = s.get(models.Team, team.id)
    assert t is not None
    return t


def _user(s: sa.orm.Session) -> models.User:
    u = s.scalar(sa.select(models.User))
    assert u is not None
    return u


def _count(model: type, *where: typing.Any) -> int:
    with db.session() as s:
        return s.scalar(sa.select(sa.func.count()).select_from(model).where(*where)) or 0


def _draft(
    team: models.Team, text: str = "Fix CI", context: str = "@Pip can you open an issue for CI?"
) -> str:
    """A steward-written GitHub issue; at L2 it waits for approval. Returns the approval id."""
    with db.session() as s:
        gateway.propose(
            s,
            gateway.Proposal(
                team=_team(s, team),
                kind="github.create_issue",
                target="acme/api",
                payload={"repo": "acme/api", "title": text, "body": ""},
                summary=text,
                op_id=f"test:{uuid.uuid4()}",
                label="internal",
                context=context,
            ),
        )
        approval = s.scalar(sa.select(models.Approval).order_by(models.Approval.created_at.desc()))
        assert approval is not None
        return approval.id


def _say(team: models.Team, text: str, **kw: typing.Any) -> steward.Handled:
    with db.session() as s:
        kw.setdefault("source_ref", f"slack:{uuid.uuid4()}")
        kw.setdefault("person", "Ravi")
        return steward.handle_message(s, _team(s, team), text, **kw)


# ---------------------------------------------------------------- matching


def test_terms_and_similarity_handle_empty_single_and_cjk() -> None:
    assert learning.terms("") == [] and learning.terms("?!…") == []
    assert learning.terms("退") == ["退"]
    assert learning.terms("退款流程") == ["退款", "款流", "流程"]
    assert learning.terms("The webhook secret") == ["webhook", "secret"]
    assert learning.similarity("", "anything") == 0.0
    assert learning.similarity("rotate the webhook secret", "Rotate webhook secret!") == 1.0
    assert learning.similarity("退款流程", "退款审批") > 0


# ---------------------------------------------------------------- lessons


def test_teach_dedupes_and_rejects_empty(team: models.Team) -> None:
    with db.session() as s:
        t = _team(s, team)
        first = learning.teach(s, t, "Reply in Chinese when asked in Chinese.", "Ada")
        again = learning.teach(s, t, "Reply in Chinese when asked in Chinese!", "Lena")
        assert again.id == first.id and again.author == "Lena"
        with pytest.raises(ValueError, match="needs some words"):
            learning.teach(s, t, "   ", "Ada")
        with pytest.raises(ValueError, match="kind must be"):
            learning.add_lesson(s, t, kind="vibe", note="x", author="Ada")
    assert _count(models.Lesson) == 1


def test_cap_switches_off_the_oldest_unused(team: models.Team, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(learning, "MAX_ACTIVE_LESSONS", 2)
    with db.session() as s:
        t = _team(s, team)
        old = learning.teach(s, t, "Keep replies to two sentences.", "Ada")
        used = learning.teach(s, t, "Link the runbook instead of pasting it.", "Ada")
        used.uses = 3
        learning.teach(s, t, "Tag payments oncall on payouts.", "Ada")
        s.flush()
        assert not old.active and used.active
    assert _count(models.Lesson, models.Lesson.active) == 2


def test_approval_learns_only_from_an_edit(team: models.Team) -> None:
    plain = _draft(team, "Fix CI")
    edited = _draft(team, "Fix CI again")
    with db.session() as s:
        gateway.approve(s, s.get(models.Approval, plain), _user(s))
        gateway.approve(s, s.get(models.Approval, edited), _user(s), edited_preview="Fix flaky CI on main")
    with db.session() as s:
        lessons = list(s.scalars(sa.select(models.Lesson)))
        assert len(lessons) == 1
        r = lessons[0]
        assert (r.kind, r.before, r.after) == ("reply", "Fix CI again", "Fix flaky CI on main")
        assert r.situation == "can you open an issue for CI?", "the @mention is stripped"


def test_rejection_needs_a_reason(team: models.Team) -> None:
    bare, why = _draft(team, "Fix CI"), _draft(team, "Fix lint")
    with db.session() as s:
        gateway.reject(s, s.get(models.Approval, bare), _user(s))
        gateway.reject(s, s.get(models.Approval, why), _user(s), reason="Wrong team")
    with db.session() as s:
        r = s.scalar(sa.select(models.Lesson))
        assert r is not None and r.note == "Wrong team" and r.before == "Fix lint"
    assert _count(models.Lesson) == 1


def test_dropped_commitment_stops_similar_chatter_becoming_work(team: models.Team) -> None:
    first = _say(team, PROMISE)
    assert first.outcome == "promise" and first.commitment is not None
    with db.session() as s:
        c = s.get(models.Commitment, first.commitment.id)
        was = learning.Snapshot.of(c)
        ledger.update(s, c, "Ada", status="dropped")
        lesson = learning.from_commitment_change(s, c, was, "Ada", note="joke")
        assert lesson is not None and lesson.after == learning.NOT_WORK
    second = _say(team, "lol I'll fix the coffee machine by Monday")
    assert second.outcome == "chatter" and second.commitment is None


def test_due_fix_is_a_lesson_but_only_inside_the_window(team: models.Team) -> None:
    h = _say(team, "I'll ship the refund export by EOW")
    assert h.commitment is not None
    with db.session() as s:
        c = s.get(models.Commitment, h.commitment.id)
        was = learning.Snapshot.of(c)
        ledger.update(s, c, "Ada", due_at=dt.datetime(2031, 1, 3, 17, tzinfo=dt.UTC))
        r = learning.from_commitment_change(s, c, was, "Ada")
        assert r is not None and r.kind == "triage" and r.after.startswith("due ")
        c.created_at = models.utcnow() - learning.CORRECTION_WINDOW - dt.timedelta(hours=1)
        was = learning.Snapshot.of(c)
        ledger.update(s, c, "Ada", owner_person="Lena")
        assert learning.from_commitment_change(s, c, was, "Ada") is None
        web = ledger.create(s, team=_team(s, team), title="Typed in the UI", actor="Ada")
        was = learning.Snapshot.of(web)
        ledger.update(s, web, "Ada", status="dropped")
        assert learning.from_commitment_change(s, web, was, "Ada") is None, "only chat-read work teaches"


def test_relevant_filters_by_label_and_counts_uses(team: models.Team) -> None:
    with db.session() as s:
        t = _team(s, team)
        assert learning.relevant(s, t.id, "anything", "restricted") == []
        assert learning.render([]) == ""
        learning.teach(s, t, "Keep replies short.", "Ada")
        learning.add_lesson(
            s,
            t,
            kind="reply",
            situation="refund numbers for finance",
            note="Ask Lena",
            label="confidential",
            author="Ada",
        )
        learning.add_lesson(
            s, t, kind="reply", situation="webhook retries", note="Link the runbook", author="Ada"
        )
        internal = learning.relevant(s, t.id, "finance wants refund numbers", "internal")
        assert [r.kind for r in internal] == ["rule"], (
            "the confidential lesson stays out; webhook doesn't match"
        )
        cleared = learning.relevant(s, t.id, "finance wants refund numbers", "confidential")
        assert [r.note for r in cleared] == ["Keep replies short.", "Ask Lena"]
        assert cleared[0].uses == 2
        text = learning.render(cleared)
        assert "- Rule: Keep replies short." in text and "was rejected: Ask Lena" in text
        learning.add_lesson(
            s,
            t,
            kind="reply",
            situation="payouts runbook",
            before="It's in the wiki.",
            after="TL;DR: wiki",
            author="Ada",
        )
        styled = learning.relevant(s, t.id, "rotate the stripe key", "internal")
        assert [r.after for r in styled] == ["", "TL;DR: wiki"], "a recent edit carries style to any topic"
        assert "match their version's length, tone and format" in learning.render(styled)


# ---------------------------------------------------------------- open questions


def test_unanswered_question_logs_one_gap_without_mentions(team: models.Team) -> None:
    h = _say(team, "<@U0PIP> what's our SLA for Klarna disputes?", directed=True)
    assert h.reply and "open questions" in h.reply
    _say(team, "@Pip What is our SLA for Klarna disputes?", directed=True, person="Maya")
    with db.session() as s:
        gaps = list(s.scalars(sa.select(models.KnowledgeGap)))
        assert len(gaps) == 1
        assert gaps[0].question == "What's our SLA for Klarna disputes?" and gaps[0].count == 2
        with pytest.raises(ValueError, match="needs some words"):
            learning.log_gap(s, _team(s, team), "<@U0PIP> ")


def test_restricted_only_match_is_not_a_gap(team: models.Team) -> None:
    with db.session() as s:
        knowledge.add(
            s, _team(s, team), "Klarna postmortem", "Klarna disputes SLA breach details.", "restricted"
        )
    h = _say(team, "what's our SLA for Klarna disputes?", directed=True)
    assert h.reply and "open questions" not in h.reply
    assert _count(models.KnowledgeGap) == 0


def test_thread_reply_becomes_the_suggested_answer(team: models.Team) -> None:
    where = {"channel": "C1", "thread_ts": "1.0"}
    _say(team, "@Pip who approves refunds over $10k?", directed=True, person="Ravi", **where)
    assert _say(team, "+1 same question", person="Maya", in_thread=True, **where).outcome != "gap_answer"
    assert _say(
        team, "Me too, I keep forgetting who it is", person="Ravi", in_thread=True, **where
    ).outcome != ("gap_answer"), "the asker's own follow-up isn't an answer"
    h = _say(
        team,
        "Maya or Lena sign off; tag both in #payments-approvals.",
        person="Lena",
        in_thread=True,
        **where,
    )
    assert h.outcome == "gap_answer"
    with db.session() as s:
        g = s.scalar(sa.select(models.KnowledgeGap))
        assert g is not None and g.status == "suggested" and g.suggested_by == "Lena"
        doc = learning.fill(s, g, _user(s))
        assert "Maya or Lena sign off" in doc.content and g.status == "filled"
        with pytest.raises(ValueError, match="already filled"):
            learning.fill(s, g, _user(s))
    found = _say(team, "@Pip who approves refunds over $10k?", directed=True, person="Theo", **where)
    assert found.reply and "open questions" not in found.reply
    assert _count(models.KnowledgeGap) == 1


def test_fill_needs_an_answer_and_dismiss_closes(team: models.Team) -> None:
    with db.session() as s:
        t = _team(s, team)
        g = learning.log_gap(s, t, "How do we rotate the Adyen key?")
        with pytest.raises(ValueError, match="Write the answer first"):
            learning.fill(s, g, _user(s))
        learning.dismiss(s, g, _user(s))
        assert g.status == "dismissed"
        with pytest.raises(ValueError, match="already dismissed"):
            learning.dismiss(s, g, _user(s))


# ---------------------------------------------------------------- around the loop


def test_slack_teach_command(team: models.Team) -> None:
    with db.session() as s:
        _team(s, team).slack_channel_id = "C1"
    bridge = slack_app.SlackBridge.__new__(slack_app.SlackBridge)
    bridge.org_id = team.org_id
    bridge._name = lambda _uid: "Lena"  # type: ignore[method-assign]
    said: list[str] = []
    bridge._on_command(said.append, {"text": "teach", "channel_id": "C1", "user_id": "U1"})
    bridge._on_command(said.append, {"text": "teach: Reply in Chinese.", "channel_id": "C1", "user_id": "U1"})
    assert "Tell me the rule" in said[0] and "Reply in Chinese." in said[1]
    with db.session() as s:
        r = s.scalar(sa.select(models.Lesson))
        assert r is not None and (r.kind, r.note, r.author) == ("rule", "Reply in Chinese.", "Lena")


class Failing:
    """A remote that fails every write with one error class."""

    def __init__(self, error_class: str) -> None:
        self.error_class = error_class

    def factory(self, _session: typing.Any, _op: typing.Any) -> Failing:
        return self

    def execute(self, op: models.Operation) -> base.ExecResult:
        raise errors.ConnectorError(self.error_class, "nope", sent=False)

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        return base.ReconcileResult(base.Found.NO, line="Not there.")


@pytest.mark.parametrize(("error_class", "samples"), [(errors.BAD_REQUEST, 1), (errors.AUTH_INVALID, 0)])
def test_steward_fault_counts_as_an_error_sample(team: models.Team, error_class: str, samples: int) -> None:
    gateway.set_connector_factory(Failing(error_class).factory)
    with db.session() as s:
        gateway.propose(
            s,
            gateway.Proposal(
                team=_team(s, team),
                kind="slack.post_team",
                target="#payments",
                payload={"text": "Heads up: deploy at 3pm"},
                summary="Heads up",
                op_id=f"test:{uuid.uuid4()}",
                label="internal",
            ),
        )
    assert worker.drain() == 1
    assert _count(models.LevelSample, models.LevelSample.outcome == "error") == samples


def test_promotion_is_announced_once(team: models.Team) -> None:
    with db.session() as s:
        st = gateway.steward_for(s, team.id)
        for _ in range(levels.PROMOTION_MIN_SAMPLES - 1):
            levels.record_sample(s, st, "slack.post_team", "approved")
        assert _count(models.Activity, models.Activity.kind == "promotion") == 0
    with db.session() as s:
        st = gateway.steward_for(s, team.id)
        levels.record_sample(s, st, "slack.post_team", "approved")
        levels.record_sample(s, st, "slack.post_team", "approved")
    assert _count(models.Activity, models.Activity.kind == "promotion") == 1


def test_weekly_brief_says_what_it_learned(team: models.Team) -> None:
    with db.session() as s:
        t = _team(s, team)
        learning.teach(s, t, "Keep replies short.", "Ada")
        learning.log_gap(s, t, "Who owns the Adyen key?")
        weekly = rhythm.make_brief(s, t, "weekly", post=False)
        daily = rhythm.make_brief(s, t, "daily", post=False)
        assert "Keep replies short." in weekly.markdown and "Who owns the Adyen key?" in weekly.markdown
        assert "Who owns the Adyen key?" not in daily.markdown


def test_migrations_match_the_models(database: str) -> None:
    with db.engine().connect() as conn:
        diff = autogenerate.compare_metadata(migration.MigrationContext.configure(conn), models.Base.metadata)
    assert diff == []


# ---------------------------------------------------------------- the API


@pytest.fixture
def demo(database: str, monkeypatch: pytest.MonkeyPatch) -> typing.Iterator[testclient.TestClient]:
    monkeypatch.setenv("KEEL_DEMO", "1")
    monkeypatch.setenv("KEEL_RUN_WORKER_IN_PROCESS", "0")
    from keel import config

    config.reset()
    with testclient.TestClient(app_module.create_app()) as client:
        yield client


def ok(r: typing.Any) -> typing.Any:
    assert r.status_code < 400, (r.request.url, r.status_code, r.text[:300])
    return r.json()


def test_learning_api_round_trip(demo: testclient.TestClient) -> None:
    info = ok(demo.get("/api/teams/payments/learning"))
    assert info["lessons"] and info["stats"]["open_questions"] >= 1
    rule = ok(
        demo.post("/api/teams/payments/lessons", json={"rule": "Reply in Chinese when asked in Chinese."})
    )
    assert rule["kind"] == "rule" and rule["active"] and rule["source"] == "teach"
    assert demo.post("/api/teams/payments/lessons", json={"rule": " "}).status_code == 400
    off = ok(demo.patch(f"/api/lessons/{rule['id']}", json={"active": False}))
    assert off["active"] is False
    assert demo.patch("/api/lessons/nope", json={"active": False}).status_code == 404

    question = "Which bank holds the Klarna float?"
    assert ok(demo.post("/api/teams/payments/ask", json={"question": question}))["open_question"] is True
    gaps = ok(demo.get("/api/teams/payments/learning"))["gaps"]
    gap = next(g for g in gaps if g["question"] == question)
    filled = ok(demo.post(f"/api/gaps/{gap['id']}/fill", json={"content": "Barclays, account ending 4411."}))
    assert filled["gap"]["status"] == "filled" and filled["doc"]["title"] == question
    assert demo.post(f"/api/gaps/{gap['id']}/dismiss").status_code == 400
    again = ok(demo.post("/api/teams/payments/ask", json={"question": question}))
    assert again["open_question"] is False and "Barclays" in again["answer"]
    assert demo.post("/api/gaps/nope/fill", json={}).status_code == 404


def test_activity_links_use_the_ui_routes(demo: testclient.TestClient) -> None:
    while ok(demo.post("/api/demo/tick"))["title"] is not None:
        pass
    with db.session() as s:
        links = [x for x in s.scalars(sa.select(models.Activity.link)) if x]
    assert links and not [x for x in links if "?tab=" in x]
