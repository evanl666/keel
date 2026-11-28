"""The FastAPI app: API, auth, live stream, probes, runner and webhook endpoints, and the web UI."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import importlib.metadata
import json
import logging
import pathlib
import secrets
import typing

import fastapi
import prometheus_client
import pydantic
import sqlalchemy as sa
import starlette.exceptions
from fastapi import responses, staticfiles

from keel import (
    auth_utils,
    config,
    db,
    demo,
    errors,
    feed,
    gateway,
    github_poll,
    inbox,
    jobs,
    metrics,
    models,
    people,
    worker,
)
from keel.api import deps, routes, serial, setup
from keel.api import people as people_api

log = logging.getLogger(__name__)
WEB_DIST = pathlib.Path(__file__).resolve().parent.parent / "web_dist"
STREAM_POLL_S = 1.0  # How often the live feed checks for new activity; matches the worker's poll.
STREAM_HEARTBEAT_S = 15.0  # Below common proxy idle timeouts (30-60 s) so the connection stays open.
STREAM_BACKLOG = 50  # Items replayed to a client reconnecting without Last-Event-ID.
OIDC_STATE_COOKIE = "keel_oidc"


def version() -> str:
    """Installed package version."""
    try:
        return importlib.metadata.version("keel-steward")
    except importlib.metadata.PackageNotFoundError:
        return "0.2.0"


# ---------------------------------------------------------------- auth

auth = fastapi.APIRouter(prefix="/api")


def me_payload(s: sa.orm.Session, u: models.User | None) -> dict:
    """Me."""
    org = s.get(models.Org, u.org_id) if u else setup.org_of(s)
    return {
        "user": serial.user(u),
        "org": {"id": org.id, "name": org.name} if org else None,
        "demo": config.get().demo,
        "setup_complete": setup.setup_complete(s),
        "sso_enabled": config.get().sso_enabled,
        "version": version(),
    }


@auth.get("/me")
def me(s: deps.Session, u: deps.MaybeUser) -> dict:
    """Who is signed in, and whether setup is done."""
    return me_payload(s, u)


class Login(pydantic.BaseModel):
    email: str
    password: str


@auth.post("/auth/login")
def login(body: Login, request: fastapi.Request, response: fastapi.Response, s: deps.Session) -> dict:
    """Email and password sign-in. Repeated failures lock the email (and the IP) out for a while."""
    email, ip = body.email.strip().lower(), deps.client_ip(request)
    wait = auth_utils.login_wait_minutes(email, ip)
    if wait:
        raise fastapi.HTTPException(
            429, f"Too many tries. Wait {wait} minute{'s' if wait != 1 else ''} and try again."
        )
    u = s.scalar(sa.select(models.User).where(models.User.email == email))
    if u is None or u.disabled or not auth_utils.verify_password(body.password, u.password_hash):
        auth_utils.record_login_failure(email, ip)
        raise fastapi.HTTPException(401, "That email and password don't match.")
    auth_utils.clear_login_failures(email)
    deps.set_session_cookie(request, response, u.id)
    u.last_seen_at = models.utcnow()
    feed.audit(s, u.org_id, f"user:{u.email}", "auth.login", u.email)
    return me_payload(s, u)


@auth.post("/auth/logout")
def logout(response: fastapi.Response) -> dict:
    """Clear the session cookie."""
    response.delete_cookie(deps.COOKIE)
    return {"ok": True}


def _oidc_client() -> typing.Any:
    from authlib.integrations.httpx_client import OAuth2Client

    cfg = config.get()
    return OAuth2Client(
        cfg.oidc_client_id,
        cfg.oidc_client_secret,
        scope="openid email profile",
        redirect_uri=f"{cfg.base_url.rstrip('/')}/api/auth/sso/callback",
    )


def _oidc_meta() -> dict:
    import httpx

    issuer = config.get().oidc_issuer.rstrip("/")
    return httpx.get(f"{issuer}/.well-known/openid-configuration", timeout=10).json()


def verify_id_token(id_token: str, meta: dict, nonce: str) -> dict:
    """Check the ID token's signature (the IdP's JWKS), issuer, audience, expiry and our nonce."""
    import httpx
    import joserfc.errors
    import joserfc.jwk
    import joserfc.jwt

    if not id_token:
        raise fastapi.HTTPException(400, "The identity provider didn't send an ID token.")
    cfg = config.get()
    try:
        keys = joserfc.jwk.KeySet.import_key_set(httpx.get(meta["jwks_uri"], timeout=10).json())
        tok = joserfc.jwt.decode(id_token, keys)
        joserfc.jwt.JWTClaimsRegistry(
            iss={
                "essential": True,
                "values": [meta.get("issuer", cfg.oidc_issuer), cfg.oidc_issuer.rstrip("/")],
            },
            aud={"essential": True, "value": cfg.oidc_client_id},
            nonce={"essential": True, "value": nonce},
            exp={"essential": True},
        ).validate(tok.claims)
    except (joserfc.errors.JoseError, ValueError, KeyError, httpx.HTTPError) as exc:
        log.warning("OIDC id_token rejected: %s", exc)
        raise fastapi.HTTPException(400, "The sign-in couldn't be verified. Try again.") from exc
    return dict(tok.claims)


@auth.get("/auth/sso")
def sso_start() -> responses.RedirectResponse:
    """Redirect to the IdP."""
    if not config.get().sso_enabled:
        raise fastapi.HTTPException(
            404, "SSO isn't configured. Set KEEL_OIDC_ISSUER and KEEL_OIDC_CLIENT_ID."
        )
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    url, _ = _oidc_client().create_authorization_url(
        _oidc_meta()["authorization_endpoint"], state=state, nonce=nonce
    )
    resp = responses.RedirectResponse(url, 302)
    resp.set_cookie(OIDC_STATE_COOKIE, f"{state}.{nonce}", httponly=True, samesite="lax", max_age=600)
    return resp


@auth.get("/auth/sso/callback")
def sso_callback(
    request: fastapi.Request, s: deps.Session, code: str = "", state: str = ""
) -> responses.RedirectResponse:
    """Finish OIDC sign-in: verify state, exchange the code, read userinfo, create or link the user."""
    want_state, _, _nonce = (request.cookies.get(OIDC_STATE_COOKIE) or "").partition(".")
    if not code or not want_state or not hmac.compare_digest(state, want_state):
        raise fastapi.HTTPException(400, "The sign-in link expired. Try again.")
    cfg, meta = config.get(), _oidc_meta()
    client = _oidc_client()
    token = client.fetch_token(meta["token_endpoint"], code=code)
    claims = verify_id_token(token.get("id_token", ""), meta, _nonce)
    info = {**claims, **client.get(meta["userinfo_endpoint"]).json()}
    email = (info.get("email") or "").lower()
    if not email:
        raise fastapi.HTTPException(400, "The identity provider didn't share an email address.")
    org = setup.org_of(s)
    if org is None:
        raise fastapi.HTTPException(409, "Finish setup before signing in with SSO.")
    u = s.scalar(sa.select(models.User).where(models.User.email == email))
    groups = info.get(cfg.oidc_groups_claim) or []
    groups = [groups] if isinstance(groups, str) else [str(g) for g in groups]
    role = "org_admin" if cfg.oidc_admin_group and cfg.oidc_admin_group in groups else "member"
    if u is None:
        u = models.User(
            org_id=org.id,
            email=email,
            name=info.get("name") or email.split("@")[0],
            role=role,
            sso_subject=info.get("sub"),
            avatar_url=info.get("picture"),
        )
        s.add(u)
        s.flush()
        people.claim_invite_for(s, u)
    elif role == "org_admin" and u.role != "org_admin":
        u.role = role
    if u.disabled:
        raise fastapi.HTTPException(403, "This account is disabled.")
    u.sso_subject = u.sso_subject or info.get("sub")
    people.sync_sso_groups(s, u, groups)
    u.last_seen_at = models.utcnow()
    feed.audit(s, org.id, f"user:{email}", "auth.sso", email)
    resp = responses.RedirectResponse("/", 302)
    deps.set_session_cookie(request, resp, u.id)
    resp.delete_cookie(OIDC_STATE_COOKIE)
    return resp


# ---------------------------------------------------------------- live stream

stream = fastapi.APIRouter(prefix="/api")


@stream.get("/stream")
async def activity_stream(request: fastapi.Request, u: deps.User) -> responses.StreamingResponse:
    """Server-sent events: one ActivityItem per ``data:`` line. Honours Last-Event-ID on reconnect."""
    org_id = u.org_id
    last = request.headers.get("last-event-id")

    def fetch(after: int | None) -> list[dict]:
        with db.session() as s:
            q = sa.select(models.Activity).where(models.Activity.org_id == org_id)
            if after is None:
                rows = list(s.scalars(q.order_by(models.Activity.id.desc()).limit(STREAM_BACKLOG)))[::-1]
                return [
                    {"_id": a.id} for a in rows[-1:]
                ]  # Start after the newest; the UI already loaded history.
            rows = list(
                s.scalars(
                    q.where(models.Activity.id > after).order_by(models.Activity.id).limit(STREAM_BACKLOG)
                )
            )
            idx = serial.TeamIndex(s, org_id)
            return [{"_id": a.id, **serial.activity(a, idx)} for a in rows]

    async def gen() -> typing.AsyncIterator[str]:
        cursor: int | None = int(last) if last and last.isdigit() else None
        if cursor is None:
            head = await asyncio.to_thread(fetch, None)
            cursor = head[0]["_id"] if head else 0
        yield "retry: 3000\n\n"
        idle = 0.0
        while not await request.is_disconnected():
            items = await asyncio.to_thread(fetch, cursor)
            for it in items:
                cursor = it.pop("_id")
                yield f"id: {cursor}\ndata: {json.dumps(it, ensure_ascii=False)}\n\n"
            if items:
                idle = 0.0
            else:
                idle += STREAM_POLL_S
                if idle >= STREAM_HEARTBEAT_S:
                    idle = 0.0
                    yield ": ping\n\n"
            await asyncio.sleep(STREAM_POLL_S)

    return responses.StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- runner and webhooks

hooks = fastapi.APIRouter()


def _require_runner(authorization: str = fastapi.Header("")) -> None:
    token = config.get().runner_token
    if not token:
        raise fastapi.HTTPException(
            404, "No runner is configured. Set KEEL_RUNNER_TOKEN on the server and runner."
        )
    if not hmac.compare_digest(authorization.removeprefix("Bearer ").strip(), token):
        raise fastapi.HTTPException(401, "Wrong runner token.")


class RunnerNext(pydantic.BaseModel):
    runner: str = "runner"


@hooks.post("/api/runner/next", dependencies=[fastapi.Depends(_require_runner)])
def runner_next(body: RunnerNext, s: deps.Session) -> dict:
    """Give the runner its next approved runbook, or {op: null}."""
    op = gateway.runner_claim(s, body.runner[:60])
    if op is None:
        return {"op": None}
    return {
        "op": {
            "id": op.id,
            "op_id": op.op_id,
            "runbook": op.payload.get("runbook"),
            "command": op.payload.get("command"),
            "service": op.payload.get("service"),
            "summary": op.summary,
        }
    }


class RunnerReport(pydantic.BaseModel):
    id: str
    ok: bool
    output: str = ""


@hooks.post("/api/runner/report", dependencies=[fastapi.Depends(_require_runner)])
def runner_report(body: RunnerReport, s: deps.Session) -> dict:
    """The runner says how a run went."""
    op = s.get(models.Operation, body.id)
    if op is None:
        raise fastapi.HTTPException(404, "Unknown run.")
    gateway.runner_report(s, op, body.ok, body.output)
    return {"status": op.status}


@hooks.post("/hooks/github")
async def github_webhook(request: fastapi.Request) -> dict:
    """GitHub webhook → inbox. Verified with X-Hub-Signature-256 when a webhook secret is set."""
    raw = await request.body()
    secret = config.get().github_webhook_secret
    if not secret:
        raise fastapi.HTTPException(
            404, "GitHub webhooks are off. Set KEEL_GITHUB_WEBHOOK_SECRET to turn them on."
        )
    sig = request.headers.get("x-hub-signature-256", "")
    want = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, want):
        raise fastapi.HTTPException(401, "Bad signature.")
    event = request.headers.get("x-github-event", "")
    body = json.loads(raw or b"{}")
    ev = _github_event(event, body)
    if ev is None:
        return {"ok": True, "ignored": event}
    repo = (body.get("repository") or {}).get("full_name", "")
    with db.session() as s:
        team = inbox.team_for_repo(s, repo)
        org = setup.org_of(s)
        if org is None:
            return {"ok": True, "ignored": "no org"}
        github_poll.record(s, org.id, team, repo, ev)
    return {"ok": True}


def _github_event(event: str, body: dict) -> tuple[str, str, str, str | None, str | None] | None:
    """The same (id, kind, text, url, user) the poller makes, so a webhook and a poll never double up."""
    action = body.get("action")
    repo = (body.get("repository") or {}).get("full_name", "")
    if event == "issues" and action == "opened":
        i = body["issue"]
        return github_poll.event_from_issue({**i, "repository_url": f"/repos/{repo}"})
    if event == "issue_comment" and action == "created":
        return github_poll.event_from_comment(body["comment"])
    if event == "pull_request" and action in ("opened", "ready_for_review"):
        p = body["pull_request"]
        return github_poll.event_from_issue(
            {**p, "pull_request": {"url": p.get("url")}, "repository_url": f"/repos/{repo}"}
        )
    return None


# ---------------------------------------------------------------- probes

probes = fastapi.APIRouter()


@probes.get("/healthz")
def healthz() -> dict:
    """Liveness: the process is up."""
    return {"ok": True}


@probes.get("/readyz")
def readyz() -> responses.JSONResponse:
    """Readiness: database reachable and migrated."""
    if not db.ping():
        return responses.JSONResponse({"ok": False, "detail": "The database isn't reachable."}, 503)
    cur, head = db.current_revision(), db.head_revision()
    if cur != head:
        return responses.JSONResponse(
            {"ok": False, "detail": f"Database is at {cur}, code needs {head}. Run keel migrate."}, 503
        )
    with db.session() as s:
        depth = jobs.depth(s)
    return responses.JSONResponse({"ok": True, "queue_depth": depth})


@probes.get("/metrics")
def prometheus_metrics() -> fastapi.Response:
    """Prometheus metrics."""
    metrics.ensure_registered()
    return fastapi.Response(
        prometheus_client.generate_latest(), media_type=prometheus_client.CONTENT_TYPE_LATEST
    )


# ---------------------------------------------------------------- app


def _seed_demo() -> None:
    with db.session() as s:
        if s.scalar(sa.select(sa.func.count()).select_from(models.Org)) == 0:
            demo.seed(s)
            log.info("seeded demo org")
    worker.drain()


def _announce_setup_code() -> None:
    """Until someone creates the admin, print the code the setup page asks for (only the server's log has it)."""
    with db.session() as s:
        if setup.has_admin(s):
            return
    log.warning(
        "Keel isn't set up yet. Open %s/setup and enter the setup code: %s",
        config.get().base_url.rstrip("/"),
        auth_utils.setup_code(),
    )


@contextlib.asynccontextmanager
async def lifespan(_app: fastapi.FastAPI) -> typing.AsyncIterator[None]:
    """Migrate, seed the demo, start the worker and Slack."""
    cfg = config.get()
    if cfg.auto_migrate:
        await asyncio.to_thread(db.migrate)
    if cfg.demo:
        await asyncio.to_thread(_seed_demo)
    else:
        await asyncio.to_thread(_announce_setup_code)
    w = worker.Worker() if cfg.run_worker_in_process else None
    if w:
        w.start()
    from keel import slack_app

    bridge = await asyncio.to_thread(slack_app.start_for_install)
    try:
        yield
    finally:
        if bridge:
            bridge.stop()
        if w:
            await asyncio.to_thread(w.stop)


class SPAStatic(staticfiles.StaticFiles):
    """Serve the built UI; unknown paths fall back to index.html for client-side routes."""

    async def get_response(self, path: str, scope: typing.Any) -> typing.Any:
        try:
            return await super().get_response(path, scope)
        except starlette.exceptions.HTTPException as exc:
            # A missing file (a path with an extension, like an old hashed asset) stays a 404.
            if exc.status_code != 404 or "." in path.rsplit("/", 1)[-1]:
                raise
        return await super().get_response("index.html", scope)


def create_app() -> fastapi.FastAPI:
    """Build the app."""
    app = fastapi.FastAPI(
        title="Keel",
        version=version(),
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    @app.exception_handler(ValueError)
    async def value_error(_r: fastapi.Request, exc: ValueError) -> responses.JSONResponse:
        return responses.JSONResponse({"detail": str(exc)}, 400)

    @app.exception_handler(pydantic.ValidationError)
    async def validation_error(_r: fastapi.Request, exc: pydantic.ValidationError) -> responses.JSONResponse:
        return responses.JSONResponse({"detail": setup._one_line(exc)}, 422)

    @app.exception_handler(errors.Conflict)
    async def conflict(_r: fastapi.Request, exc: errors.Conflict) -> responses.JSONResponse:
        return responses.JSONResponse({"detail": str(exc)}, 409)

    @app.exception_handler(errors.Missing)
    async def not_found(_r: fastapi.Request, exc: errors.Missing) -> responses.JSONResponse:
        return responses.JSONResponse({"detail": str(exc)}, 404)

    for r in (auth, setup.router, people_api.router, routes.router, stream, hooks, probes):
        app.include_router(r)

    @app.api_route(
        "/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"], include_in_schema=False
    )
    def api_404(rest: str) -> None:
        raise fastapi.HTTPException(404, f"There's no API endpoint /api/{rest}.")

    if (WEB_DIST / "index.html").exists():
        app.mount("/", SPAStatic(directory=WEB_DIST, html=True), name="web")
    else:

        @app.get("/", include_in_schema=False)
        def no_ui() -> responses.HTMLResponse:
            return responses.HTMLResponse(
                "<h1>Keel API is running</h1><p>The web UI isn't built. "
                "Run <code>npm run build</code> in <code>web/</code>.</p><p><a href=/api/docs>API docs</a></p>"
            )

    return app
