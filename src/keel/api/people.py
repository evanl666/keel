"""People and invites (org admins), team members, and the public invite-accept page."""

from __future__ import annotations

import typing

import fastapi
import pydantic
import sqlalchemy as sa

from keel import config, models, people
from keel.api import deps, serial

router = fastapi.APIRouter(prefix="/api")


def _person_or_404(s: deps.Session, u: models.User, person_id: str) -> models.User:
    p = s.get(models.User, person_id)
    if p is None or p.org_id != u.org_id:
        raise fastapi.HTTPException(404, "That person doesn't exist.")
    return p


@router.get("/people")
def list_people(s: deps.Session, u: deps.Admin) -> list[dict]:
    """Everyone in the org, with their teams."""
    rows = s.scalars(sa.select(models.User).where(models.User.org_id == u.org_id).order_by(models.User.name))
    return [serial.person(s, p) for p in rows]


class PersonPatch(pydantic.BaseModel):
    role: typing.Literal["org_admin", "member"] | None = None
    disabled: bool | None = None


@router.patch("/people/{person_id}")
def patch_person(person_id: str, body: PersonPatch, s: deps.Session, u: deps.Admin) -> dict:
    """Change someone's org role, or disable / enable them."""
    p = _person_or_404(s, u, person_id)
    people.update_person(s, p, u, body.role, body.disabled)
    return serial.person(s, p)


@router.delete("/people/{person_id}")
def delete_person(person_id: str, s: deps.Session, u: deps.Admin) -> dict:
    """Remove someone's account."""
    p = _person_or_404(s, u, person_id)
    name = p.name
    people.remove_person(s, p, u)
    return {"ok": True, "message": f"Removed {name}."}


@router.get("/invites")
def list_invites(s: deps.Session, u: deps.Admin) -> list[dict]:
    """Invites, newest first."""
    rows = s.scalars(
        sa.select(models.Invite)
        .where(models.Invite.org_id == u.org_id)
        .order_by(models.Invite.created_at.desc())
        .limit(200)
    )
    return [serial.invite(s, i) for i in rows]


class InviteTeam(pydantic.BaseModel):
    slug: str
    role: typing.Literal["admin", "member"] = "member"


class NewInvite(pydantic.BaseModel):
    email: str
    role: typing.Literal["org_admin", "member"] = "member"
    teams: list[InviteTeam] = []


def invite_url(token: str) -> str:
    """The link someone opens to join."""
    return f"{config.get().base_url.rstrip('/')}/invite/{token}"


@router.post("/invites")
def post_invite(body: NewInvite, s: deps.Session, u: deps.Admin) -> dict:
    """Invite someone. The link is returned once; only its hash is stored."""
    org = s.get(models.Org, u.org_id)
    inv, token = people.create_invite(s, org, body.email, body.role, [t.model_dump() for t in body.teams], u)
    return {"invite": serial.invite(s, inv), "url": invite_url(token)}


@router.delete("/invites/{invite_id}")
def delete_invite(invite_id: str, s: deps.Session, u: deps.Admin) -> dict:
    """Withdraw an invite."""
    inv = s.get(models.Invite, invite_id)
    if inv is None or inv.org_id != u.org_id:
        raise fastapi.HTTPException(404, "That invite doesn't exist.")
    if inv.accepted_at is None and inv.revoked_at is None:
        inv.revoked_at = models.utcnow()
    return {"ok": True, "message": f"Withdrew the invite for {inv.email}."}


@router.get("/invite/{token}")
def get_invite(token: str, s: deps.Session) -> dict:
    """What an invite link is for (public)."""
    inv = people.invite_by_token(s, token)
    if inv is None:
        raise fastapi.HTTPException(404, "This invite link isn't valid. Ask for a new one.")
    org = s.get(models.Org, inv.org_id)
    teams = [
        t.name
        for t in s.scalars(
            sa.select(models.Team).where(
                models.Team.org_id == inv.org_id, models.Team.slug.in_([x["slug"] for x in inv.teams])
            )
        )
    ]
    return {
        "email": inv.email,
        "org": org.name if org else "",
        "invited_by": inv.invited_by,
        "teams": teams,
        "status": people.invite_status(inv),
        "sso_enabled": config.get().sso_enabled,
    }


class Accept(pydantic.BaseModel):
    name: str
    password: str


@router.post("/invite/{token}")
def accept_invite(
    token: str, body: Accept, request: fastapi.Request, response: fastapi.Response, s: deps.Session
) -> dict:
    """Create the account and sign in."""
    inv = people.invite_by_token(s, token)
    if inv is None:
        raise fastapi.HTTPException(404, "This invite link isn't valid. Ask for a new one.")
    user = people.accept_invite(s, inv, body.name, body.password)
    deps.set_session_cookie(request, response, user.id)
    user.last_seen_at = models.utcnow()
    org = s.get(models.Org, user.org_id)
    return {"ok": True, "message": f"Welcome to {org.name if org else 'Keel'}, {user.name}."}


# ---------------------------------------------------------------- team members


@router.get("/teams/{slug}/members")
def list_members(slug: str, s: deps.Session, u: deps.User) -> list[dict]:
    """Who is on the team."""
    team = deps.team_or_404(s, u, slug)
    rows = s.execute(
        sa.select(models.User, models.TeamMember)
        .join(models.TeamMember, models.TeamMember.user_id == models.User.id)
        .where(models.TeamMember.team_id == team.id)
        .order_by(models.User.name)
    )
    return [serial.member(p, m) for p, m in rows]


class NewMember(pydantic.BaseModel):
    email: str
    role: typing.Literal["admin", "member"] = "member"


@router.post("/teams/{slug}/members")
def post_member(slug: str, body: NewMember, s: deps.Session, u: deps.User) -> dict:
    """Add someone already in the org to the team."""
    team = deps.team_or_404(s, u, slug)
    deps.require_team_admin(s, u, team.id, "add members")
    p = s.scalar(
        sa.select(models.User).where(
            models.User.org_id == u.org_id, models.User.email == people.norm_email(body.email)
        )
    )
    if p is None:
        raise fastapi.HTTPException(404, "No one with that email yet. Invite them first.")
    m = people.set_member(s, team, p, body.role, actor=f"user:{u.email}")
    return serial.member(p, m)


class MemberPatch(pydantic.BaseModel):
    role: typing.Literal["admin", "member"]


@router.patch("/teams/{slug}/members/{user_id}")
def patch_member(slug: str, user_id: str, body: MemberPatch, s: deps.Session, u: deps.User) -> dict:
    """Change someone's team role."""
    team = deps.team_or_404(s, u, slug)
    deps.require_team_admin(s, u, team.id, "change roles")
    p = _person_or_404(s, u, user_id)
    if s.get(models.TeamMember, {"team_id": team.id, "user_id": p.id}) is None:
        raise fastapi.HTTPException(404, f"{p.name} isn't on {team.name}.")
    m = people.set_member(s, team, p, body.role, actor=f"user:{u.email}")
    return serial.member(p, m)


@router.delete("/teams/{slug}/members/{user_id}")
def delete_member(slug: str, user_id: str, s: deps.Session, u: deps.User) -> dict:
    """Take someone off the team. You can always leave a team yourself."""
    team = deps.team_or_404(s, u, slug)
    if user_id != u.id:
        deps.require_team_admin(s, u, team.id, "remove members")
    p = _person_or_404(s, u, user_id)
    people.remove_member(s, team, p, f"user:{u.email}")
    return {"ok": True, "message": f"{p.name} is off {team.name}."}
