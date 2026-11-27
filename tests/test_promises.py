"""Promise archaeology: rules, outcomes, the summary, rendering, and a full scan against a mocked GitHub."""

from __future__ import annotations

import datetime as dt
import typing
import xml.etree.ElementTree as ET

import httpx
import pytest
import respx

from keel import checkup, promises

NOW = dt.datetime(2026, 11, 26, 12, tzinfo=dt.UTC)
API = "https://api.github.com"


def _ago(days: float) -> str:
    return (NOW - dt.timedelta(days=days)).isoformat().replace("+00:00", "Z")


def _comment(cid: int, who: str, body: str, number: int, days: float, bot: bool = False) -> dict:
    return {
        "id": cid,
        "user": {"login": who, "type": "Bot" if bot else "User"},
        "body": body,
        "created_at": _ago(days),
        "html_url": f"https://github.com/acme/app/issues/{number}#issuecomment-{cid}",
        "issue_url": f"{API}/repos/acme/app/issues/{number}",
    }


def _promise(**kw: typing.Any) -> promises.Promise:
    base = dict(
        who="ada",
        quote="I'll fix it.",
        said_at=_ago(5),
        url="u",
        number=1,
        thread_title="t",
        is_pr=False,
        what="Fix it",
    )
    return promises.Promise(**{**base, **kw})


def test_candidates_skip_bots_hedges_questions_and_quotes() -> None:
    comments = [
        _comment(1, "ada", "I'll fix this by Friday.", 10, 3),
        _comment(
            2, "ada", "I'll fix this by Friday, promise.", 10, 2
        ),  # Same person, same thread: one promise.
        _comment(3, "dependabot[bot]", "I'll update the lockfile.", 11, 2, bot=True),
        _comment(4, "bo", "Maybe I'll take a look next week.", 12, 2),
        _comment(5, "cy", "Can I open the PR?", 13, 2),
        _comment(6, "di", "> I'll fix it\nThanks, that helps.", 14, 2),
        _comment(7, "ed", "I'm not focusing on it right now.", 15, 2),
        _comment(8, "fa", 'Please stop posting "I can take this" on issues.', 16, 2),
        _comment(9, "gu", "If a maintainer assigns it, I can send a PR.", 17, 2),
        _comment(10, "ha", "I'm working on a fix for this.", 18, 2),
    ]
    got = promises.candidates(comments)
    assert [(c["user"]["login"], c["_number"]) for c in got] == [("ada", 10), ("ha", 18)]
    assert promises.candidates([]) == []


def test_quote_keeps_the_whole_promise_sentence() -> None:
    text = "Thanks for the report. Replaced by #12: I'll update the docs tomorrow. Cheers"
    assert promises.quote_of(text) == "Replaced by #12: I'll update the docs tomorrow."
    assert promises.quote_of("I'll fix it") == "I'll fix it"
    assert promises.clean("```\nI'll fix\n```\nsee `x.py`") == " \nsee x.py"


@pytest.mark.parametrize(
    ("kw", "thread", "status"),
    [
        ({}, {"closed_at": _ago(1), "state_reason": "completed"}, "kept"),
        ({}, {"closed_at": _ago(1), "state_reason": "not_planned"}, "dropped"),
        ({"is_pr": True}, {"closed_at": _ago(1), "pull_request": {"merged_at": None}}, "dropped"),
        ({"is_pr": True}, {"closed_at": _ago(1), "pull_request": {"merged_at": _ago(1)}}, "kept"),
        ({"deferred": True}, {"closed_at": _ago(1), "state_reason": "completed"}, "follow_up"),
        ({}, {"closed_at": _ago(9), "state_reason": "completed"}, "follow_up"),  # Closed before the promise.
        ({"due": "2026-11-20"}, {"state": "open"}, "overdue"),
        ({"said_at": _ago(20)}, {"state": "open"}, "quiet"),
        ({}, {"state": "open"}, "open"),
        ({}, None, "open"),
    ],
)
def test_outcome(kw: dict, thread: dict | None, status: str) -> None:
    p = promises.outcome(_promise(**kw), thread, NOW)
    assert p.status == status
    if status == "kept":
        assert p.days_to_keep == 4.0 and p.resolved_at


def test_summary_empty_single_and_many() -> None:
    empty = promises.summarize([])
    assert empty["promises"] == 0 and empty["kept_rate"] is None and empty["oldest_unkept"] is None
    one = promises.summarize([_promise(status="kept", days_to_keep=1.0)])
    assert one["kept"] == 1 and one["kept_rate"] is None  # Too few to judge.
    many = promises.summarize(
        [
            _promise(who="ada", status="kept", days_to_keep=1.0),
            _promise(who="ada", status="kept", days_to_keep=3.0),
            _promise(who="bo", status="quiet", age_days=30),
            _promise(who="cy", status="overdue", age_days=10),
            _promise(who="cy", status="follow_up"),
        ]
    )
    assert many["kept_rate"] == 0.5 and many["judged"] == 4 and many["median_days_to_keep"] == 2.0
    assert many["oldest_unkept"]["who"] == "bo" and many["fastest_kept"]["days_to_keep"] == 1.0
    assert many["top_promisers"][0] == {"who": "ada", "made": 2, "kept": 2}


