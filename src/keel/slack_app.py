"""Slack over Socket Mode: no public URL needed. Every event is stored first, then handled by the worker."""

from __future__ import annotations

import functools
import logging
import re
import typing

import sqlalchemy as sa

from keel import connections, db, inbox, learning, ledger, models, slack_lookup, steward

log = logging.getLogger(__name__)
USER_CACHE_SIZE = 2048  # Display names for one org's active Slack users; small and saves a call per message.
HELP = (
    "*/keel* — your team's steward\n"
    "• `/keel` or `/keel status` — open work and what's at risk\n"
    "• `/keel ask <question>` — a private answer from the team's knowledge, with sources\n"
    "• `/keel teach <rule>` — a rule the steward follows from now on\n"
    "• `/keel <anything else>` — a request; the steward replies in the team channel and tags you"
)
NO_TEAM_COMMAND = (
    "I don't know which team this is for. Run it in a team's channel, or ask an admin to add you to a team "
    "in Keel → People (with the same email you use in Slack)."
)
NO_TEAM_DM = (
    "Hi! I can't tell which team you're on yet. Ask a Keel admin to add you to a team in Keel → People, "
    "using the same email as your Slack account. Then DM me again."
)


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
        self._explained: set[str] = set()

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
        channel, ts, user = event.get("channel", ""), event.get("ts", ""), event.get("user", "")
        is_dm = event.get("channel_type") == "im" or channel.startswith("D")
        with db.session() as s:
            team = inbox.team_for_channel(s, channel)
            if team is None and not is_dm:
                team = slack_lookup.team_for_new_channel(s, self.org_id, channel, self.app.client)
            if team is None and is_dm:
                team = self._team_for_user(s, user)
                if team is None:
                    self._explain_once(user)
                    return
            payload = {
                "text": event.get("text", ""),
                "user": user,
                "user_name": self._name(user),
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
        """The first team (oldest) of the Keel person behind this Slack user; links them by email once."""
        person = slack_lookup.person_for(s, self.org_id, slack_user, self.app.client)
        if person is None or person.disabled:
            return None
        return s.scalar(
            sa.select(models.Team)
            .join(models.TeamMember, models.TeamMember.team_id == models.Team.id)
            .where(models.TeamMember.user_id == person.id)
            .order_by(models.Team.created_at)
        )

    def _explain_once(self, slack_user: str) -> None:
        """A DM from someone Keel can't place: say why once per process instead of going quiet."""
        if not slack_user or slack_user in self._explained:
            return
        self._explained.add(slack_user)
        try:
            self.app.client.chat_postMessage(channel=slack_user, text=NO_TEAM_DM)
        except Exception:
            log.debug("couldn't explain to %s", slack_user, exc_info=True)

    def _on_mention(self, event: dict, **_: typing.Any) -> None:
        self._record(event, directed=True)

    def _on_message(self, event: dict, **_: typing.Any) -> None:
        self._record(event, directed=event.get("channel_type") == "im")

    def _on_command(
        self,
        ack: typing.Callable,
        command: dict,
        respond: typing.Callable | None = None,
        **_: typing.Any,
    ) -> None:
        text = (command.get("text") or "").strip()
        user_id, channel_id = command.get("user_id", ""), command.get("channel_id", "")
        if text.lower() in ("help", "?"):
            ack(HELP)
            return
        with db.session() as s:
            team = (
                inbox.team_for_channel(s, channel_id)
                or slack_lookup.team_for_new_channel(s, self.org_id, channel_id, self.app.client)
                or self._team_for_user(s, user_id)
            )
            if team is None:
                ack(NO_TEAM_COMMAND)
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
            if re.match(r"teach\b", text, re.IGNORECASE):
                rule = text[len("teach") :].strip(" :")
                if not rule:
                    ack("Tell me the rule, e.g. `/keel teach Reply in Chinese when asked in Chinese.`")
                    return
                learning.teach(s, team, rule, self._name(user_id))
                ack(f"{st.emoji} Got it. I'll follow that from now on: {rule}")
                return
            if re.match(r"ask\b", text, re.IGNORECASE):
                question = text[len("ask") :].strip(" :")
                if not question:
                    ack("Ask me something, e.g. `/keel ask how do we roll back a deploy?`")
                    return
                ack(f"{st.emoji} Looking…")
                reply = self._answer(s, team, st, question, user_id)
                if respond is not None:
                    respond(text=reply, response_type="ephemeral", replace_original=False)
                return
            ack(f"{st.emoji} On it. I'll reply in {steward.channel_label(team)} and tag you.")
            inbox.record(
                s,
                self.org_id,
                team.id,
                "slack",
                f"cmd:{command.get('trigger_id', '')}",
                "message",
                {
                    "text": text,
                    "user": user_id,
                    "user_name": command.get("user_name"),
                    "channel": channel_id,
                    "directed": True,
                },
            )

    def _answer(
        self, s: sa.orm.Session, team: models.Team, st: models.Steward, question: str, user_id: str
    ) -> str:
        """A private answer for ``/keel ask``, limited to what this person may see, with links to the sources."""
        from keel import knowledge, llm

        person = slack_lookup.person_for(s, self.org_id, user_id, self.app.client)
        found = knowledge.search(s, [team.id], question, steward.clearance_for(s, person, team))
        try:
            reply = learning.answer(
                s,
                team,
                llm.for_org(s, self.org_id),
                question,
                found,
                steward=st.name,
                asked_by=self._name(user_id),
            )
        except Exception as exc:
            log.warning("/keel ask failed: %s", exc)
            return f"{st.emoji} I couldn't answer just now ({type(exc).__name__}). Try again in a minute."
        text = f"{st.emoji} {reply.text}"
        if reply.gap is None:
            text += steward.source_footer(found.passages, team)
        if found.withheld:
            text += f"\n_{found.withheld} source{'s' if found.withheld != 1 else ''} held back for your access level._"
        return text

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
    with db.session() as s:
        slack_lookup.resolve_all(s)
    return bridge
