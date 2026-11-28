"""GitHub: issues and comments carry a hidden op_id marker; reconcile by listing recent items."""

from __future__ import annotations

import datetime as dt
import time
import typing

import httpx
import joserfc.jwk
import joserfc.jwt

from keel import connections, errors, models
from keel.connectors import base

API_TIMEOUT_S = (
    20  # GitHub writes usually finish in <2s; 20s leaves room for slow Enterprise Server installs.
)
RECONCILE_LOOKBACK = dt.timedelta(minutes=5)  # Clock skew between us and GitHub, plus queueing delay.
RECONCILE_SETTLE = dt.timedelta(seconds=30)  # Listing endpoints can lag a few seconds behind writes.
LIST_PAGE_SIZE = 100  # GitHub's maximum per_page.
APP_JWT_TTL_S = 540  # GitHub allows at most 10 minutes; stay under it for clock skew.
USER_AGENT = "keel-steward"


class GitHubAuth:
    """Bearer token from a PAT, or a short-lived installation token from a GitHub App."""

    def __init__(
        self,
        token: str = "",
        app_id: str = "",
        private_key: str = "",
        installation_id: str = "",
        api_url: str = "https://api.github.com",
    ) -> None:
        self.token, self.app_id, self.private_key = token, app_id, private_key
        self.installation_id, self.api_url = installation_id, api_url.rstrip("/")
        self._cached: tuple[str, float] | None = None

    def bearer(self) -> str:
        """Return a token usable right now."""
        if self.token:
            return self.token
        if self._cached and self._cached[1] - time.time() > 60:
            return self._cached[0]
        now = int(time.time())
        key = joserfc.jwk.RSAKey.import_key(self.private_key)
        app_jwt = joserfc.jwt.encode(
            {"alg": "RS256"}, {"iat": now - 30, "exp": now + APP_JWT_TTL_S, "iss": self.app_id}, key
        )
        resp = httpx.post(
            f"{self.api_url}/app/installations/{self.installation_id}/access_tokens",
            headers={
                "Authorization": f"Bearer {app_jwt}",
                "Accept": "application/vnd.github+json",
                "User-Agent": USER_AGENT,
            },
            timeout=API_TIMEOUT_S,
        )
        if resp.status_code >= 400:
            raise errors.classify_http(
                "GitHub", resp.status_code, _message(resp), dict(resp.headers), write=False
            )
        data = resp.json()
        expires = dt.datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00")).timestamp()
        self._cached = (data["token"], expires)
        return data["token"]


def _message(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("message", ""))[:200]
    except ValueError:
        return resp.text[:200]


class GitHubConnector:
    """Creates issues and comments."""

    def __init__(self, auth: GitHubAuth, transport: httpx.BaseTransport | None = None) -> None:
        self.auth = auth
        self.client = httpx.Client(
            base_url=auth.api_url,
            timeout=API_TIMEOUT_S,
            transport=transport,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": USER_AGENT,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

    def _call(self, method: str, path: str, write: bool, **kwargs) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self.auth.bearer()}"}
        try:
            resp = self.client.request(method, path, headers=headers, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise errors.classify_transport("GitHub", exc, sent=False) from exc
        except httpx.TransportError as exc:
            raise errors.classify_transport("GitHub", exc, sent=True) from exc
        if resp.status_code >= 400:
            raise errors.classify_http(
                "GitHub", resp.status_code, _message(resp), dict(resp.headers), write=write
            )
        return resp

    def execute(self, op: models.Operation) -> base.ExecResult:
        """Create an issue or a comment with the op marker in its body."""
        p = op.payload
        body = f"{p.get('body', '')}\n\n{base.marker(op.op_id)}"
        if op.kind == "github.create_issue":
            resp = self._call(
                "POST",
                f"/repos/{p['repo']}/issues",
                True,
                json={"title": p["title"], "body": body, "labels": p.get("labels", [])},
            )
        elif op.kind == "github.comment":
            resp = self._call(
                "POST", f"/repos/{p['repo']}/issues/{p['number']}/comments", True, json={"body": body}
            )
        else:
            raise errors.ConnectorError(errors.BAD_REQUEST, f"GitHub can't do {op.kind}.", sent=False)
        return base.ExecResult(remote_ref=resp.json()["html_url"])

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        """List items created since the op started and look for the marker."""
        p = op.payload
        since = (op.created_at - RECONCILE_LOOKBACK).strftime("%Y-%m-%dT%H:%M:%SZ")
        mark = base.marker(op.op_id)
        try:
            if op.kind == "github.create_issue":
                resp = self._call(
                    "GET",
                    f"/repos/{p['repo']}/issues",
                    False,
                    params={
                        "state": "all",
                        "since": since,
                        "sort": "created",
                        "direction": "desc",
                        "per_page": LIST_PAGE_SIZE,
                    },
                )
            else:
                resp = self._call(
                    "GET",
                    f"/repos/{p['repo']}/issues/{p['number']}/comments",
                    False,
                    params={"since": since, "per_page": LIST_PAGE_SIZE},
                )
        except errors.ConnectorError as exc:
            return base.ReconcileResult(
                base.Found.UNSURE, line=f"Couldn't list GitHub items to check: {exc.line}"
            )
        items = resp.json()
        for item in items:
            if mark in (item.get("body") or ""):
                return base.ReconcileResult(base.Found.YES, remote_ref=item["html_url"])
        if len(items) >= LIST_PAGE_SIZE:
            return base.ReconcileResult(
                base.Found.UNSURE, line="Too many recent items to be sure; check by hand."
            )
        if models.utcnow() - op.updated_at < RECONCILE_SETTLE:
            return base.ReconcileResult(
                base.Found.UNSURE, line="Too soon to be sure; checking again shortly."
            )
        return base.ReconcileResult(base.Found.NO, line="No GitHub item carries this operation's marker.")


def test_credentials(auth: GitHubAuth) -> tuple[bool, str]:
    """Check GitHub access. Returns (ok, one plain line)."""
    try:
        token = auth.bearer()
        path = "/user" if auth.token else "/installation/repositories"
        resp = httpx.get(
            f"{auth.api_url}{path}",
            timeout=API_TIMEOUT_S,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": USER_AGENT,
                "Accept": "application/vnd.github+json",
            },
        )
    except errors.ConnectorError as exc:
        return False, exc.line
    except httpx.HTTPError as exc:
        return False, f"Couldn't reach GitHub ({type(exc).__name__})."
    if resp.status_code >= 400:
        return False, errors.classify_http(
            "GitHub", resp.status_code, _message(resp), dict(resp.headers), write=False
        ).line
    data = resp.json()
    if auth.token:
        return True, f"Connected as {data.get('login')}."
    return True, f"Connected. The app can see {data.get('total_count', 0)} repositories."


def auth_for_org(session: typing.Any, org_id: str) -> GitHubAuth | None:
    """The org's GitHub credentials, or None when GitHub isn't connected."""
    res = connections.resolve(session, org_id, "github")
    if not res.configured:
        return None
    return GitHubAuth(
        token=res.secrets.get("token", ""),
        app_id=res.config.get("app_id", ""),
        private_key=res.secrets.get("private_key", ""),
        installation_id=res.config.get("installation_id", ""),
        api_url=res.config.get("api_url") or "https://api.github.com",
    )
