"""The HTTP API in demo mode: contract shapes, the scripted story, auth and setup guards."""

from __future__ import annotations

import typing

import pytest
import sqlalchemy as sa
from fastapi import testclient

from keel import auth_utils, db, models, worker
from keel.api import app as app_module


@pytest.fixture
def demo(database: str, monkeypatch: pytest.MonkeyPatch) -> typing.Iterator[testclient.TestClient]:
    monkeypatch.setenv("KEEL_DEMO", "1")
    monkeypatch.setenv("KEEL_RUN_WORKER_IN_PROCESS", "0")
    from keel import config

    config.reset()
    with testclient.TestClient(app_module.create_app()) as client:
        yield client


@pytest.fixture
def fresh(database: str, monkeypatch: pytest.MonkeyPatch) -> typing.Iterator[testclient.TestClient]:
    monkeypatch.setenv("KEEL_RUN_WORKER_IN_PROCESS", "0")
    with testclient.TestClient(app_module.create_app()) as client:
        yield client


def ok(r: typing.Any) -> typing.Any:
    assert r.status_code < 400, (r.request.url, r.status_code, r.text[:300])
    return r.json()


def drain_all() -> None:
    for _ in range(6):
        with db.session() as s:
            s.execute(
                sa.update(models.Job).where(models.Job.status == "queued").values(run_at=models.utcnow())
            )
        if worker.drain() == 0:
            return


def test_overview_and_team_pages(demo: testclient.TestClient) -> None:
    me = ok(demo.get("/api/me"))
    assert me["user"]["email"] == "avery@acme.example" and me["demo"] is True
    ov = ok(demo.get("/api/overview"))
    assert [t["slug"] for t in ov["teams"]] == ["payments", "platform", "mobile"]
    assert all(0 <= t["health"] <= 100 and t["steward"]["status_line"] for t in ov["teams"])
    team = ok(demo.get("/api/teams/payments"))
    assert team["steward"]["name"] == "Pip" and team["activity"]
    c88 = ok(demo.get("/api/commitments/c-88"))
    assert c88["key"] == "C-88" and c88["events"]
    assert demo.get("/api/teams/nope").status_code == 404
    nope = demo.get("/api/nope")
    assert nope.status_code == 404 and nope.json()["detail"] == "There's no API endpoint /api/nope."


def test_ask_cites_sources_and_withholds_restricted(demo: testclient.TestClient) -> None:
    a = ok(demo.post("/api/teams/payments/ask", json={"question": "How do we rotate the webhook secret?"}))
    assert a["answer"] and a["sources"]
    assert "kc-7f3a-payments-postmortem" not in a["answer"]


def test_validation_errors_are_one_line(demo: testclient.TestClient) -> None:
    r = demo.post("/api/commitments", json={"team": "payments", "title": "   "})
    assert r.status_code == 400 and isinstance(r.json()["detail"], str)
    r = demo.post("/api/commitments", json={"team": "payments"})
    assert r.status_code == 422


def test_demo_story_plays_every_step(demo: testclient.TestClient) -> None:
    seen = []
    while True:
        r = ok(demo.post("/api/demo/tick"))
        if r["title"] is None:
            break
        seen.append(r["title"])
        assert r["event"] is not None, f"step produced no activity: {r['title']}"
        drain_all()
    assert len(seen) == 11
    ops = ok(demo.get("/api/operations"))
    statuses = {o["status"] for o in ops}
    assert "reconciled" in statuses, "the lost-response write should be found, not resent"
    leak = [o for o in ops if o["error_class"] == "blocked"]
    assert leak and "restricted marker" in leak[0]["error_line"]
    with db.session() as s:
        sim = list(s.scalars(sa.select(models.SimRecord.op_id)))
    assert len(sim) == len(set(sim)), "no remote write should ever be duplicated"


