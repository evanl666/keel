"""What an outside team needs on day one: people and invites, setup and login guards, knowledge upkeep,
GitHub without webhooks, Slack channel names / DMs / slash commands, audit export, metrics and backups."""

from __future__ import annotations

import datetime as dt
import json
import time
import types
import typing

import httpx
import pytest
import sqlalchemy as sa
from fastapi import testclient

from keel import (
    auth_utils,
    config,
    db,
    feed,
    github_poll,
    inbox,
    knowledge,
    knowledge_sync,
    metrics,
    models,
    people,
    slack_app,
    slack_lookup,
    steward,
    worker,
)
from keel.api import app as app_module

PASSWORD = "correct horse battery"


def ok(r: typing.Any) -> typing.Any:
    assert r.status_code < 400, (r.request.url, r.status_code, r.text[:300])
    return r.json()


@pytest.fixture
def client(database: str, monkeypatch: pytest.MonkeyPatch) -> typing.Iterator[testclient.TestClient]:
    """A real (non-demo) install with Ada as org admin and a Payments team."""
    monkeypatch.setenv("KEEL_RUN_WORKER_IN_PROCESS", "0")
    monkeypatch.setenv("KEEL_BASE_URL", "https://keel.test")
    config.reset()
    with testclient.TestClient(app_module.create_app()) as c:
        ok(
            c.post(
                "/api/setup/admin",
                json={
                    "org_name": "Testco",
                    "email": "ada@test.example",
                    "name": "Ada",
                    "password": PASSWORD,
                    "setup_code": auth_utils.setup_code(),
                },
            )
        )
        ok(c.post("/api/teams", json={"name": "Payments", "steward_name": "Pip"}))
        yield c


def invite_and_join(
    c: testclient.TestClient, email: str, name: str, teams: list[dict] | None = None, role: str = "member"
) -> testclient.TestClient:
    """Ada invites someone; they accept on a second client. Returns their signed-in client."""
    made = ok(c.post("/api/invites", json={"email": email, "role": role, "teams": teams or []}))
    token = made["url"].rsplit("/", 1)[-1]
    assert made["url"].startswith("https://keel.test/invite/")
    other = testclient.TestClient(c.app)
    info = ok(other.get(f"/api/invite/{token}"))
    assert info["email"] == email.lower() and info["status"] == "pending"
    ok(other.post(f"/api/invite/{token}", json={"name": name, "password": PASSWORD}))
    return other


# ---------------------------------------------------------------- people and invites


def test_invite_accept_and_team_membership(client: testclient.TestClient) -> None:
    lena = invite_and_join(client, "Lena@Test.example", "Lena", [{"slug": "payments", "role": "admin"}])
    me = ok(lena.get("/api/me"))["user"]
    assert me["email"] == "lena@test.example" and me["role"] == "member"
    team = ok(lena.get("/api/teams/payments"))
    assert team["my_role"] == "admin"
    members = ok(client.get("/api/teams/payments/members"))
    assert {m["email"]: m["role"] for m in members}["lena@test.example"] == "admin"
    assert len(ok(client.get("/api/people"))) == 2
    assert lena.get("/api/people").status_code == 403, "only org admins manage people"


def test_invite_link_is_single_use_and_revocable(client: testclient.TestClient) -> None:
    made = ok(client.post("/api/invites", json={"email": "theo@test.example"}))
    token = made["url"].rsplit("/", 1)[-1]
    again = client.post("/api/invites", json={"email": "theo@test.example"})
    assert again.status_code < 400, "re-inviting replaces the pending invite instead of failing"
    assert ok(client.get(f"/api/invite/{token}"))["status"] == "revoked"
    new_token = again.json()["url"].rsplit("/", 1)[-1]
    ok(client.delete(f"/api/invites/{again.json()['invite']['id']}"))
    other = testclient.TestClient(client.app)
    r = other.post(f"/api/invite/{new_token}", json={"name": "Theo", "password": PASSWORD})
    assert r.status_code == 400 and "withdrawn" in r.json()["detail"].lower()
    assert other.get("/api/invite/not-a-token").status_code == 404
    taken = client.post("/api/invites", json={"email": "ada@test.example"})
    assert taken.status_code == 400 and "already has an account" in taken.json()["detail"]


