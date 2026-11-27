import datetime as dt

import pytest

from keel import brain

NOW = dt.datetime(2026, 11, 26, 20, 0, tzinfo=dt.UTC)  # Thursday, 12:00 in Los Angeles
TZ = "America/Los_Angeles"


@pytest.mark.parametrize(
    ("text", "day"),
    [
        ("by 2026-12-03", "2026-12-03"),
        ("can you do it today", "2026-11-26"),
        ("by eod", "2026-11-26"),
        ("tomorrow please", "2026-11-27"),
        ("in 3 days", "2026-11-29"),
        ("by Friday", "2026-11-27"),
        ("next Friday", "2026-12-04"),
        ("by Dec 5", "2026-12-05"),
        ("end of week", "2026-11-27"),
    ],
)
def test_parse_due_reads_common_phrases(text: str, day: str) -> None:
    due = brain.parse_due(text, NOW, TZ)
    assert due is not None
    local = due.astimezone(__import__("zoneinfo").ZoneInfo(TZ))
    assert local.date().isoformat() == day
    assert local.hour == brain.DUE_HOUR_LOCAL


@pytest.mark.parametrize("text", ["", "no date here", "sometime"])
def test_parse_due_returns_none_without_a_date(text: str) -> None:
    assert brain.parse_due(text, NOW, TZ) is None


def test_rule_triage_finds_a_request_with_owner_and_due() -> None:
    t = brain.rule_triage(
        "@Pip can someone rotate the webhook secret by Friday?", now=NOW, tz=TZ, team_slugs=()
    )
    assert t.kind == "request"
    assert "rotate the webhook secret" in t.title.lower()
    assert t.due == "2026-11-27"


def test_rule_triage_spots_status_update_on_a_key() -> None:
    t = brain.rule_triage("C-88 is done", now=NOW, tz=TZ, team_slugs=())
    assert (t.kind, t.commitment_key, t.new_status) == ("update", "C-88", "done")


def test_rule_triage_routes_to_another_team() -> None:
    t = brain.rule_triage(
        "can platform bump the node version by next week?", now=NOW, tz=TZ, team_slugs=("platform",)
    )
    assert (t.kind, t.for_team, t.title) == ("request", "platform", "Bump the node version")


def test_rule_triage_ignores_chatter() -> None:
    assert brain.rule_triage("lol nice", now=NOW, tz=TZ, team_slugs=()).kind == "chatter"


def test_title_strips_mentions_and_trailing_dates() -> None:
    assert brain.title_from("@Pip please update the runbook tomorrow") == "Update the runbook"
