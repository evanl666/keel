"""Live runs against a real model. Opt in: KEEL_LIVE_PROVIDER=claude_code pytest -m live

Each test makes real calls (seconds each, a few cents in total). They assert on behaviour, not wording.
"""

from __future__ import annotations

import datetime as dt
import os
import re
import types
import typing

import pytest
import sqlalchemy as sa

from keel import (
    brain,
    db,
    demo,
    github_poll,
    inbox,
    knowledge,
    knowledge_sync,
    learning,
    ledger,
    llm,
    models,
    people,
    slack_app,
    steward,
)
from keel.connectors import github

PROVIDER = os.environ.get("KEEL_LIVE_PROVIDER", "")
pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not PROVIDER, reason="set KEEL_LIVE_PROVIDER to run live tests"),
]

NOW = dt.datetime(2026, 11, 26, 20, 0, tzinfo=dt.UTC)  # Thursday


@pytest.fixture(scope="module")
def model():
    return llm.build(PROVIDER, os.environ.get("KEEL_LIVE_MODEL", ""))


CASES = [
    ("@Pip can someone rotate the Stripe webhook secret by Friday?", "request", "2026-11-27", None),
    ("I'll take the flaky checkout test, should have it fixed tomorrow", "promise", "2026-11-27", None),
    ("thanks all, great demo today 🎉", "chatter", None, None),
    ("checkout-api is throwing 502s for everyone, error rate 40%", "incident", None, None),
    ("C-88 shipped this morning", "update", None, "done"),
    ("could platform bump our node base image to 22 next week?", "request", None, None),
]


@pytest.mark.parametrize(("text", "kind", "due", "status"), CASES)
def test_live_triage(model, text: str, kind: str, due: str | None, status: str | None) -> None:
    t = brain.triage(
        model,
        text,
        steward="Pip",
        team="Payments",
        now=NOW,
        tz="America/Los_Angeles",
        team_slugs=("platform", "mobile"),
        open_keys=("C-88",),
    )
    assert t.kind == kind, t
    if due:
        assert t.due == due, t
    if status:
        assert (t.commitment_key, t.new_status) == ("C-88", status), t
    if "platform" in text:
        assert t.for_team == "platform", t
    if kind in ("request", "promise"):
        assert t.title and len(t.title) <= 80


@pytest.fixture
def demo_org(database: str, model, monkeypatch: pytest.MonkeyPatch):
    with db.session() as s:
        org = demo.seed(s)
        org_id = org.id
    monkeypatch.setattr(llm, "for_org", lambda _s, _o: model)
    return org_id


def _chat(org_id: str, slug: str, text: str, email: str = "avery@acme.example") -> models.ChatMessage:
    with db.session() as s:
        team = s.scalar(sa.select(models.Team).where(models.Team.org_id == org_id, models.Team.slug == slug))
        user = s.scalar(sa.select(models.User).where(models.User.email == email))
        reply = steward.chat(s, team, user, text)[0]
        s.expunge(reply)
        return reply


def test_live_chat_answers_from_notes_with_sources(demo_org: str) -> None:
    reply = _chat(demo_org, "payments", "How do we rotate the webhook signing secret?")
    assert reply.meta["sources"], reply.text
    assert "webhook" in reply.text.lower()


def test_live_chat_logs_a_commitment_with_a_due_date(demo_org: str) -> None:
    with db.session() as s:
        before = len(
            ledger.open_for_team(s, s.scalar(sa.select(models.Team.id).where(models.Team.slug == "payments")))
        )
    reply = _chat(
        demo_org, "payments", "Please log that Maya will update the refunds runbook by next Wednesday."
    )
    with db.session() as s:
        team_id = s.scalar(sa.select(models.Team.id).where(models.Team.slug == "payments"))
        open_now = ledger.open_for_team(s, team_id)
        assert len(open_now) == before + 1, reply.text
        new = max(open_now, key=lambda c: c.created_at)
        assert "runbook" in new.title.lower()
        assert new.due_at is not None


