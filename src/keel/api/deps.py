"""Request dependencies: database session, signed-in user, and permission checks."""

from __future__ import annotations

import typing

import fastapi
import sqlalchemy as sa
from sqlalchemy import orm

from keel import auth_utils, config, db, models

COOKIE = "keel_session"


def get_session() -> typing.Iterator[orm.Session]:
    """One transaction per request: commit on success, roll back on error."""
    with db.session() as s:
        yield s


Session = typing.Annotated[orm.Session, fastapi.Depends(get_session)]


def demo_admin(s: orm.Session) -> models.User | None:
    """The demo org's admin (auto sign-in in demo mode)."""
    return s.scalar(
        sa.select(models.User)
        .join(models.Org, models.Org.id == models.User.org_id)
        .where(models.User.role == "org_admin")
        .order_by(models.User.created_at)
    )


def current_user(request: fastapi.Request, s: Session) -> models.User | None:
    """The signed-in user, the demo admin in demo mode, or None."""
    uid = auth_utils.read_session(request.cookies.get(COOKIE))
    if uid:
        u = s.get(models.User, uid)
        if u is not None and not u.disabled:
            return u
    if config.get().demo:
        return demo_admin(s)
    return None


MaybeUser = typing.Annotated[models.User | None, fastapi.Depends(current_user)]


def require_user(u: MaybeUser) -> models.User:
    """401 unless signed in."""
    if u is None:
        raise fastapi.HTTPException(401, "Sign in first.")
    return u


User = typing.Annotated[models.User, fastapi.Depends(require_user)]


def require_org_admin(u: User) -> models.User:
    """403 unless an org admin."""
    if u.role != "org_admin":
        raise fastapi.HTTPException(403, "Only an org admin can do that.")
    return u


Admin = typing.Annotated[models.User, fastapi.Depends(require_org_admin)]


def team_or_404(s: orm.Session, u: models.User, slug: str) -> models.Team:
    """The user's org's team with this slug."""
    team = s.scalar(sa.select(models.Team).where(models.Team.org_id == u.org_id, models.Team.slug == slug))
    if team is None:
        raise fastapi.HTTPException(404, f"There's no team called {slug}.")
    return team


def team_role(s: orm.Session, u: models.User, team_id: str) -> str | None:
    """'org_admin', 'team_admin', 'member' or None."""
    if u.role == "org_admin":
        return "org_admin"
    m = s.get(models.TeamMember, {"team_id": team_id, "user_id": u.id})
    return m.role if m else None


def require_team_member(s: orm.Session, u: models.User, team_id: str, what: str = "do that") -> None:
    """403 unless the user belongs to the team (or is an org admin)."""
    if team_role(s, u, team_id) is None:
        raise fastapi.HTTPException(403, f"Only members of this team can {what}.")


def require_team_admin(s: orm.Session, u: models.User, team_id: str, what: str = "do that") -> None:
    """403 unless a team admin or org admin."""
    if team_role(s, u, team_id) not in ("org_admin", "team_admin"):
        raise fastapi.HTTPException(403, f"Only a team admin can {what}.")
