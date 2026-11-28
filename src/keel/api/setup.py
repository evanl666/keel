"""First-run setup wizard: admin, model, Slack, GitHub, policy, first team."""

from __future__ import annotations

import typing

import fastapi
import pydantic
import sqlalchemy as sa
from sqlalchemy import orm

from keel import auth_utils, config, connections, feed, labels, levels, llm, models
from keel.api import deps, routes
from keel.connectors import github, slack

router = fastapi.APIRouter(prefix="/api/setup")
STEPS = ("admin", "model", "slack", "github", "policy", "team")
SLACK_BOT_SCOPES = (
    "app_mentions:read",
    "channels:history",
    "channels:read",
    "chat:write",
    "chat:write.customize",
    "commands",
    "groups:history",
    "groups:read",
    "im:history",
    "im:write",
    "metadata.message:read",
    "users:read",
    "users:read.email",
)


def org_of(s: orm.Session) -> models.Org | None:
    """The install's org (v0.1 runs one org per install)."""
    return s.scalar(sa.select(models.Org).order_by(models.Org.created_at))


def has_admin(s: orm.Session) -> bool:
    """True once an org admin exists."""
    return (
        s.scalar(sa.select(sa.func.count()).select_from(models.User).where(models.User.role == "org_admin"))
        > 0
    )


def setup_complete(s: orm.Session) -> bool:
    """An admin and at least one team. Model, Slack, GitHub and policy are optional."""
    return has_admin(s) and (s.scalar(sa.select(sa.func.count()).select_from(models.Team)) or 0) > 0


def guard(request: fastapi.Request, s: deps.Session) -> models.User | None:
    """Open until the admin exists; then org admins only."""
    if not has_admin(s):
        return None
    u = deps.current_user(request, s)
    if u is None:
        raise fastapi.HTTPException(401, "Sign in as an org admin to change setup.")
    if u.role != "org_admin":
        raise fastapi.HTTPException(403, "Only an org admin can change setup.")
    return u


Guard = typing.Annotated[models.User | None, fastapi.Depends(guard)]


def _need_org(s: orm.Session) -> models.Org:
    org = org_of(s)
    if org is None or not has_admin(s):
        raise fastapi.HTTPException(409, "Create the admin account first.")
    return org


@router.get("")
def get_setup(s: deps.Session, _u: Guard) -> dict:
    """Wizard state."""
    org = org_of(s)
    oid = org.id if org else ""

    def conn(kind: str) -> tuple[bool, str]:
        res = connections.resolve(s, oid, kind)
        if not res.configured:
            return False, ""
        row = s.scalar(
            sa.select(models.Connection).where(
                models.Connection.org_id == oid, models.Connection.kind == kind
            )
        )
        if row is not None and row.status == "error":
            return False, row.status_line
        provider = res.config.get("provider", "")
        if kind == "model" and provider not in llm.PROVIDERS:
            return False, f"Unknown model provider “{provider}”. Use one of: {', '.join(llm.PROVIDERS)}."
        how = "from environment" if res.source == "env" else "saved"
        return True, f"Connected ({how})."

    model_ok, model_line = conn("model")
    slack_ok, slack_line = conn("slack")
    gh_ok, gh_line = conn("github")
    n_teams = (
        s.scalar(sa.select(sa.func.count()).select_from(models.Team).where(models.Team.org_id == oid)) or 0
    )
    policy_set = bool(org and "default_level" in org.settings)
    steps = [
        {
            "id": "admin",
            "title": "Create the admin account",
            "done": has_admin(s),
            "optional": False,
            "detail": f"{org.name}"
            if org and has_admin(s)
            else "The first person in runs setup and approves levels.",
        },
        {
            "id": "model",
            "title": "Choose a model",
            "done": model_ok,
            "optional": True,
            "detail": model_line or "Optional. Without one, stewards use built-in rules.",
        },
        {
            "id": "slack",
            "title": "Connect Slack",
            "done": slack_ok,
            "optional": True,
            "detail": slack_line or "Socket Mode: no public URL needed.",
        },
        {
            "id": "github",
            "title": "Connect GitHub",
            "done": gh_ok,
            "optional": True,
            "detail": gh_line or "A token or a GitHub App, for issues and checkups.",
        },
        {
            "id": "policy",
            "title": "Set the starting level",
            "done": policy_set,
            "optional": True,
            "detail": (
                f"New stewards start at L{org.settings['default_level']} "
                f"{levels.level_def(int(org.settings['default_level'])).name}."
            )
            if policy_set
            else "Stewards start at L1 Draft: they draft, people approve.",
        },
        {
            "id": "team",
            "title": "Add your first team",
            "done": n_teams > 0,
            "optional": False,
            "detail": f"{n_teams} team{'s' if n_teams != 1 else ''}."
            if n_teams
            else "One team, one steward.",
        },
    ]
    return {
        "steps": steps,
        "slack_manifest_url": "/api/setup/slack-manifest",
        "needs_setup_code": needs_setup_code() and not has_admin(s),
    }