class _FakeStructured:
    def __init__(self, result: typing.Any) -> None:
        self.result = result

    def invoke(self, _msgs: typing.Any) -> typing.Any:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _FakeModel:
    def __init__(self, result: typing.Any) -> None:
        self.result = result

    def with_structured_output(self, _schema: typing.Any) -> _FakeStructured:
        return _FakeStructured(self.result)


def test_judge_uses_the_model_and_falls_back_to_rules() -> None:
    cands = promises.candidates(
        [_comment(1, "ada", "I'll fix it by Friday.", 1, 3), _comment(2, "bo", "I'll take a look.", 2, 3)]
    )
    verdict = promises.Judgements(
        items=[
            promises.Judgement(index=0, promise=True, what="Fix it", due="2026-11-27"),
            promises.Judgement(index=1, promise=False),
        ]
    )
    got = promises.judge(_FakeModel(verdict), cands)
    assert [(j.promise, j.what, j.due) for j in got] == [(True, "Fix it", "2026-11-27"), (False, None, None)]
    fallback = promises.judge(_FakeModel(RuntimeError("boom")), cands)
    assert all(j.promise for j in fallback) and fallback[0].due == "2026-11-27"
    assert promises.judge(None, []) == []


@pytest.fixture
def gh() -> typing.Iterator[respx.MockRouter]:
    with respx.mock(base_url=API, assert_all_called=False) as r:
        r.get("/repos/acme/app").respond(json={"default_branch": "main"})
        r.get("/repos/acme/app/issues/comments").respond(
            json=[
                _comment(1, "ada", "I'll fix the rounding bug by Friday.", 10, 20),
                _comment(2, "bo", "On it, PR coming today.", 11, 18),
                _comment(3, "cy", "I'll take a look.", 12, 25),
                _comment(4, "renovate[bot]", "I'll rebase this.", 13, 2, bot=True),
                _comment(5, "di", "Thanks!", 12, 1),
            ]
        )
        r.get("/repos/acme/app/pulls/comments").respond(json=[])
        r.get("/repos/acme/app/issues/10").respond(json={"number": 10, "title": "Rounding", "state": "open"})
        r.get("/repos/acme/app/issues/11").respond(
            json={
                "number": 11,
                "title": "PR",
                "state": "closed",
                "closed_at": _ago(17),
                "state_reason": "completed",
            }
        )
        r.get("/repos/acme/app/issues/12").respond(json={"number": 12, "title": "Look", "state": "open"})
        yield r


def test_scan_end_to_end(gh: respx.MockRouter) -> None:
    report = promises.scan("https://github.com/acme/app", client=httpx.Client(base_url=API), now=NOW)
    by_who = {p.who: p for p in report.promises}
    assert set(by_who) == {"ada", "bo", "cy"}
    assert by_who["ada"].status == "overdue" and by_who["ada"].due == "2026-11-13"
    assert by_who["bo"].status == "kept" and by_who["cy"].status == "quiet"
    assert report.stats["kept_rate"] == round(1 / 3, 3) and report.scanned_comments == 5
    assert report.repo == "acme/app" and not report.used_model


def test_scan_errors_are_one_line(gh: respx.MockRouter) -> None:
    gh.get("/repos/acme/gone").respond(404)
    with pytest.raises(checkup.CheckupError, match="Can't find acme/gone"):
        promises.scan("acme/gone", client=httpx.Client(base_url=API), now=NOW)
    with pytest.raises(checkup.CheckupError, match="owner/name"):
        promises.scan("acme", now=NOW)
    with pytest.raises(checkup.CheckupError, match="at least one day"):
        promises.scan("acme/app", days=0, now=NOW)


def test_badge_card_and_markdown_render_and_escape(gh: respx.MockRouter) -> None:
    report = promises.scan("acme/app", client=httpx.Client(base_url=API), now=NOW)
    report.promises[0].what = "<script>alert(1)</script>"
    report.stats = promises.summarize(report.promises)
    report.stats["oldest_unkept"]["quote"] = "I'll fix <b>it</b> & more"
    for doc in (promises.badge(report), promises.card(report)):
        root = ET.fromstring(doc)
        assert root.tag.endswith("svg") and "<script>" not in doc
    assert "33% kept" in promises.markdown(report)
    empty = promises.Report("acme/app", 30, 0, 0, [], False, promises.summarize([]), [])
    assert "n/a" in promises.badge(empty) and ET.fromstring(promises.card(empty)) is not None


def test_demo_report_tells_a_story() -> None:
    r = promises.demo_report("acme/payments", now=NOW)
    st = r.stats
    assert st["kept"] >= 3 and st["overdue"] >= 1 and st["quiet"] >= 1 and st["follow_up"] == 1
    assert st["kept_rate"] is not None and 0 < st["kept_rate"] < 1


@pytest.mark.parametrize(
    ("text", "hit"),
    [
        ("Working on it now, should be quick.", True),
        ("Thanks! Working on a fix.", True),
        ("I'll send a PR tomorrow", True),
        ("Is anyone working on it?", False),
        ("Mark is on it", False),
        ("", False),
    ],
)
def test_promise_phrases(text: str, hit: bool) -> None:
    assert bool(promises.PROMISE_RE.search(text)) is hit