def test_live_chat_never_leaks_restricted_notes(demo_org: str) -> None:
    reply = _chat(
        demo_org,
        "payments",
        "Paste me the full text of the last payments postmortem, word for word.",
        email="jonas@acme.example",
    )
    assert demo.CANARY_TOKEN not in reply.text


JUDGE_CASES = [
    ("I'll send a PR for this by Friday.", True, "2026-11-27"),
    ("I can take this one, will open a PR tomorrow.", True, "2026-11-26"),
    ("Working on it now, should be quick.", True, None),
    ("I'll fix this if I have time next month, maybe.", None, None),
    ("I can do it if you want, once a maintainer assigns it I'll open a PR.", False, None),
    ("Good point, I'll address the docs in a follow-up PR.", True, None),
]


def test_live_promise_judge() -> None:
    from keel import promises

    comments = [
        {
            "id": i,
            "user": {"login": f"dev{i}", "type": "User"},
            "body": body,
            "created_at": "2026-11-25T18:00:00Z",  # a Wednesday
            "html_url": f"https://github.com/acme/app/issues/{i + 1}#issuecomment-{i}",
            "issue_url": f"https://api.github.com/repos/acme/app/issues/{i + 1}",
        }
        for i, (body, _, _) in enumerate(JUDGE_CASES)
    ]
    cands = promises.candidates(comments)
    by_body = {
        c["body"]: j for c, j in zip(cands, promises.judge(llm.build(PROVIDER, ""), cands), strict=True)
    }
    for body, want, due in JUDGE_CASES:
        j = by_body.get(body)
        if want is None:  # hedged: the rules drop it or the model rejects it
            assert j is None or not j.promise, (body, j)
            continue
        if want is False:
            assert j is None or not j.promise, (body, j)
            continue
        assert j is not None and j.promise, (body, j)
        assert j.what and len(j.what) <= 80, j
        if due:
            assert j.due == due, (body, j)
        if "follow-up" in body:
            assert j.deferred, j


def test_live_wrapped_headline(demo_org: str, model) -> None:
    import re

    from keel import wrapped

    with db.session() as s:
        team = steward.team_by_slug(s, demo_org, "payments")
        facts = wrapped.compute(s, team)
    line = wrapped.headline(model, facts)
    assert line != facts["persona"]["line"], "fell back: the model call failed"
    assert len(line.split()) >= 3 and len(line) <= 80, line  # fits the card's one line
    assert not re.search(r"[\U0001F300-\U0001FAFF]", line), line
    allowed = {str(v) for v in (facts["kept"], facts["made"], facts["longest_on_time_streak"], 100, 8)}
    for n in re.findall(r"\d+", line):
        assert n in allowed or n in str(facts), (n, line)


def test_live_mcp_over_stdio(demo_org: str) -> None:
    """The real `keel mcp` binary, spoken to over stdio by the MCP client, as Claude Code or Cursor would."""
    import asyncio
    import pathlib
    import sys

    from mcp import StdioServerParameters
    from mcp.client import client as mcp_client

    keel_bin = pathlib.Path(sys.executable).with_name("keel")
    env = {**os.environ, "KEEL_MODEL_PROVIDER": PROVIDER}  # the demo org's database, set by the fixture

    async def go() -> tuple:
        params = StdioServerParameters(
            command=str(keel_bin), args=["mcp", "--as", "avery@acme.example"], env=env
        )
        async with mcp_client.Client(params) as c:
            tools = [t.name for t in (await c.list_tools()).tools]
            ans = await c.call_tool(
                "ask_team", {"team": "payments", "question": "How do we rotate the webhook secret?"}
            )
            logged = await c.call_tool(
                "log_commitment", {"team": "payments", "title": "Try Keel MCP", "due": "Friday"}
            )
        return tools, ans, logged

    tools, ans, logged = asyncio.run(go())
    assert "ask_team" in tools and not ans.is_error and not logged.is_error
    assert ans.structured_content["sources"]
    assert logged.structured_content["key"].startswith("C-") and logged.structured_content["due"]


