"""The MCP server, driven in-process by the real MCP client over the demo org."""

from __future__ import annotations

import typing

import pytest
import sqlalchemy as sa
from mcp.client import client as mcp_client

import keel.demo
from keel import db, ledger, mcp_server, models

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def seeded(database: str) -> None:
    with db.session() as s:
        keel.demo.seed(s)


async def _call(server: typing.Any, tool: str, **args: typing.Any) -> typing.Any:
    async with mcp_client.Client(server) as c:
        res = await c.call_tool(tool, args)
    if res.is_error:
        return ("error", " ".join(getattr(b, "text", "") for b in res.content))
    sc = res.structured_content
    return sc["result"] if isinstance(sc, dict) and set(sc) == {"result"} else sc


async def test_lists_tools_with_read_only_hints(seeded: None) -> None:
    async with mcp_client.Client(mcp_server.build()) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert set(tools) == {
        "list_teams",
        "ask_team",
        "list_commitments",
        "log_commitment",
        "update_commitment",
        "team_wrapped",
        "find_promises",
    }
    assert tools["ask_team"].annotations.read_only_hint is True
    assert tools["log_commitment"].annotations.read_only_hint is False


async def test_read_tools(seeded: None) -> None:
    server = mcp_server.build()
    teams = await _call(server, "list_teams")
    assert [t["slug"] for t in teams] == ["mobile", "payments", "platform"]
    assert all(t["steward"] and 0 <= t["health"] <= 100 for t in teams)
    ans = await _call(server, "ask_team", team="#payments", question="how do I rotate the webhook secret?")
    assert ans["sources"] and ans["answer"].startswith("From [")
    open_pay = await _call(server, "list_commitments", team="payments")
    assert open_pay and all(
        c["owner_team"] == "payments" and c["status"] in ledger.OPEN_STATUSES for c in open_pay
    )
    assert any(c["risk"] == "overdue" for c in open_pay)
    done = await _call(server, "list_commitments", team="payments", status="done")
    assert len(done) >= 8
    wrapped = await _call(server, "team_wrapped", team="payments")
    assert wrapped["persona"]["name"] == "The Closers"


async def test_errors_are_plain(seeded: None) -> None:
    server = mcp_server.build()
    kind, text = await _call(server, "ask_team", team="nope", question="hi")
    assert kind == "error" and "No team 'nope'" in text and "payments" in text
    kind, text = await _call(server, "list_commitments", status="weird")
    assert kind == "error" and "status must be" in text
    kind, text = await _call(server, "log_commitment", team="payments", title="x")
    assert kind == "error" and "read-only" in text


async def test_writes_act_as_the_user(seeded: None) -> None:
    server = mcp_server.build("Avery@acme.example")
    got = await _call(server, "log_commitment", team="payments", title="Ship the fix", due="2026-12-04")
    assert got["key"].startswith("C-") and got["due"] == "2026-12-04"
    kind, text = await _call(server, "log_commitment", team="payments", title="x", due="someday soon")
    assert kind == "error" and "Couldn't read the date" in text
    done = await _call(server, "update_commitment", key=got["key"].lower(), status="done")
    assert done == {"key": got["key"], "status": "done"}
    with db.session() as s:
        org_id = s.scalar(sa.select(models.Org)).id
        c = ledger.get(s, org_id, got["key"])
        assert c.source_kind == "mcp" and c.status == "done"
        assert any("via mcp" in e.actor for e in c.events)


def test_unknown_user_fails_at_start(seeded: None) -> None:
    with pytest.raises(ValueError, match="No active Keel user"):
        mcp_server.build("nobody@acme.example")