class AdminBody(pydantic.BaseModel):
    name: str
    email: str
    password: str
    org_name: str
    setup_code: str = ""


class ModelBody(pydantic.BaseModel):
    provider: str
    model: str = ""
    api_key: str = ""
    base_url: str = ""


class SlackBody(pydantic.BaseModel):
    bot_token: str = ""
    app_token: str = ""
    signing_secret: str = ""


class GitHubBody(pydantic.BaseModel):
    token: str = ""
    app_id: str = ""
    private_key: str = ""
    installation_id: str = ""
    api_url: str = ""


class PolicyBody(pydantic.BaseModel):
    default_level: int = 1
    label_default: str = "internal"


def needs_setup_code() -> bool:
    """Outside demo mode, creating the first admin takes the code from the server log, so a stranger who finds
    a fresh install first can't claim it."""
    return not config.get().demo


def _check_admin(b: AdminBody) -> None:
    if needs_setup_code() and not auth_utils.setup_code_ok(b.setup_code):
        raise ValueError(
            "That setup code doesn't match. It's in the server log at startup, or run `keel setup-code`."
        )
    if not b.name.strip() or not b.org_name.strip():
        raise ValueError("Fill in your name and the organization name.")
    if "@" not in b.email:
        raise ValueError("That email address doesn't look right.")
    auth_utils.check_new_password(b.password)


def _gh_auth(b: GitHubBody, s: orm.Session, org: models.Org | None) -> github.GitHubAuth:
    old = connections.resolve(s, org.id, "github").secrets if org else {}
    return github.GitHubAuth(
        token=b.token or ("" if b.app_id else old.get("token", "")),
        app_id=b.app_id,
        private_key=b.private_key or old.get("private_key", ""),
        installation_id=b.installation_id,
        api_url=b.api_url or config.get().github_api_url,
    )


def _test(step: str, body: dict, s: orm.Session) -> tuple[bool, str]:
    org = org_of(s)
    if step == "admin":
        _check_admin(AdminBody(**body))
        return True, "Looks good."
    if step == "model":
        b = ModelBody(**body)
        old = connections.resolve(s, org.id, "model").secrets if org else {}
        return llm.test(b.provider, b.model, b.api_key or old.get("api_key", ""), b.base_url)
    if step == "slack":
        b = SlackBody(**body)
        old = connections.resolve(s, org.id, "slack").secrets if org else {}
        bot = b.bot_token or old.get("bot_token", "")
        if not bot:
            return False, "Paste the bot token (xoxb-…)."
        return slack.test_credentials(bot, b.app_token or old.get("app_token", ""))
    if step == "github":
        b = GitHubBody(**body)
        auth = _gh_auth(b, s, org)
        if not auth.token and not (auth.app_id and auth.private_key and auth.installation_id):
            return False, "Paste a token, or the app ID, private key and installation ID."
        return github.test_credentials(auth)
    if step == "policy":
        b = PolicyBody(**body)
        levels.level_def(b.default_level)
        labels.rank(b.label_default)
        return True, f"New stewards start at L{b.default_level} {levels.level_def(b.default_level).name}."
    if step == "team":
        b = routes.NewTeam(**body)
        return (True, "Looks good.") if b.name.strip() else (False, "A team needs a name.")
    raise fastapi.HTTPException(404, f"There's no setup step called {step}.")


@router.post("/{step}/test")
def test_step(step: str, body: dict, s: deps.Session, _u: Guard) -> dict:
    """Check a step's input without saving."""
    try:
        ok, line = _test(step, body, s)
    except (ValueError, pydantic.ValidationError) as exc:
        ok, line = False, _one_line(exc)
    return {"ok": ok, "message": line}


