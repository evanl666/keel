"""Team Wrapped, the share cards and the new API routes, mostly on the demo org."""

from __future__ import annotations

import datetime as dt
import typing
import xml.etree.ElementTree as ET

import pytest
import sqlalchemy as sa
from fastapi import testclient

import keel.demo
from keel import db, ledger, models, steward, svg, wrapped

from .test_api import demo as demo
from .test_api import drain_all, ok
from .test_api import fresh as fresh


def _team(s: typing.Any, slug: str) -> models.Team:
    org = s.scalar(sa.select(models.Org))
    return steward.team_by_slug(s, org.id, slug)


@pytest.fixture
def seeded(database: str) -> None:
    with db.session() as s:
        keel.demo.seed(s)


def test_demo_teams_each_get_a_different_persona(seeded: None) -> None:
    with db.session() as s:
        got = {slug: wrapped.compute(s, _team(s, slug)) for slug in ("payments", "platform", "mobile")}
    assert {k: f["persona"]["name"] for k, f in got.items()} == {
        "payments": "The Closers",
        "platform": "The Good Neighbours",
        "mobile": "The Speedrunners",
    }
    pay = got["payments"]
    assert pay["kept"] == 8 and pay["on_time_rate"] == 1.0 and pay["longest_on_time_streak"] == 8
    assert pay["best_partner"] == {"team": "Platform", "count": 4}
    assert pay["top_closers"][0]["kept"] >= 2 and pay["busiest_day"]
    assert got["mobile"]["fastest"]["hours"] < 1


def test_empty_team_and_single_close(team: models.Team) -> None:
    with db.session() as s:
        t = s.get(models.Team, team.id)
        facts = wrapped.compute(s, t)
        assert facts["made"] == facts["kept"] == 0 and facts["on_time_rate"] is None
        assert facts["persona"]["name"] == "The Calm Before" and facts["fastest"] is None
        assert ET.fromstring(wrapped.card(facts)) is not None
        c = ledger.create(s, team=t, title="Fix it", actor="t", due_at=models.utcnow() + dt.timedelta(days=1))
        ledger.update(s, c, "t", status="done")
        one = wrapped.compute(s, t)
        assert one["kept"] == one["on_time"] == 1 and one["on_time_rate"] == 1.0
        with pytest.raises(ValueError, match="1 to 366"):
            wrapped.compute(s, t, days=0)


class _Model:
    def __init__(self, reply: typing.Any) -> None:
        self.reply = reply

    def invoke(self, _prompt: typing.Any) -> typing.Any:
        if isinstance(self.reply, Exception):
            raise self.reply
        return type("R", (), {"content": self.reply})()


def test_headline_cleans_model_output_and_falls_back() -> None:
    facts = {"persona": {"name": "The Closers", "line": "Say it, ship it."}}
    assert wrapped.headline(_Model('  "Eight for eight, Payments."  '), facts) == "Eight for eight, Payments."
    assert wrapped.headline(_Model(RuntimeError("down")), facts) == "Say it, ship it."
    assert wrapped.headline(_Model(""), facts) == "Say it, ship it."
    assert wrapped.headline(None, facts) == "Say it, ship it."


def test_svg_helpers() -> None:
    b = svg.badge("promises kept", "82%", svg.color_for_rate(0.82))
    assert ET.fromstring(b).get("width") and svg.COLORS["lime"] in b
    assert svg.color_for_rate(None) == svg.COLORS["grey"] and svg.color_for_rate(0.1) == svg.COLORS["red"]
    assert svg.color_for_grade("A") == svg.COLORS["green"] and svg.color_for_grade("F") == svg.COLORS["red"]
    assert svg.text_width("") == 0 and svg.text_width("W") > svg.text_width("i")
    long = svg.card(svg.Card(eyebrow="x", title="t" * 300, big="100%", big_caption="c", quote="q" * 300))
    assert "t" * 41 not in long and "…" in long


def test_api_wrapped_promises_and_checkup_badges(demo: testclient.TestClient) -> None:
    w = ok(demo.get("/api/teams/payments/wrapped"))
    assert w["persona"]["name"] == "The Closers" and w["headline"]
    card = demo.get("/api/teams/payments/wrapped/card.svg?days=90")
    assert card.status_code == 200 and card.headers["content-type"].startswith("image/svg+xml")
    assert demo.get("/api/teams/payments/wrapped?days=0").status_code == 422

    p = ok(demo.post("/api/promises", json={"repo": "acme/payments"}))
    assert p["stats"]["promises"] == len(p["promises"]) > 0 and p["card_svg"].startswith("<svg")
    assert "Promise check" in p["markdown"]
    week = ok(demo.post("/api/promises", json={"repo": "acme/payments", "days": 7}))
    assert week["days"] == 7 and 0 < len(week["promises"]) < len(p["promises"])
    assert "last 7 days" in week["markdown"] and week["private"] is False
    bad = demo.post("/api/promises", json={"repo": "nope"})
    assert bad.status_code == 422 and "owner/name" in bad.json()["detail"]

    started = ok(demo.post("/api/checkups", json={"repo": "acme/payments"}))
    assert demo.get(f"/api/checkups/{started['id']}/badge.svg").status_code == 409
    drain_all()
    badge = demo.get(f"/api/checkups/{started['id']}/badge.svg")
    assert badge.status_code == 200 and "keel checkup" in badge.text
    assert ET.fromstring(demo.get(f"/api/checkups/{started['id']}/card.svg").text) is not None
    assert demo.get("/api/checkups/nope/card.svg").status_code == 404


def test_share_routes_need_a_signed_in_user(fresh: testclient.TestClient) -> None:
    # Outside demo mode nothing about a repo or a team is served to someone who isn't signed in.
    for path in (
        "/api/checkups/any/badge.svg",
        "/api/checkups/any/card.svg",
        "/api/teams/payments/wrapped/card.svg",
    ):
        assert fresh.get(path).status_code == 401
    assert fresh.post("/api/promises", json={"repo": "acme/payments"}).status_code == 401