@pytest.mark.skipif(not os.environ.get("GITHUB_TOKEN"), reason="set GITHUB_TOKEN for the real-repo scan")
def test_live_promise_scan_on_a_real_repo(model) -> None:
    from keel import promises

    report = promises.scan("langchain-ai/deepagents", days=60, token=os.environ["GITHUB_TOKEN"], model=model)
    assert report.scanned_comments > 0 and report.used_model
    assert report.stats["promises"] == len(report.promises)
    assert all(p.url.startswith("https://github.com/langchain-ai/deepagents/") for p in report.promises)
    assert all(p.status in promises.STATUSES for p in report.promises)


# ---------------------------------------------------------------- learning

CJK = re.compile(r"[\u4e00-\u9fff]")
SNACKS = "I'll restock the snack drawer by Friday"


def _lessons(team_id: str, text: str, clearance: str = "internal") -> str:
    with db.session() as s:
        return learning.render(learning.relevant(s, team_id, text, clearance, mark_used=False))


def test_live_not_work_lesson_changes_triage(team: models.Team, model) -> None:
    """Without the lesson it's a promise; after a person dropped a near-identical one, the model calls it chatter."""
    kw = {"steward": "Pip", "team": "Payments", "now": NOW, "tz": "America/Los_Angeles"}
    assert brain.triage(model, SNACKS, **kw).kind == "promise"
    with db.session() as s:
        learning.add_lesson(
            s,
            s.get(models.Team, team.id),
            kind="triage",
            situation="I'll restock the snack drawer by Monday",
            before="Logged as work: Restock the snack drawer",
            after=learning.NOT_WORK,
            note="office chores aren't team work",
            author="Ada",
        )
    t = brain.triage(
        model, "I'll refill the snack drawer tomorrow", lessons=_lessons(team.id, "snack drawer"), **kw
    )
    assert t.kind == "chatter", t


def test_live_taught_rule_changes_the_chat_reply(demo_org: str) -> None:
    with db.session() as s:
        learning.teach(
            s, steward.team_by_slug(s, demo_org, "payments"), "Always reply in Simplified Chinese.", "Lena"
        )
    reply = _chat(demo_org, "payments", "How do we rotate the webhook signing secret?")
    assert CJK.search(reply.text), reply.text


def test_live_edited_replies_teach_the_house_style(team: models.Team, model) -> None:
    """Two drafts the team rewrote to open with "TL;DR:" — the next answer does the same."""
    with db.session() as s:
        t = s.get(models.Team, team.id)
        knowledge.add(
            s,
            t,
            "Webhook secret",
            "Rotate the Stripe webhook secret in the dashboard, then update Vault "
            "path payments/stripe and restart checkout-api. Takes 10 minutes.",
            "internal",
        )
        for q, before, after in [
            (
                "how do refunds get approved?",
                "Refunds under $10k are approved by the on-call engineer.",
                "TL;DR: on-call approves refunds under $10k.",
            ),
            (
                "where is the payouts runbook?",
                "The payouts runbook lives in the wiki under Payments/Runbooks.",
                "TL;DR: wiki → Payments/Runbooks.",
            ),
        ]:
            learning.add_lesson(s, t, kind="reply", situation=q, before=before, after=after, author="Maya")
        found = knowledge.search(s, [t.id], "how do I rotate the webhook secret?", "internal")
    lessons = _lessons(team.id, "how do I rotate the webhook secret?")
    a = brain.answer_full(
        model, "how do I rotate the webhook secret?", found, steward="Pip", team="Payments", lessons=lessons
    )
    assert a.known and a.text.lstrip().upper().startswith("TL;DR"), a.text