def test_expired_invite_is_refused(client: testclient.TestClient) -> None:
    made = ok(client.post("/api/invites", json={"email": "old@test.example"}))
    with db.session() as s:
        s.execute(sa.update(models.Invite).values(expires_at=models.utcnow() - dt.timedelta(minutes=1)))
    token = made["url"].rsplit("/", 1)[-1]
    other = testclient.TestClient(client.app)
    assert ok(other.get(f"/api/invite/{token}"))["status"] == "expired"
    r = other.post(f"/api/invite/{token}", json={"name": "Old", "password": PASSWORD})
    assert r.status_code == 400 and "expired" in r.json()["detail"].lower()


def test_last_admin_is_protected_and_disabled_people_are_signed_out(
    client: testclient.TestClient,
) -> None:
    ada = next(p for p in ok(client.get("/api/people")) if p["email"] == "ada@test.example")
    r = client.patch(f"/api/people/{ada['id']}", json={"role": "member"})
    assert r.status_code == 409 and "admin" in r.json()["detail"].lower()
    assert client.delete(f"/api/people/{ada['id']}").status_code == 409
    raj = invite_and_join(client, "raj@test.example", "Raj", [{"slug": "payments", "role": "member"}])
    raj_id = ok(raj.get("/api/me"))["user"]["id"]
    ok(client.patch(f"/api/people/{raj_id}", json={"disabled": True}))
    assert raj.get("/api/overview").status_code == 401, "a disabled person's session stops working"
    bad = testclient.TestClient(client.app).post(
        "/api/auth/login", json={"email": "raj@test.example", "password": PASSWORD}
    )
    assert bad.status_code in (401, 403)


def test_team_admin_manages_members_but_not_org(client: testclient.TestClient) -> None:
    lena = invite_and_join(client, "lena@test.example", "Lena", [{"slug": "payments", "role": "admin"}])
    invite_and_join(client, "raj@test.example", "Raj")
    added = ok(lena.post("/api/teams/payments/members", json={"email": "raj@test.example"}))
    assert added["role"] == "member"
    missing = lena.post("/api/teams/payments/members", json={"email": "nobody@test.example"})
    assert missing.status_code == 404 and "Invite them first" in missing.json()["detail"]
    ok(lena.patch(f"/api/teams/payments/members/{added['user_id']}", json={"role": "admin"}))
    ok(lena.delete(f"/api/teams/payments/members/{added['user_id']}"))
    assert lena.post("/api/invites", json={"email": "x@test.example"}).status_code == 403


def test_sso_groups_put_people_on_teams(client: testclient.TestClient) -> None:
    ok(client.patch("/api/teams/payments", json={"sso_groups": ["eng-payments", " ", "eng-payments"]}))
    with db.session() as s:
        org = s.scalar(sa.select(models.Org))
        u = models.User(org_id=org.id, email="sso@test.example", name="Sso", role="member")
        s.add(u)
        s.flush()
        assert people.sync_sso_groups(s, u, ["eng-payments", "other"]) == ["payments"]
        assert [t.slug for t, _ in people.teams_of(s, u)] == ["payments"]
        assert people.sync_sso_groups(s, u, []) == []


# ---------------------------------------------------------------- setup and login guards


def test_login_is_throttled_after_repeated_failures(client: testclient.TestClient) -> None:
    other = testclient.TestClient(client.app)
    body = {"email": "ada@test.example", "password": "nope"}
    codes = [
        other.post("/api/auth/login", json=body).status_code for _ in range(config.get().login_max_failures)
    ]
    assert set(codes) == {401}
    blocked = other.post("/api/auth/login", json={**body, "password": PASSWORD})
    assert blocked.status_code == 429 and "Wait" in blocked.json()["detail"]
    with db.session() as s:
        s.execute(sa.delete(models.LoginFailure))
    ok(other.post("/api/auth/login", json={**body, "password": PASSWORD}))


def test_setup_code_is_stable_and_overridable(database: str, monkeypatch: pytest.MonkeyPatch) -> None:
    code = auth_utils.setup_code()
    assert len(code) == 9 and code[4] == "-" and code == auth_utils.setup_code()
    assert auth_utils.setup_code_ok(code.lower().replace("-", ""))
    monkeypatch.setenv("KEEL_SETUP_CODE", "hello-world")
    config.reset()
    assert auth_utils.setup_code_ok("HELLO-WORLD") and not auth_utils.setup_code_ok(code)


