"""Live runs against a real model. Opt in: KEEL_LIVE_PROVIDER=claude_code pytest -m live

Each test makes real calls (seconds each, a few cents in total). They assert on behaviour, not wording.
"""

from __future__ import annotations

import datetime as dt
import os

import pytest
import sqlalchemy as sa

from keel import brain, db, demo, ledger, llm, models, steward

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