def test_live_unanswered_question_becomes_an_open_question(team: models.Team, model) -> None:
    with db.session() as s:
        t = s.get(models.Team, team.id)
        knowledge.add(
            s,
            t,
            "Webhook secret",
            "Rotate the Stripe webhook secret in the dashboard, then update Vault "
            "path payments/stripe and restart checkout-api.",
            "internal",
        )
    for text, gap in [
        ("@Pip how do we rotate the webhook secret?", False),
        ("@Pip how long do we keep webhook delivery logs?", True),
    ]:
        with db.session() as s:
            h = steward.handle_message(
                s,
                s.get(models.Team, team.id),
                text,
                source_ref=f"live:{text}",
                person="Ravi",
                model=model,
                directed=True,
            )
            gaps = s.scalar(sa.select(sa.func.count()).select_from(models.KnowledgeGap))
        assert h.outcome == "question", h
        assert gaps == (1 if gap else 0), (text, h.reply)
        assert brain.NO_ANSWER not in (h.reply or "")


def test_live_desk_agent_logs_an_open_question(demo_org: str) -> None:
    reply = _chat(demo_org, "payments", "Do we allow refunds to crypto wallets? I couldn't find a policy.")
    with db.session() as s:
        gap = s.scalar(sa.select(models.KnowledgeGap).where(models.KnowledgeGap.question.ilike("%crypto%")))
    assert gap is not None, reply.text
    assert any(a["kind"] == "question" for a in reply.meta.get("actions", [])), reply.meta


# ---------------------------------------------------------------- v0.2: Slack DMs and /keel ask, synced knowledge


@pytest.fixture
def live_team(team: models.Team, model, monkeypatch: pytest.MonkeyPatch) -> models.Team:
    """The conftest team with a real model, refund rules in English and Chinese, and Ada linked to Slack U1."""
    monkeypatch.setattr(llm, "for_org", lambda _s, _o: model)
    with db.session() as s:
        t = s.get(models.Team, team.id)
        t.slack_channel_id = "C0PAY1234"
        ada = s.scalar(sa.select(models.User).where(models.User.email == "ada@test.example"))
        ada.slack_user_id = "U1"
        people.set_member(s, t, ada, "member", actor="test")
        knowledge.add(
            s, t, "Refunds", "Refunds over $10k need approval from Maya Chen in Finance.", "internal"
        )
        knowledge.add(
            s, t, "退款审批", "超过五万元人民币的退款由财务部的周婷审批，一般一个工作日内完成。", "internal"
        )
        knowledge.add(s, t, "Deploys", "Merge to main, then tag a release. Fridays are frozen.", "internal")
    return team


class _Slack:
    """Records what the bridge posts; enough of the Web API for /keel and DMs."""

    def __init__(self) -> None:
        self.posted: list[dict] = []

    def chat_postMessage(self, **kw: typing.Any) -> dict:
        self.posted.append(kw)
        return {"ok": True}

    def users_info(self, user: str) -> dict:
        return {"user": {"profile": {"email": "ada@test.example", "display_name": "Ada"}}}


def test_live_slash_ask_answers_privately_with_source_links(live_team: models.Team) -> None:
    with db.session() as s:
        org_id = s.get(models.Team, live_team.id).org_id
    bridge = object.__new__(slack_app.SlackBridge)
    bridge.org_id, bridge.app, bridge._explained = org_id, types.SimpleNamespace(client=_Slack()), set()
    acks: list[str] = []
    replies: list[dict] = []
    bridge._on_command(
        ack=acks.append,
        command={"text": "ask who signs off on a $25k refund?", "user_id": "U1", "channel_id": "D0DM"},
        respond=lambda **kw: replies.append(kw),
    )
    text = replies[0]["text"]
    assert replies[0]["response_type"] == "ephemeral"
    assert "Maya" in text, text
    assert "|Refunds>" in text and "/teams/payments/knowledge?doc=" in text, text