def test_approve_sends_the_draft(demo: testclient.TestClient) -> None:
    pending = ok(demo.get("/api/approvals"))
    assert pending
    first = pending[0]
    with db.session() as s:
        before = s.scalar(sa.select(sa.func.count()).select_from(models.SimRecord))
    assert ok(demo.post(f"/api/approvals/{first['id']}/approve"))["status"] == "approved"
    assert demo.post(f"/api/approvals/{first['id']}/approve").status_code == 400
    drain_all()
    with db.session() as s:
        after = list(s.scalars(sa.select(models.SimRecord.text)))
    assert len(after) == before + 1, "the approved draft is sent exactly once"


def test_create_team_gives_it_a_steward(demo: testclient.TestClient) -> None:
    t = ok(demo.post("/api/teams", json={"name": "Data Science"}))
    assert t["slug"] == "data-science" and t["steward"]["name"]
    assert demo.post("/api/teams", json={"name": "Data Science"}).status_code == 400


def test_probes(demo: testclient.TestClient) -> None:
    assert ok(demo.get("/healthz"))["ok"] is True
    assert ok(demo.get("/readyz"))["ok"] is True
    assert "keel_operations_total" in demo.get("/metrics").text


def test_setup_is_open_until_an_admin_exists(fresh: testclient.TestClient) -> None:
    me = ok(fresh.get("/api/me"))
    assert me["user"] is None and me["setup_complete"] is False
    assert fresh.get("/api/overview").status_code == 401
    assert ok(fresh.get("/api/setup"))["needs_setup_code"] is True
    admin = {
        "org_name": "Testco",
        "email": "ada@test.example",
        "name": "Ada",
        "password": "correct horse battery",
    }
    wrong = fresh.post("/api/setup/admin", json={**admin, "setup_code": "0000-0000"})
    assert wrong.status_code == 400 and "setup code" in wrong.json()["detail"]
    ok(fresh.post("/api/setup/admin", json={**admin, "setup_code": auth_utils.setup_code().lower()}))
    assert ok(fresh.get("/api/setup"))["needs_setup_code"] is False
    assert ok(fresh.get("/api/me"))["user"]["role"] == "org_admin"
    fresh.cookies.clear()
    r = fresh.post(
        "/api/setup/admin",
        json={
            "org_name": "Evil",
            "email": "eve@x.example",
            "name": "Eve",
            "password": "correct horse battery",
        },
    )
    assert r.status_code in (401, 403)
    bad = fresh.post("/api/auth/login", json={"email": "ada@test.example", "password": "wrong"})
    assert bad.status_code == 401
    ok(fresh.post("/api/auth/login", json={"email": "ada@test.example", "password": "correct horse battery"}))
    assert ok(fresh.get("/api/me"))["user"]["email"] == "ada@test.example"


def test_setup_flags_an_unknown_model_provider(
    fresh: testclient.TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from keel import config

    # Docker Compose reads "KEEL_MODEL_PROVIDER=  # comment" as the comment, which once showed as "Connected".
    monkeypatch.setenv("KEEL_MODEL_PROVIDER", "# anthropic | openai")
    config.reset()
    model = next(st for st in ok(fresh.get("/api/setup"))["steps"] if st["id"] == "model")
    assert model["done"] is False and "Unknown model provider" in model["detail"]


def test_runner_endpoints_need_the_token(fresh: testclient.TestClient) -> None:
    assert "KEEL_RUNNER_TOKEN" in fresh.post("/api/runner/next", json={"runner": "box"}).json()["detail"]


def test_github_webhook_off_without_secret(fresh: testclient.TestClient) -> None:
    r = fresh.post("/hooks/github", content=b"{}", headers={"X-GitHub-Event": "ping"})
    assert r.status_code in (403, 404, 503)


def test_ui_deep_links_serve_the_app(
    demo: testclient.TestClient, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "index.html").write_text("<html>keel ui</html>")
    monkeypatch.setattr(app_module, "WEB_DIST", tmp_path)
    with testclient.TestClient(app_module.create_app()) as client:
        for path in ("/", "/teams/payments/front-desk", "/ledger"):
            r = client.get(path)
            assert r.status_code == 200 and "keel ui" in r.text, path
        assert client.get("/assets/gone-123.js").status_code == 404
        assert client.get("/api/nope").status_code == 404