def _one_line(exc: Exception) -> str:
    if isinstance(exc, pydantic.ValidationError):
        err = exc.errors()[0]
        return f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}"
    return str(exc)


@router.post("/{step}")
def save_step(
    step: str, body: dict, request: fastapi.Request, response: fastapi.Response, s: deps.Session, u: Guard
) -> dict:
    """Save a step. Connection steps are tested first and only saved when the test passes."""
    if step == "admin":
        if has_admin(s):
            raise fastapi.HTTPException(409, "The admin account already exists. Sign in instead.")
        b = AdminBody(**body)
        _check_admin(b)
        org = org_of(s) or models.Org(name=b.org_name.strip(), settings={})
        org.name = b.org_name.strip()
        s.add(org)
        s.flush()
        admin = models.User(
            org_id=org.id,
            email=b.email.strip().lower(),
            name=b.name.strip(),
            role="org_admin",
            password_hash=auth_utils.hash_password(b.password),
        )
        s.add(admin)
        s.flush()
        feed.audit(s, org.id, f"user:{admin.email}", "setup.admin", admin.email)
        deps.set_session_cookie(request, response, admin.id)
        admin.last_seen_at = models.utcnow()
        return {"ok": True, "message": f"Welcome, {admin.name}. You're the admin of {org.name}."}
    org = _need_org(s)
    actor = f"user:{u.email}" if u else "setup"
    if step in ("model", "slack", "github"):
        ok, line = _test(step, body, s)
        if not ok:
            return {"ok": False, "message": line}
        if step == "model":
            b = ModelBody(**body)
            connections.store(
                s,
                org.id,
                "model",
                {"provider": b.provider, "model": b.model, "base_url": b.base_url},
                {"api_key": b.api_key},
            )
        elif step == "slack":
            b = SlackBody(**body)
            connections.store(
                s,
                org.id,
                "slack",
                {},
                {"bot_token": b.bot_token, "app_token": b.app_token, "signing_secret": b.signing_secret},
            )
        else:
            b = GitHubBody(**body)
            connections.store(
                s,
                org.id,
                "github",
                {
                    "app_id": b.app_id,
                    "installation_id": b.installation_id,
                    "api_url": b.api_url or config.get().github_api_url,
                },
                {"token": b.token, "private_key": b.private_key},
            )
        feed.audit(s, org.id, actor, f"setup.{step}", step, line)
        return {"ok": True, "message": line}
    if step == "policy":
        b = PolicyBody(**body)
        levels.level_def(b.default_level)
        labels.rank(b.label_default)
        org.settings = {**org.settings, "default_level": b.default_level, "label_default": b.label_default}
        feed.audit(s, org.id, actor, "setup.policy", "org", f"default_level={b.default_level}")
        return {
            "ok": True,
            "message": f"New stewards start at L{b.default_level} {levels.level_def(b.default_level).name}.",
        }
    if step == "team":
        admin = u or s.scalar(
            sa.select(models.User).where(models.User.org_id == org.id, models.User.role == "org_admin")
        )
        team = routes.create_team(s, org, routes.NewTeam(**body), admin)
        st = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
        return {"ok": True, "message": f"{team.name} has a steward now: {st.emoji} {st.name}."}
    raise fastapi.HTTPException(404, f"There's no setup step called {step}.")


def slack_manifest(base_url: str, name: str = "Keel") -> str:
    """A Slack app manifest (YAML) for Socket Mode. Paste it at api.slack.com/apps → From a manifest."""
    scopes = "\n".join(f"      - {x}" for x in SLACK_BOT_SCOPES)
    return f"""display_information:
  name: {name}
  description: One AI steward per team. Keeps commitments, answers questions, watches services.
  background_color: "#1b1530"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: {name.lower()}
    always_online: true
  slash_commands:
    - command: /keel
      description: Ask your team's steward
      usage_hint: "help | status | ask <question> | teach <rule> | <a request>"
      should_escape: false
oauth_config:
  scopes:
    bot:
{scopes}
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
# Keel at {base_url}. Socket Mode needs an app-level token with the connections:write scope.
"""


@router.get("/slack-manifest")
def get_manifest() -> fastapi.Response:
    """Download the Slack app manifest."""
    return fastapi.Response(
        slack_manifest(config.get().base_url),
        media_type="application/x-yaml",
        headers={"Content-Disposition": 'attachment; filename="keel-slack-manifest.yaml"'},
    )