# ---------------------------------------------------------------- team settings


def test_team_settings_validate_and_delete_keeps_the_audit(client: testclient.TestClient) -> None:
    t = ok(
        client.patch(
            "/api/teams/payments",
            json={
                "github_repos": ["https://github.com/acme/api/", "acme/api", "acme/web"],
                "timezone": "Europe/Berlin",
                "brief_hour": 8,
                "slack_channel": "payments-eng",
            },
        )
    )
    assert t["settings"]["github_repos"] == ["acme/api", "acme/web"]
    assert t["settings"]["timezone"] == "Europe/Berlin" and t["settings"]["brief_hour"] == 8
    assert t["settings"]["slack_channel"] == "#payments-eng"
    for bad in ({"github_repos": ["not a repo"]}, {"timezone": "Mars/Base"}, {"brief_hour": 24}):
        assert client.patch("/api/teams/payments", json=bad).status_code == 400
    assert client.delete("/api/teams/payments").status_code == 400, "needs ?confirm=<slug>"
    ok(client.delete("/api/teams/payments?confirm=payments"))
    assert client.get("/api/teams/payments").status_code == 404
    actions = [a["action"] for a in ok(client.get("/api/audit"))]
    assert "team.deleted" in actions and "team.updated" in actions


# ---------------------------------------------------------------- knowledge upkeep


def test_knowledge_edit_review_delete_and_no_duplicates(client: testclient.TestClient) -> None:
    doc = ok(
        client.post(
            "/api/teams/payments/knowledge",
            json={"title": "Refunds", "content": "Ravi approves refunds.", "review_by": "2020-01-01"},
        )
    )
    same = ok(client.post("/api/teams/payments/knowledge", json={"title": "Refunds", "content": "v2"}))
    assert same["id"] == doc["id"], "same title replaces instead of duplicating"
    assert len(ok(client.get("/api/teams/payments/knowledge"))) == 1
    edited = ok(
        client.patch(
            f"/api/teams/payments/knowledge/{doc['id']}",
            json={"content": "Maya approves refunds over $10k.", "review_by": "2020-01-01"},
        )
    )
    assert edited["stale"] is True
    full = ok(client.get(f"/api/teams/payments/knowledge/{doc['id']}"))
    assert full["content"] == "Maya approves refunds over $10k."
    reviewed = ok(client.post(f"/api/teams/payments/knowledge/{doc['id']}/reviewed"))
    assert reviewed["stale"] is False and reviewed["review_by"] > dt.date.today().isoformat()
    ok(client.delete(f"/api/teams/payments/knowledge/{doc['id']}"))
    assert ok(client.get("/api/teams/payments/knowledge")) == []
    assert client.get(f"/api/teams/payments/knowledge/{doc['id']}").status_code == 404


def _mock_web(pages: dict[str, tuple[int, str, str]]) -> httpx.MockTransport:
    """url or API path → (status, content-type, body)."""

    def handle(req: httpx.Request) -> httpx.Response:
        key = str(req.url) if str(req.url) in pages else req.url.path
        status, ctype, body = pages.get(key, (404, "application/json", '{"message": "Not Found"}'))
        return httpx.Response(status, headers={"content-type": ctype}, text=body)

    return httpx.MockTransport(handle)