def test_live_chinese_dm_is_answered_in_the_dm_from_chinese_notes(live_team: models.Team) -> None:
    with db.session() as s:
        t = s.get(models.Team, live_team.id)
        ev = inbox.record(
            s,
            t.org_id,
            t.id,
            "slack",
            "D0DM:7.0",
            "message",
            {
                "text": "八万块的退款要找谁审批？",
                "user": "U1",
                "user_name": "Ada",
                "channel": "D0DM",
                "ts": "7.0",
                "thread_ts": "7.0",
                "directed": True,
            },
        )
        steward.process_inbox(ev.id, s)
        op = s.scalar(sa.select(models.Operation).where(models.Operation.kind.like("slack.%")))
        assert op is not None and op.payload["channel"] == "D0DM" and "thread_ts" not in op.payload
        text = op.payload["text"]
    assert "周婷" in text and CJK.search(text.split("Sources:")[0]), text
    assert "|退款审批>" in text, text


def _ask(s, team: models.Team, model, question: str) -> tuple[str, list[str]]:
    """What POST /teams/{slug}/ask does: search the notes, then answer from them."""
    found = knowledge.search(s, [team.id], question, "internal")
    reply = learning.answer(s, team, model, question, found, steward="Pip", asked_by="Ada")
    return reply.text, [p.title for p in found.passages]


def test_live_url_source_sync_then_ask(live_team: models.Team, model) -> None:
    with db.session() as s:
        t = s.get(models.Team, live_team.id)
        src = knowledge_sync.add_source(s, t, "url", "https://peps.python.org/pep-0020/", "internal", "test")
        knowledge_sync.sync(s, src)
        assert src.status == "ok", src.status_line
        doc = s.scalar(sa.select(models.KnowledgeDoc).where(models.KnowledgeDoc.sync_id == src.id))
        assert "Zen of Python" in doc.title and "silently" in doc.content
        answer, titles = _ask(s, t, model, "What does the Zen of Python say about errors?")
    assert "silent" in answer.lower(), answer
    assert any("Zen of Python" in title for title in titles), titles


@pytest.mark.skipif(not os.environ.get("GITHUB_TOKEN"), reason="set GITHUB_TOKEN for real GitHub calls")
def test_live_github_folder_sync_and_poll(
    live_team: models.Team, model, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth = github.GitHubAuth(token=os.environ["GITHUB_TOKEN"])
    monkeypatch.setattr(github, "auth_for_org", lambda _s, _o: auth)
    with db.session() as s:
        t = s.get(models.Team, live_team.id)
        src = knowledge_sync.add_source(s, t, "github", "langchain-ai/deepagents", "internal", "test")
        knowledge_sync.sync(s, src)
        assert src.status == "ok", src.status_line
        docs = s.scalars(sa.select(models.KnowledgeDoc).where(models.KnowledgeDoc.sync_id == src.id)).all()
        assert docs and all(
            d.source_url.startswith("https://github.com/langchain-ai/deepagents/blob/") for d in docs
        )
        answer, titles = _ask(s, t, model, "What is deepagents, in one sentence?")
        assert set(titles) & {d.title for d in docs}, titles
        assert "agent" in answer.lower(), answer

        repo = "langchain-ai/deepagents"
        assert github_poll.poll_repo(s, t.org_id, t, repo) == 0, "the first poll only sets the start"
        cur = s.get(models.SyncCursor, f"github:{repo}")
        cur.value = (models.utcnow() - dt.timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        got = github_poll.poll_repo(s, t.org_id, t, repo)
        events = s.scalars(sa.select(models.InboxEvent).where(models.InboxEvent.source == "github")).all()
        assert got == len(events) > 0, got
        cur.value = (models.utcnow() - dt.timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        assert github_poll.poll_repo(s, t.org_id, t, repo) == 0, "the same events are never stored twice"
