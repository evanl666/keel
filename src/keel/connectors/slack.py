"""Slack: post with the op_id in message metadata, reconcile by reading channel history."""

from __future__ import annotations

import datetime as dt
import socket
import urllib.error

from slack_sdk import errors as slack_errors
from slack_sdk import web

from keel import errors, models
from keel.connectors import base

METADATA_EVENT_TYPE = "keel_op"
RECONCILE_LOOKBACK = dt.timedelta(minutes=2)  # Slack ts can be a little earlier than our row's created_at.
RECONCILE_SETTLE = dt.timedelta(seconds=30)  # Before this, a missing message may just not be listed yet.
HISTORY_PAGE_LIMIT = 200  # Max Slack allows per page for conversations.history.


class SlackConnector:
    """Writes to Slack with a bot token."""

    def __init__(self, bot_token: str, client: web.WebClient | None = None) -> None:
        self.client = client or web.WebClient(token=bot_token)

    def execute(self, op: models.Operation) -> base.ExecResult:
        """Post a message. Returns the permalink-ish ref ``channel/ts``."""
        p = op.payload
        try:
            resp = self.client.chat_postMessage(
                channel=p["channel"],
                text=p["text"],
                thread_ts=p.get("thread_ts"),
                metadata={"event_type": METADATA_EVENT_TYPE, "event_payload": {"op_id": op.op_id}},
                unfurl_links=False,
            )
        except slack_errors.SlackApiError as exc:
            status = getattr(exc.response, "status_code", 200)
            if status and status >= 500:
                raise errors.classify_http("Slack", status) from exc
            raise errors.classify_slack(exc.response.get("error", "unknown_error")) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            reason = getattr(exc, "reason", exc)
            sent = not isinstance(reason, (ConnectionRefusedError, socket.gaierror))
            raise errors.classify_transport("Slack", exc, sent=sent) from exc
        return base.ExecResult(remote_ref=f"{resp['channel']}/{resp['ts']}")

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        """Look for our op_id in recent channel (or thread) history."""
        p = op.payload
        oldest = (op.created_at - RECONCILE_LOOKBACK).timestamp()
        try:
            if p.get("thread_ts"):
                resp = self.client.conversations_replies(
                    channel=p["channel"],
                    ts=p["thread_ts"],
                    oldest=str(oldest),
                    include_all_metadata=True,
                    limit=HISTORY_PAGE_LIMIT,
                )
            else:
                resp = self.client.conversations_history(
                    channel=p["channel"],
                    oldest=str(oldest),
                    include_all_metadata=True,
                    limit=HISTORY_PAGE_LIMIT,
                )
        except (slack_errors.SlackApiError, urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            return base.ReconcileResult(
                base.Found.UNSURE, line=f"Couldn't read Slack history to check ({type(exc).__name__})."
            )
        for msg in resp.get("messages", []):
            meta = msg.get("metadata") or {}
            if (
                meta.get("event_type") == METADATA_EVENT_TYPE
                and meta.get("event_payload", {}).get("op_id") == op.op_id
            ):
                return base.ReconcileResult(base.Found.YES, remote_ref=f"{p['channel']}/{msg['ts']}")
        if resp.get("has_more"):
            return base.ReconcileResult(
                base.Found.UNSURE, line="Too much channel history to be sure; check by hand."
            )
        if models.utcnow() - op.updated_at < RECONCILE_SETTLE:
            return base.ReconcileResult(
                base.Found.UNSURE, line="Too soon to be sure; checking again shortly."
            )
        return base.ReconcileResult(base.Found.NO, line="The message is not in the channel.")


def test_credentials(bot_token: str, app_token: str = "") -> tuple[bool, str]:
    """Check a bot token (and app token when given). Returns (ok, one plain line)."""
    client = web.WebClient(token=bot_token)
    try:
        auth = client.auth_test()
    except slack_errors.SlackApiError as exc:
        code = exc.response.get("error", "unknown_error")
        if code in errors.SLACK_AUTH_ERRORS:
            return False, (
                f"Slack didn't accept that bot token ({code}). Copy the xoxb- token from "
                "OAuth & Permissions after installing the app to your workspace."
            )
        return False, errors.classify_slack(code).line
    except Exception as exc:
        return False, f"Couldn't reach Slack ({type(exc).__name__})."
    if app_token and not app_token.startswith("xapp-"):
        return (
            False,
            "The app-level token should start with xapp-. Create one under Basic Information → App-Level Tokens.",
        )
    return True, f"Connected to {auth.get('team')} as @{auth.get('user')}."