def test_url_source_syncs_updates_and_reports_errors(team: models.Team) -> None:
    page = "<html><head><title>On-call</title></head><body><h1>On-call</h1><p>Page Ravi.</p><script>x()</script></body></html>"
    web = {"https://wiki.test/oncall": (200, "text/html; charset=utf-8", page)}
    with db.session() as s:
        t = s.get(models.Team, team.id)
        src = knowledge_sync.add_source(s, t, "url", "https://wiki.test/oncall", "internal", "user:ada")
        with pytest.raises(ValueError, match="already syncs"):
            knowledge_sync.add_source(s, t, "url", "https://wiki.test/oncall", "internal", "user:ada")
        knowledge_sync.sync(s, src, _mock_web(web))
        assert src.status == "ok" and "1 new" in src.status_line
        doc = s.scalar(sa.select(models.KnowledgeDoc).where(models.KnowledgeDoc.sync_id == src.id))
        assert doc.title == "On-call" and "Page Ravi." in doc.content and "x()" not in doc.content
        assert doc.source_url == "https://wiki.test/oncall" and doc.origin == "url"
        knowledge_sync.sync(s, src, _mock_web(web))
        assert "0 new, 0 changed" in src.status_line
        web["https://wiki.test/oncall"] = (200, "text/html", page.replace("Ravi", "Maya"))
        knowledge_sync.sync(s, src, _mock_web(web))
        assert "1 changed" in src.status_line
        knowledge_sync.sync(s, src, _mock_web({}))
        assert src.status == "error" and "404" in src.status_line
        assert src.next_sync_at - models.utcnow() <= knowledge_sync.RETRY_AFTER_ERROR
        with pytest.raises(ValueError):
            knowledge_sync.check_target("url", "file:///etc/passwd")


def test_github_folder_source_adds_and_removes_docs(team: models.Team) -> None:
    tree = {
        "tree": [
            {"type": "blob", "path": "docs/runbooks/deploy.md", "size": 40},
            {"type": "blob", "path": "docs/runbooks/rollback.md", "size": 40},
            {"type": "blob", "path": "docs/logo.png", "size": 40},
            {"type": "blob", "path": "src/app.py", "size": 40},
        ]
    }
    api = {
        "/repos/acme/handbook": (200, "application/json", '{"default_branch": "main"}'),
        "/repos/acme/handbook/git/trees/main": (200, "application/json", json.dumps(tree)),
        "/repos/acme/handbook/contents/docs/runbooks/deploy.md": (
            200,
            "text/plain",
            "# Deploy\nMerge, then tag.",
        ),
        "/repos/acme/handbook/contents/docs/runbooks/rollback.md": (200, "text/plain", "Revert the tag."),
    }
    with db.session() as s:
        t = s.get(models.Team, team.id)
        src = knowledge_sync.add_source(s, t, "github", "acme/handbook/docs/runbooks", "internal", "user:ada")
        knowledge_sync.sync(s, src, _mock_web(api))
        docs = {d.title: d for d in s.scalars(sa.select(models.KnowledgeDoc))}
        assert set(docs) == {"Deploy", "Rollback"}
        assert (
            docs["Deploy"].source_url == "https://github.com/acme/handbook/blob/main/docs/runbooks/deploy.md"
        )
        tree["tree"].pop(1)
        api["/repos/acme/handbook/git/trees/main"] = (200, "application/json", json.dumps(tree))
        knowledge_sync.sync(s, src, _mock_web(api))
        assert "1 removed" in src.status_line
        assert [d.title for d in s.scalars(sa.select(models.KnowledgeDoc))] == ["Deploy"]


def test_source_endpoints_and_removal(client: testclient.TestClient) -> None:
    src = ok(
        client.post(
            "/api/teams/payments/knowledge-sources", json={"kind": "github", "target": "acme/handbook/docs"}
        )
    )
    assert src["status"] == "pending"
    with db.session() as s:
        job = s.scalar(sa.select(models.Job).where(models.Job.kind == "sync_knowledge"))
        assert job is not None and job.payload["source"] == src["id"]
    bad = client.post("/api/teams/payments/knowledge-sources", json={"kind": "github", "target": "nope"})
    assert bad.status_code == 400
    assert len(ok(client.get("/api/teams/payments/knowledge-sources"))) == 1
    ok(client.delete(f"/api/teams/payments/knowledge-sources/{src['id']}"))
    assert ok(client.get("/api/teams/payments/knowledge-sources")) == []


# ---------------------------------------------------------------- GitHub without a webhook


def _issue(n: int, created: str, title: str = "Login is broken", pr: bool = False) -> dict:
    item = {
        "number": n,
        "title": title,
        "body": "@keel please look",
        "created_at": created,
        "html_url": f"https://github.com/acme/api/issues/{n}",
        "repository_url": "https://api.github.com/repos/acme/api",
        "user": {"login": "maya"},
    }
    if pr:
        item["pull_request"] = {"url": "x"}
    return item


