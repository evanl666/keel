"""GitHub without a webhook: poll each team's repos for new issues, pull requests and comments.

Webhooks are faster, but they need a public URL. Polling needs only the token you already gave Keel. Both feed
the same inbox with the same stable ids, so running both never handles one thing twice.
"""

from __future__ import annotations

import datetime as dt
import logging
import typing

import httpx
import sqlalchemy as sa
from sqlalchemy import orm

from keel import config, connections, errors, inbox, models
from keel.connectors import base, github

log = logging.getLogger(__name__)
POLL_INTERVAL = dt.timedelta(
    minutes=2
)  # Feels live for issues; ~60 calls/hour/repo, far under GitHub's 5000.
PAGE = 100  # GitHub's maximum per_page.


def enabled(s: orm.Session, org_id: str) -> bool:
    """Poll when GitHub is connected, unless webhooks are on and polling wasn't asked for."""
    mode = config.get().github_poll
    if mode == "off" or not connections.resolve(s, org_id, "github").configured:
        return False
    return mode == "on" or not config.get().github_webhook_secret


def event_from_issue(item: dict[str, typing.Any]) -> tuple[str, str, str, str | None, str | None]:
    """(external id, kind, text, url, user) for an issue or pull request as GitHub lists it."""
    repo = item.get("repository_url", "").split("/repos/", 1)[-1]
    if item.get("pull_request"):
        return (
            f"pr:{repo}#{item['number']}",
            "pull_request",
            f"Review request: {item['title']}",
            item.get("html_url"),
            (item.get("user") or {}).get("login"),
        )
    return (
        f"issue:{repo}#{item['number']}",
        "issues",
        f"{item['title']}\n\n{item.get('body') or ''}",
        item.get("html_url"),
        (item.get("user") or {}).get("login"),
    )


def event_from_comment(c: dict[str, typing.Any]) -> tuple[str, str, str, str | None, str | None]:
    """(external id, kind, text, url, user) for an issue or PR comment."""
    return (
        f"comment:{c['id']}",
        "issue_comment",
        c.get("body") or "",
        c.get("html_url"),
        (c.get("user") or {}).get("login"),
    )


def is_ours(text: str) -> bool:
    """True for content Keel itself posted (it carries the operation marker)."""
    return base.OP_MARKER in text


def record(
    s: orm.Session,
    org_id: str,
    team: models.Team | None,
    repo: str,
    ev: tuple[str, str, str, str | None, str | None],
) -> bool:
    """Store one GitHub event in the inbox. False when it's ours or already there."""
    ext, kind, text, url, user = ev
    if not text.strip() or is_ours(text):
        return False
    return (
        inbox.record(
            s,
            org_id,
            team.id if team else None,
            "github",
            ext,
            kind,
            {
                "text": text,
                "user_name": user,
                "permalink": url,
                "repo": repo,
                "directed": "@keel" in text.lower(),
            },
        )
        is not None
    )


def _iso(t: dt.datetime) -> str:
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(t: str) -> dt.datetime:
    return dt.datetime.fromisoformat(t.replace("Z", "+00:00"))


def poll_repo(
    s: orm.Session, org_id: str, team: models.Team, repo: str, transport: httpx.BaseTransport | None = None
) -> int:
    """Read what's new in one repo since the last poll. The first poll only sets the starting point."""
    key = f"github:{repo.lower()}"
    cur = s.get(models.SyncCursor, key)
    now = models.utcnow()
    if cur is None:
        s.add(models.SyncCursor(key=key, value=_iso(now)))
        s.flush()
        return 0
    since = _parse(cur.value)
    auth = github.auth_for_org(s, org_id)
    if auth is None:
        return 0
    conn = github.GitHubConnector(auth, transport=transport)
    got = 0
    newest = since
    try:
        issues = conn._call(
            "GET",
            f"/repos/{repo}/issues",
            False,
            params={
                "state": "all",
                "since": cur.value,
                "sort": "created",
                "direction": "asc",
                "per_page": PAGE,
            },
        ).json()
        comments = conn._call(
            "GET",
            f"/repos/{repo}/issues/comments",
            False,
            params={"since": cur.value, "sort": "created", "direction": "asc", "per_page": PAGE},
        ).json()
    except errors.ConnectorError as exc:
        log.warning("github poll %s: %s", repo, exc.line)
        return 0
    for item in issues:
        created = _parse(item["created_at"])
        if created <= since:
            continue  # Updated since, but not new: a webhook would have said "edited".
        got += record(s, org_id, team, repo, event_from_issue(item))
        newest = max(newest, created)
    for c in comments:
        created = _parse(c["created_at"])
        if created <= since:
            continue
        got += record(s, org_id, team, repo, event_from_comment(c))
        newest = max(newest, created)
    cur.value = _iso(newest)
    s.flush()
    return got


def poll_all(transport: httpx.BaseTransport | None = None) -> int:
    """Poll every team's repos once. Returns how many new events were stored."""
    from keel import db

    total = 0
    with db.session() as s:
        for org in s.scalars(sa.select(models.Org)):
            if org.settings.get("demo") or not enabled(s, org.id):
                continue
            for team in s.scalars(sa.select(models.Team).where(models.Team.org_id == org.id)):
                for repo in team.github_repos or []:
                    total += poll_repo(s, org.id, team, repo, transport)
    return total
