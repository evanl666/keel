"""Classify connector failures. The class decides whether a retry is safe.

Rule: a timeout, a dropped connection after sending, or a 5xx/gateway error on a write does NOT prove the
write didn't commit. Those are ``unknown_outcome`` and go to reconciliation, never a blind retry.
A 403 alone does not prove a credential expired; only a 401 (or a provider's explicit token error) does.
"""

from __future__ import annotations

import dataclasses

UNKNOWN_OUTCOME = "unknown_outcome"
AUTH_INVALID = "auth_invalid"
PERMISSION_DENIED = "permission_denied"
NOT_FOUND = "not_found"
RATE_LIMITED = "rate_limited"
BAD_REQUEST = "bad_request"
UNREACHABLE = "unreachable"  # Never reached the server: safe to retry.
BLOCKED = "blocked"  # Stopped by Keel's own output gate before anything was sent.

# Provider error codes that do mean the token itself is bad (Slack returns HTTP 200 with ok=false).
SLACK_AUTH_ERRORS = frozenset({"invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"})
SLACK_PERMISSION_ERRORS = frozenset({"missing_scope", "not_in_channel", "channel_not_found", "restricted_action",
                                     "is_archived", "cannot_dm_bot", "ekm_access_denied"})


@dataclasses.dataclass
class ConnectorError(Exception):
    """A failed call, already classified. ``line`` is one plain sentence for the UI."""

    error_class: str
    line: str
    retry_after_s: float | None = None
    sent: bool = True  # False when we know the request never left (DNS failure, refused before send).

    def __str__(self) -> str:
        return f"{self.error_class}: {self.line}"


def classify_http(service: str, status: int, body_message: str = "", headers: dict[str, str] | None = None,
                  write: bool = True) -> ConnectorError:
    """Map an HTTP failure to a :class:`ConnectorError` with a plain one-line reason."""
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    detail = f" ({status}: {body_message})" if body_message else f" ({status})"
    if status == 429 or (status == 403 and headers.get("x-ratelimit-remaining") == "0"):
        retry = headers.get("retry-after")
        return ConnectorError(RATE_LIMITED, f"{service} asked us to slow down{detail}. Keel will try again later.",
                              retry_after_s=float(retry) if retry and retry.isdigit() else 60.0, sent=False)
    if status == 401:
        return ConnectorError(AUTH_INVALID, f"{service} rejected the credential{detail}. Reconnect {service} in Settings.")
    if status == 403:
        return ConnectorError(PERMISSION_DENIED, f"{service} refused this action{detail}. The credential works but lacks access to this resource.")
    if status == 404:
        return ConnectorError(NOT_FOUND, f"{service} couldn't find the target{detail}, or the credential can't see it.")
    if status >= 500 or status in (408, 499):
        if write:
            return ConnectorError(UNKNOWN_OUTCOME, f"{service} returned {status} after the request was sent, so it may have gone through. Keel will check before retrying.")
        return ConnectorError(UNKNOWN_OUTCOME, f"{service} returned {status}.")
    return ConnectorError(BAD_REQUEST, f"{service} rejected the request{detail}.")


def classify_slack(error_code: str) -> ConnectorError:
    """Map a Slack ``ok: false`` error code. Slack answered, so nothing was posted."""
    if error_code in SLACK_AUTH_ERRORS:
        return ConnectorError(AUTH_INVALID, f"Slack says the token is no longer valid ({error_code}). Reconnect Slack in Settings.", sent=False)
    if error_code in SLACK_PERMISSION_ERRORS:
        return ConnectorError(PERMISSION_DENIED, f"Slack refused: {error_code.replace('_', ' ')}. Invite the bot or add the scope.", sent=False)
    if error_code == "ratelimited":
        return ConnectorError(RATE_LIMITED, "Slack asked us to slow down. Keel will try again later.", retry_after_s=30.0, sent=False)
    return ConnectorError(BAD_REQUEST, f"Slack rejected the request ({error_code}).", sent=False)


def classify_transport(service: str, exc: BaseException, sent: bool) -> ConnectorError:
    """Map a network exception. ``sent`` says whether the request may have reached the server."""
    if not sent:
        return ConnectorError(UNREACHABLE, f"Couldn't reach {service} ({type(exc).__name__}). Nothing was sent; Keel will try again.",
                              retry_after_s=30.0, sent=False)
    return ConnectorError(UNKNOWN_OUTCOME, f"Lost the connection to {service} after sending ({type(exc).__name__}), so it may have gone through. Keel will check before retrying.")
