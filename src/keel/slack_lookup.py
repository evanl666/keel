"""Turn what people type (``#payments``) into what Slack sends (``C0123ABCD``), and Slack users into Keel people.

Teams are set up with channel names; Slack events carry channel ids. Without this, a team whose channel was
entered as ``#payments`` never hears anything. Lookups run when a team is created or edited, every few hours
on the worker, and lazily the first time an event arrives from a channel no team has claimed yet.
"""

from __future__ import annotations

import logging
import re

import sqlalchemy as sa
from slack_sdk import errors as slack_errors
from slack_sdk import web
from sqlalchemy import orm

from keel import connections, feed, models, people

log = logging.getLogger(__name__)
CHANNEL_ID = re.compile(r"[CG][A-Z0-9]{6,}")
LIST_PAGE = 1000  # conversations.list maximum page size.
MAX_PAGES = 20  # 20k channels; past that, enter the channel id instead of its name.


def client_for(s: orm.Session, org_id: str) -> web.WebClient | None:
    """A Web API client with the org's bot token, or None when Slack isn't connected or it's a demo."""
    org = s.get(models.Org, org_id)
    if org is None or org.settings.get("demo"):
        return None
    token = connections.resolve(s, org_id, "slack").secrets.get("bot_token")
    return web.WebClient(token=token) if token else None


def set_channel(team: models.Team, channel: str | None) -> None:
    """Store what was typed: an id goes straight in; a name waits to be looked up."""
    channel = (channel or "").strip()
    team.slack_channel_id, team.slack_channel_name = None, None
    if not channel:
        return
    if CHANNEL_ID.fullmatch(channel):
        team.slack_channel_id = channel
    else:
        team.slack_channel_name = channel if channel.startswith("#") else f"#{channel}"


def _channels(client: web.WebClient) -> dict[str, str]:
    """name → id for every channel the bot can see (public, and private ones it was invited to)."""
    out: dict[str, str] = {}
    cursor = None
    for _ in range(MAX_PAGES):
        resp = client.conversations_list(
            types="public_channel,private_channel", exclude_archived=True, limit=LIST_PAGE, cursor=cursor
        )
        for ch in resp.get("channels", []):
            out[ch["name"].lower()] = ch["id"]
        cursor = (resp.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    return out


def resolve_team(s: orm.Session, team: models.Team, client: web.WebClient | None = None) -> bool:
    """Fill in the channel id from its name (and the name from an id). True when the team has an id now."""
    client = client or client_for(s, team.org_id)
    if client is None:
        return bool(team.slack_channel_id)
    try:
        if team.slack_channel_id and not team.slack_channel_name:
            info = client.conversations_info(channel=team.slack_channel_id)["channel"]
            team.slack_channel_name = f"#{info['name']}"
            team.slack_member_count = info.get("num_members") or team.slack_member_count
        elif team.slack_channel_name and not team.slack_channel_id:
            found = _channels(client).get(team.slack_channel_name.lstrip("#").lower())
            if found:
                team.slack_channel_id = found
                feed.audit(
                    s, team.org_id, "keel", "slack.channel_found", team.slack_channel_name, found, team.id
                )
    except slack_errors.SlackApiError as exc:
        log.info("slack lookup for %s: %s", team.slug, exc.response.get("error"))
    except Exception:
        log.warning("slack lookup for %s failed", team.slug, exc_info=True)
    s.flush()
    return bool(team.slack_channel_id)


def resolve_all(s: orm.Session) -> int:
    """Look up every team still waiting for its channel id. Returns how many were found."""
    found = 0
    for org in s.scalars(sa.select(models.Org)):
        client = client_for(s, org.id)
        if client is None:
            continue
        waiting = s.scalars(
            sa.select(models.Team).where(
                models.Team.org_id == org.id,
                models.Team.slack_channel_id.is_(None),
                models.Team.slack_channel_name.is_not(None),
            )
        ).all()
        if not waiting:
            continue
        try:
            names = _channels(client)
        except Exception:
            log.warning("slack channel list failed", exc_info=True)
            continue
        for team in waiting:
            cid = names.get((team.slack_channel_name or "").lstrip("#").lower())
            if cid:
                team.slack_channel_id = cid
                found += 1
                feed.audit(
                    s, org.id, "keel", "slack.channel_found", team.slack_channel_name or "", cid, team.id
                )
    s.flush()
    return found


def team_for_new_channel(
    s: orm.Session, org_id: str, channel_id: str, client: web.WebClient | None
) -> models.Team | None:
    """An event came from a channel no team has by id: if a team named it, bind it now."""
    if client is None or not CHANNEL_ID.fullmatch(channel_id):
        return None
    waiting = s.scalars(
        sa.select(models.Team).where(
            models.Team.org_id == org_id,
            models.Team.slack_channel_id.is_(None),
            models.Team.slack_channel_name.is_not(None),
        )
    ).all()
    if not waiting:
        return None
    try:
        name = "#" + client.conversations_info(channel=channel_id)["channel"]["name"].lower()
    except Exception:
        log.debug("conversations.info %s failed", channel_id, exc_info=True)
        return None
    for team in waiting:
        if (team.slack_channel_name or "").lower() == name:
            team.slack_channel_id = channel_id
            feed.audit(s, org_id, "keel", "slack.channel_found", name, channel_id, team.id)
            s.flush()
            return team
    return None


def person_for(
    s: orm.Session, org_id: str, slack_user_id: str, client: web.WebClient | None
) -> models.User | None:
    """The Keel person behind a Slack user: by a stored link, else by matching their Slack email once."""
    if not slack_user_id:
        return None
    known = people.link_slack_user(s, org_id, slack_user_id, None)
    if known is not None or client is None:
        return known
    try:
        email = client.users_info(user=slack_user_id)["user"].get("profile", {}).get("email")
    except Exception:
        log.debug("users.info %s failed", slack_user_id, exc_info=True)
        return None
    return people.link_slack_user(s, org_id, slack_user_id, email)