def test_github_poll_starts_at_now_then_picks_up_new_items_once(
    team: models.Team, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KEEL_GITHUB_TOKEN", "ghp_test")
    config.reset()
    later = (models.utcnow() + dt.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    issues = [_issue(1, "2020-01-01T00:00:00Z"), _issue(7, later), _issue(8, later, "Fix login", pr=True)]
    comments = [
        {
            "id": 99,
            "body": "@keel any news?",
            "created_at": later,
            "html_url": "u",
            "user": {"login": "lena"},
        },
        {"id": 100, "body": "Done. <!-- keel-op: abc -->", "created_at": later, "html_url": "u", "user": {}},
    ]
    api = {
        "/repos/acme/api/issues": (200, "application/json", json.dumps(issues)),
        "/repos/acme/api/issues/comments": (200, "application/json", json.dumps(comments)),
    }
    with db.session() as s:
        t = s.get(models.Team, team.id)
        assert github_poll.enabled(s, t.org_id)
        assert github_poll.poll_repo(s, t.org_id, t, "acme/api", _mock_web(api)) == 0, (
            "first run: cursor only"
        )
        assert github_poll.poll_repo(s, t.org_id, t, "acme/api", _mock_web(api)) == 3
        assert github_poll.poll_repo(s, t.org_id, t, "acme/api", _mock_web(api)) == 0, "no repeats"
        ids = set(s.scalars(sa.select(models.InboxEvent.external_id)))
        assert ids == {"issue:acme/api#7", "pr:acme/api#8", "comment:99"}
        webhook_dup = github_poll.record(s, t.org_id, t, "acme/api", github_poll.event_from_issue(issues[1]))
        assert webhook_dup is False, "the webhook and the poller share ids, so nothing is handled twice"
    monkeypatch.setenv("KEEL_GITHUB_WEBHOOK_SECRET", "whsec")
    config.reset()
    with db.session() as s:
        assert not github_poll.enabled(s, s.scalar(sa.select(models.Org.id)))


def test_worker_timer_gate_fires_once_per_interval(database: str) -> None:
    now = models.utcnow()
    every = dt.timedelta(minutes=2)
    with db.session() as s:
        assert worker._every(s, "t", every, now)
        assert not worker._every(s, "t", every, now + dt.timedelta(minutes=1))
        assert worker._every(s, "t", every, now + dt.timedelta(minutes=3))


# ---------------------------------------------------------------- Slack: names, DMs, slash commands


class FakeSlack:
    """The few Web API calls Keel makes, answered from a tiny workspace."""

    def __init__(self) -> None:
        self.channels = [{"id": "C0PAY1234", "name": "payments", "num_members": 9}]
        self.users = {"U1": {"profile": {"email": "ada@test.example", "display_name": "Ada"}}}
        self.posted: list[dict] = []

    def conversations_list(self, **_: typing.Any) -> dict:
        return {"channels": self.channels, "response_metadata": {"next_cursor": ""}}

    def conversations_info(self, channel: str) -> dict:
        return {"channel": next(c for c in self.channels if c["id"] == channel)}

    def users_info(self, user: str) -> dict:
        return {"user": self.users[user]}

    def chat_postMessage(self, **kw: typing.Any) -> dict:
        self.posted.append(kw)
        return {"ok": True}


def _bridge(org_id: str, fake: FakeSlack) -> slack_app.SlackBridge:
    bridge = object.__new__(slack_app.SlackBridge)
    bridge.org_id, bridge.app, bridge._explained = org_id, types.SimpleNamespace(client=fake), set()
    return bridge


def test_channel_name_is_resolved_to_its_id(team: models.Team) -> None:
    fake = FakeSlack()
    with db.session() as s:
        t = s.get(models.Team, team.id)
        assert t.slack_channel_name == "#payments" and t.slack_channel_id is None
        assert slack_lookup.resolve_team(s, t, fake) and t.slack_channel_id == "C0PAY1234"
        slack_lookup.set_channel(t, "C0NEW5678")
        assert t.slack_channel_id == "C0NEW5678" and t.slack_channel_name is None
        slack_lookup.set_channel(t, "payments")
        assert t.slack_channel_name == "#payments" and t.slack_channel_id is None
        assert slack_lookup.team_for_new_channel(s, t.org_id, "C0PAY1234", fake).id == t.id
        assert inbox.team_for_channel(s, "C0PAY1234").id == t.id


def test_dm_and_slash_command_reach_the_right_team(team: models.Team) -> None:
    fake = FakeSlack()
    with db.session() as s:
        org_id = s.get(models.Team, team.id).org_id
    bridge = _bridge(org_id, fake)
    bridge._record({"channel": "D0DM", "channel_type": "im", "user": "U2", "text": "hi", "ts": "1.1"}, True)
    assert fake.posted and fake.posted[0]["text"] == slack_app.NO_TEAM_DM, "a stranger gets told why"
    bridge._record({"channel": "D0DM", "channel_type": "im", "user": "U2", "text": "hi", "ts": "1.2"}, True)
    assert len(fake.posted) == 1, "only once"
    with db.session() as s:
        ada = s.scalar(sa.select(models.User))
        people.set_member(s, s.get(models.Team, team.id), ada, "member", actor="test")
    bridge._record({"channel": "D0DM", "channel_type": "im", "user": "U1", "text": "hi", "ts": "1.3"}, True)
    with db.session() as s:
        ev = s.scalar(sa.select(models.InboxEvent))
        assert ev.team_id == team.id and ev.payload["channel"] == "D0DM"
        assert s.scalar(sa.select(models.User)).slack_user_id == "U1", "linked by Slack email"
    acks: list[str] = []
    replies: list[dict] = []
    bridge._on_command(ack=acks.append, command={"text": "help", "user_id": "U1", "channel_id": "D0DM"})
    assert "/keel ask" in acks[-1]
    with db.session() as s:
        t = s.get(models.Team, team.id)
        knowledge.add(s, t, "Refunds", "Maya approves refunds over $10k.", "internal")
    bridge._on_command(
        ack=acks.append,
        command={"text": "ask who approves refunds?", "user_id": "U1", "channel_id": "D0DM"},
        respond=lambda **kw: replies.append(kw),
    )
    assert acks[-1].endswith("Looking…")
    assert replies and replies[0]["response_type"] == "ephemeral"
    assert (
        "Sources: <http://localhost:8420/teams/payments/knowledge?doc=" in replies[0]["text"]
        and "|Refunds>" in replies[0]["text"]
    )


def test_dm_answer_goes_back_to_the_dm_with_source_links(team: models.Team) -> None:
    with db.session() as s:
        t = s.get(models.Team, team.id)
        t.slack_channel_id = "C0PAY1234"
        knowledge.add(s, t, "Refunds", "Maya approves refunds over $10k.", "internal")
        ev = inbox.record(
            s,
            t.org_id,
            t.id,
            "slack",
            "D0DM:5.0",
            "message",
            {
                "text": "who approves refunds?",
                "user": "U1",
                "user_name": "Ada",
                "channel": "D0DM",
                "ts": "5.0",
                "thread_ts": "5.0",
                "directed": True,
            },
        )
        steward.process_inbox(ev.id, s)
        op = s.scalar(sa.select(models.Operation).where(models.Operation.kind.like("slack.%")))
        assert op is not None and op.payload["channel"] == "D0DM" and "thread_ts" not in op.payload
        assert op.target == "DM with Ada" and "Sources: <http://localhost:8420/" in op.payload["text"]


# ---------------------------------------------------------------- audit, metrics, housekeeping


def test_audit_export_is_admin_only_and_scoped(client: testclient.TestClient) -> None:
    ok(client.post("/api/teams", json={"name": "Platform", "steward_name": "Ops"}))
    raj = invite_and_join(client, "raj@test.example", "Raj", [{"slug": "payments", "role": "member"}])
    seen = {a["team_slug"] for a in ok(raj.get("/api/audit"))}
    assert "platform" not in seen, "members only see their own teams' audit rows"
    assert raj.get("/api/audit/export").status_code == 403
    csv_text = client.get("/api/audit/export?format=csv").text
    assert (
        csv_text.splitlines()[0] == "at,actor,action,target,detail,team_slug" and "team.created" in csv_text
    )
    lines = client.get("/api/audit/export?format=json&since=2000-01-01").text.splitlines()
    assert lines and all(json.loads(x)["action"] for x in lines)
    assert "audit.exported" in [a["action"] for a in ok(client.get("/api/audit"))]


def test_audit_retention_prunes_old_rows(team: models.Team) -> None:
    with db.session() as s:
        s.add(
            models.AuditLog(
                org_id=team.org_id,
                actor="x",
                action="old",
                target="",
                at=models.utcnow() - dt.timedelta(days=400),
            )
        )
        s.flush()
        assert feed.prune_audit(s, 0) == 0, "0 keeps everything"
        assert feed.prune_audit(s, 365) == 1
        assert s.scalar(sa.select(models.AuditLog).where(models.AuditLog.action == "old")) is None


def test_state_metrics_report_queue_and_team_gauges(team: models.Team) -> None:
    from prometheus_client import exposition, registry

    reg = registry.CollectorRegistry()
    reg.register(metrics.StateCollector())
    text = exposition.generate_latest(reg).decode()
    for name in ("keel_jobs_queued", "keel_inbox_unprocessed", "keel_steward_level", "keel_knowledge_stale"):
        assert name in text
    assert 'keel_steward_level{team="payments"} 2.0' in text


def test_oidc_id_token_is_verified(monkeypatch: pytest.MonkeyPatch, database: str) -> None:
    from joserfc import jwk, jwt

    monkeypatch.setenv("KEEL_OIDC_ISSUER", "https://idp.test")
    monkeypatch.setenv("KEEL_OIDC_CLIENT_ID", "keel")
    config.reset()
    key = jwk.RSAKey.generate_key(2048, parameters={"kid": "k1"})
    jwks = {"keys": [key.as_dict(private=False)]}
    monkeypatch.setattr(httpx, "get", lambda *_a, **_k: types.SimpleNamespace(json=lambda: jwks))
    meta = {"issuer": "https://idp.test", "jwks_uri": "https://idp.test/jwks"}

    def token(**over: typing.Any) -> str:
        claims = {
            "iss": "https://idp.test",
            "aud": "keel",
            "nonce": "n1",
            "exp": int(time.time()) + 60,
            "sub": "1",
        }
        return jwt.encode({"alg": "RS256", "kid": "k1"}, {**claims, **over}, key)

    assert app_module.verify_id_token(token(), meta, "n1")["sub"] == "1"
    for bad in (
        token(nonce="other"),
        token(aud="evil"),
        token(exp=int(time.time()) - 600),
        token(iss="https://x"),
    ):
        with pytest.raises(Exception, match="couldn't be verified"):
            app_module.verify_id_token(bad, meta, "n1")


def test_chinese_knowledge_is_searchable(team: models.Team) -> None:
    assert knowledge.tokenize("") == [] and knowledge.tokenize("退") == ["退"]
    assert knowledge.tokenize("退款流程 refunds") == ["refund", "退款", "款流", "流程"]
    with db.session() as s:
        t = s.get(models.Team, team.id)
        knowledge.add(s, t, "退款审批", "超过一万美元的退款由 Maya 审批。", "internal")
        knowledge.add(s, t, "Deploys", "Merge to main, then tag a release.", "internal")
        found = knowledge.search(s, [t.id], "退款找谁审批？", "internal")
        assert found.passages and found.passages[0].title == "退款审批"


def test_search_matches_word_forms(team: models.Team) -> None:
    assert (
        knowledge.stem("") == "" and knowledge.stem("bus") == "bus" and knowledge.stem("status") == "status"
    )
    assert {knowledge.stem(w) for w in ("refund", "refunds", "refunded", "refunding")} == {"refund"}
    assert knowledge.stem("rotate") == knowledge.stem("rotating") and knowledge.stem("policies") == "policy"
    with db.session() as s:
        t = s.get(models.Team, team.id)
        knowledge.add(s, t, "Refunds", "Refunds over $10k need approval from Maya.", "internal")
        found = knowledge.search(s, [t.id], "who signs off on a $25k refund?", "internal")
        assert [p.title for p in found.passages] == ["Refunds"]


def test_page_title_ignores_svg_titles() -> None:
    page = (
        "<html><head><title>PEP 20</title></head><body><svg><title>Dark mode</title></svg>"
        "<nav>Home</nav><p>Errors should never pass silently.</p></body></html>"
    )
    assert knowledge_sync.html_to_text(page) == ("PEP 20", "Errors should never pass silently.")
    assert knowledge_sync.html_to_text("") == ("", "")
