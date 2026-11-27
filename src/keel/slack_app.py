"""Slack over Socket Mode: no public URL needed. Every event is stored first, then handled by the worker."""

from __future__ import annotations

import functools
import logging
import typing

import sqlalchemy as sa

from keel import connections, db, inbox, ledger, models

log = logging.getLogger(__name__)
USER_CACHE_SIZE = 2048  # Display names for one org's active Slack users; small and saves a call per message.


class SlackBridge:
    """Socket Mode listener for one org. ``start()`` returns at once; Bolt runs its own threads."""

    def __init__(self, org_id: str, bot_token: str, app_token: str) -> None:
        import slack_bolt
        from slack_bolt.adapter.socket_mode import SocketModeHandler

        self.org_id = org_id
        self.app = slack_bolt.App(token=bot_token, token_verification_enabled=False)
        self.handler = SocketModeHandler(self.app, app_token)
        self.app.event("app_mention")(self._on_mention)
        self.app.event("message")(self._on_message)
        self.app.command("/keel")(self._on_command)

    @functools.lru_cache(maxsize=USER_CACHE_SIZE)  # noqa: B019 - one bridge per process
    def _name(self, user_id: str) -> str:
        try:
            u = self.app.client.users_info(user=user_id)["user"]
            return u.get("profile", {}).get("display_name") or u.get("real_name") or user_id
        except Exception:
            return user_id

    def _record(self, event: dict[str, typing.Any], directed: bool) -> None:
        if event.get("bot_id") or event.get("subtype") not in (None, "thread_broadcast", "file_share"):
            return
        channel, ts = event.get("channel", ""), event.get("ts", "")
        with db.session() as s:
            team = inbox.team_for_channel(s, channel)
            if team is None and event.get("channel_type") == "im":
                team = self._team_for_user(s, event.get("user", ""))
            payload = {
                "text": event.get("text", ""),
                "user": event.get("user"),
                "user_name": self._name(event.get("user", "")),
                "channel": channel,
                "ts": ts,
                "thread_ts": event.get("thread_ts") or ts,
                "directed": directed,
            }
            # Mentions arrive twice (app_mention + message); both share channel+ts, so the second is a no-op.
            inbox.record(
                s, self.org_id, team.id if team else None, "slack", f"{channel}:{ts}", "message", payload
            )

    def _team_for_user(self, s: sa.orm.Session, slack_user: str) -> models.Team | None:
        return s.scalar(
            sa.select(models.Team)
            .join(models.TeamMember, models.TeamMember.team_id == models.Team.id)
            .join(models.User, models.User.id == models.TeamMember.user_id)
            .where(models.User.slack_user_id == slack_user)
        )

    def _on_mention(self, event: dict, **_: typing.Any) -> None:
        self._record(event, directed=True)

    def _on_message(self, event: dict, **_: typing.Any) -> None:
        self._record(event, directed=event.get("channel_type") == "im")

    def _on_command(self, ack: typing.Callable, command: dict, **_: typing.Any) -> None:
        text = (command.get("text") or "").strip()
        with db.session() as s:
            team = inbox.team_for_channel(s, command.get("channel_id", "")) or self._team_for_user(
                s, command.get("user_id", "")
            )
            if team is None:
                ack("This channel has no steward yet. An admin can add it in Keel → Teams.")
                return
            st = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
            if text in ("", "status"):
                rows = ledger.open_for_team(s, team.id)
                risky = [c for c in rows if ledger.risk(c) in ("at_risk", "overdue")]
                lines = [
                    f"{st.emoji} *{st.name}* · {team.name} · L{st.level}",
                    f"{len(rows)} open, {len(risky)} at risk or overdue.",
                ]
                lines += [f"• {c.key} {c.title} ({ledger.risk(c).replace('_', ' ')})" for c in risky[:5]]
                ack("\n".join(lines))
                return
            ack(f"{st.emoji} On it.")
            inbox.record(
                s,
                self.org_id,
                team.id,
                "slack",
                f"cmd:{command.get('trigger_id', '')}",
                "message",
                {
                    "text": text,
                    "user": command.get("user_id"),
                    "user_name": command.get("user_name"),
                    "channel": command.get("channel_id"),
                    "directed": True,
                },
            )

    def start(self) -> None:
        """Connect (non-blocking)."""
        self.handler.connect()
        log.info("slack socket mode connected for org %s", self.org_id)

    def stop(self) -> None:
        """Disconnect."""
        try:
            self.handler.close()
        except Exception:
            log.debug("slack close failed", exc_info=True)


def start_for_install() -> SlackBridge | None:
    """Start Socket Mode when Slack is connected and the org isn't a demo. Returns None otherwise."""
    with db.session() as s:
        org = s.scalar(sa.select(models.Org).order_by(models.Org.created_at))
        if org is None or org.settings.get("demo"):
            return None
        res = connections.resolve(s, org.id, "slack")
        bot, app_token = res.secrets.get("bot_token"), res.secrets.get("app_token")
        org_id = org.id
    if not (bot and app_token):
        return None
    bridge = SlackBridge(org_id, bot, app_token)
    try:
        bridge.start()
    except Exception as exc:
        with db.session() as s:
            connections.mark(
                s, org_id, "slack", "error", f"Socket Mode couldn't connect ({type(exc).__name__})."
            )
        log.warning("slack socket mode failed: %s", exc)
        return None
    return bridge
