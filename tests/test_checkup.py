"""Repo checkup against a mocked GitHub API."""

from __future__ import annotations

import datetime as dt

import httpx
import pytest
import respx

from keel import checkup

NOW = dt.datetime(2026, 11, 26, tzinfo=dt.UTC)
API = "https://api.github.com"


def _ago(days: int) -> str:
    return (NOW - dt.timedelta(days=days)).isoformat().replace("+00:00", "Z")


@pytest.fixture
def gh() -> respx.MockRouter:
    with respx.mock(base_url=API, assert_all_called=False) as r:
        r.get("/repos/acme/app").respond(json={"default_branch": "main", "html_url": "https://github.com/acme/app",
                                                "stargazers_count": 7})
        r.get("/repos/acme/app/pulls", params={"state": "open"}).respond(json=[
            {"number": 1, "title": "Old", "updated_at": _ago(40), "created_at": _ago(60), "html_url": "u1"},
            {"number": 2, "title": "Fresh", "updated_at": _ago(1), "created_at": _ago(1), "html_url": "u2"},
        ])
        r.get("/repos/acme/app/pulls/1/reviews").respond(json=[])
        r.get("/repos/acme/app/pulls", params={"state": "closed"}).respond(json=[
            {"created_at": _ago(10), "merged_at": _ago(9)}, {"created_at": _ago(5), "merged_at": None}])
        r.get("/repos/acme/app/issues").respond(json=[
            {"created_at": _ago(90), "assignees": []}, {"created_at": _ago(2), "assignees": []},
            {"created_at": _ago(90), "assignees": [], "pull_request": {}}])
        r.get("/repos/acme/app/commits/main/check-runs").respond(json={"check_runs": [{"conclusion": "failure"}]})
        r.get(url__regex=r".*/contents/.*CODEOWNERS").respond(404)
        r.get("/repos/acme/app/contents/SECURITY.md").respond(json={})
        r.get("/repos/acme/app/community/profile").respond(json={"files": {"contributing": {"url": "x"}}})
        yield r


def test_analyze_finds_the_real_problems(gh: respx.MockRouter) -> None:
    findings, stats = checkup.analyze("acme/app", client=httpx.Client(base_url=API), now=NOW)
    titles = [f.title for f in findings]
    assert titles[0] == "CI is failing on main"
    assert "1 stale pull request" in titles
    assert "1 PR waiting for a first review" in titles
    assert "1 old issue with no owner" in titles
    assert "No CODEOWNERS file" in titles
    assert "No security policy" not in titles and "No CONTRIBUTING guide" not in titles
    assert stats["open_issues"] == 2 and stats["ci"] == "failing" and stats["median_merge_hours"] == 24.0
    assert checkup.score(findings) == 100 - 15 - 7 - 7 - 3 - 3


def test_score_and_grade_edges() -> None:
    assert checkup.score([]) == 100 and checkup.grade(100) == "A"
    assert checkup.score([checkup.Finding("high", "x", "y")]) == 85
    assert checkup.score([checkup.Finding("high", "x", "y")] * 10) == 0
    assert (checkup.grade(80), checkup.grade(79), checkup.grade(0)) == ("B", "C", "F")


@pytest.mark.parametrize("repo", ["", "acme", "acme/", "a/b/c"])
def test_bad_repo_names(repo: str) -> None:
    with pytest.raises(checkup.CheckupError, match="owner/name"):
        checkup.analyze(repo)


def test_missing_repo_and_rate_limit() -> None:
    with respx.mock(base_url=API) as r:
        r.get("/repos/acme/gone").respond(404)
        r.get("/repos/acme/busy").respond(403, headers={"x-ratelimit-remaining": "0"})
        with pytest.raises(checkup.CheckupError, match="Can't find"):
            checkup.analyze("acme/gone", client=httpx.Client(base_url=API))
        with pytest.raises(checkup.CheckupError, match="rate limit"):
            checkup.analyze("acme/busy", client=httpx.Client(base_url=API))
