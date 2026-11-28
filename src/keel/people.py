"""People: invites, org roles, team membership, SSO group mapping and Slack account linking."""

from __future__ import annotations

import datetime as dt
import hashlib
import secrets

import sqlalchemy as sa
from sqlalchemy import orm

from keel import auth_utils, errors, feed, models

INVITE_TTL = dt.timedelta(days=7)  # Long enough to survive a weekend; short enough that stale links die.
ORG_ROLES = ("org_admin", "member")
TEAM_ROLES = {"admin": "team_admin", "member": "member"}  # API name → stored name


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def norm_email(email: str) -> str:
    """Lowercased, trimmed email. Raises ValueError when it isn't one."""
    e = (email or "").strip().lower()
    if "@" not in e or e.startswith("@") or e.endswith("@") or " " in e:
        raise ValueError("That email address doesn't look right.")
    return e


def api_team_role(stored: str) -> str:
    """'team_admin' → 'admin'; anything else → 'member'."""
    return "admin" if stored == "team_admin" else "member"


def stored_team_role(api_role: str) -> str:
    """'admin' → 'team_admin', 'member' → 'member'. Raises ValueError otherwise."""
    if api_role not in TEAM_ROLES:
        raise ValueError("A team role is admin or member.")
    return TEAM_ROLES[api_role]


def check_org_role(role: str) -> str:
    """Return ``role`` when it's an org role. Raises ValueError otherwise."""
    if role not in ORG_ROLES:
        raise ValueError("An org role is org_admin or member.")
    return role


def _team(s: orm.Session, org_id: str, slug: str) -> models.Team:
    team = s.scalar(sa.select(models.Team).where(models.Team.org_id == org_id, models.Team.slug == slug))
    if team is None:
        raise ValueError(f"There's no team called {slug}.")
    return team


# ---------------------------------------------------------------- invites


def invite_status(inv: models.Invite, now: dt.datetime | None = None) -> str:
    """pending | accepted | expired | revoked."""
    now = now or models.utcnow()
    if inv.revoked_at:
        return "revoked"
    if inv.accepted_at:
        return "accepted"
    if inv.expires_at <= now:
        return "expired"
    return "pending"


def create_invite(
    s: orm.Session,
    org: models.Org,
    email: str,
    role: str,
    teams: list[dict[str, str]],
    inviter: models.User | None,
) -> tuple[models.Invite, str]:
    """Make a one-time invite. Returns the row and the raw token (shown once, never stored)."""
    email = norm_email(email)
    check_org_role(role)
    clean = []
    for t in teams:
        _team(s, org.id, t["slug"])
        stored_team_role(t.get("role", "member"))
        clean.append({"slug": t["slug"], "role": t.get("role", "member")})
    existing = s.scalar(
        sa.select(models.User).where(models.User.org_id == org.id, models.User.email == email)
    )
    if existing is not None:
        raise ValueError(f"{email} already has an account. Add them to teams from People.")
    for old in s.scalars(
        sa.select(models.Invite).where(
            models.Invite.org_id == org.id,
            models.Invite.email == email,
            models.Invite.accepted_at.is_(None),
            models.Invite.revoked_at.is_(None),
        )
    ):
        old.revoked_at = models.utcnow()
    token = secrets.token_urlsafe(32)
    inv = models.Invite(
        org_id=org.id,
        email=email,
        role=role,
        teams=clean,
        token_hash=_hash(token),
        invited_by=inviter.name if inviter else "keel",
        expires_at=models.utcnow() + INVITE_TTL,
    )
    s.add(inv)
    s.flush()
    actor = f"user:{inviter.email}" if inviter else "keel"
    feed.audit(
        s, org.id, actor, "people.invited", email, f"role={role}; teams={','.join(t['slug'] for t in clean)}"
    )
    return inv, token


def invite_by_token(s: orm.Session, token: str) -> models.Invite | None:
    """The invite for a raw token, or None."""
    if not token:
        return None
    return s.scalar(sa.select(models.Invite).where(models.Invite.token_hash == _hash(token)))


def _apply_invite(s: orm.Session, inv: models.Invite, user: models.User) -> None:
    if inv.role == "org_admin":
        user.role = "org_admin"
    for t in inv.teams:
        team = s.scalar(
            sa.select(models.Team).where(models.Team.org_id == inv.org_id, models.Team.slug == t["slug"])
        )
        if team is not None:
            set_member(s, team, user, t.get("role", "member"), actor=f"invite:{inv.invited_by}")
    inv.accepted_at = models.utcnow()


def accept_invite(s: orm.Session, inv: models.Invite, name: str, password: str) -> models.User:
    """Create the account an invite is for. Raises ValueError when the invite can't be used."""
    status = invite_status(inv)
    if status != "pending":
        raise ValueError(
            {
                "accepted": "This invite was already used. Sign in instead.",
                "expired": "This invite expired. Ask for a new one.",
                "revoked": "This invite was withdrawn. Ask for a new one.",
            }[status]
        )
    if not name.strip():
        raise ValueError("Tell us your name.")
    auth_utils.check_new_password(password)
    if s.scalar(
        sa.select(models.User.id).where(models.User.org_id == inv.org_id, models.User.email == inv.email)
    ):
        raise ValueError(f"{inv.email} already has an account. Sign in instead.")
    user = models.User(
        org_id=inv.org_id,
        email=inv.email,
        name=name.strip()[:200],
        role="member",
        password_hash=auth_utils.hash_password(password),
    )
    s.add(user)
    s.flush()
    _apply_invite(s, inv, user)
    feed.audit(s, inv.org_id, f"user:{user.email}", "people.joined", user.email, "invite")
    return user


def claim_invite_for(s: orm.Session, user: models.User) -> bool:
    """Apply a pending invite for this user's email (e.g. after SSO sign-up). Returns True if one was used."""
    inv = s.scalar(
        sa.select(models.Invite)
        .where(
            models.Invite.org_id == user.org_id,
            models.Invite.email == user.email,
            models.Invite.accepted_at.is_(None),
            models.Invite.revoked_at.is_(None),
            models.Invite.expires_at > models.utcnow(),
        )
        .order_by(models.Invite.created_at.desc())
    )
    if inv is None:
        return False
    _apply_invite(s, inv, user)
    return True


# ---------------------------------------------------------------- org roles and accounts


def _admins(s: orm.Session, org_id: str) -> int:
    return (
        s.scalar(
            sa.select(sa.func.count())
            .select_from(models.User)
            .where(
                models.User.org_id == org_id, models.User.role == "org_admin", models.User.disabled.is_(False)
            )
        )
        or 0
    )


def update_person(
    s: orm.Session, target: models.User, actor: models.User, role: str | None, disabled: bool | None
) -> None:
    """Change someone's org role or disable them. You can't lock yourself or the last admin out."""
    losing_admin = target.role == "org_admin" and (
        (role is not None and role != "org_admin") or disabled is True
    )
    if losing_admin and target.id == actor.id:
        raise errors.Conflict("You can't remove your own admin rights or disable yourself.")
    if losing_admin and not target.disabled and _admins(s, target.org_id) <= 1:
        raise errors.Conflict("This is the last admin. Make someone else an admin first.")
    changes = []
    if role is not None and role != target.role:
        target.role = check_org_role(role)
        changes.append(f"role={role}")
    if disabled is not None and disabled != target.disabled:
        target.disabled = disabled
        changes.append("disabled" if disabled else "enabled")
    if changes:
        feed.audit(
            s, target.org_id, f"user:{actor.email}", "people.updated", target.email, "; ".join(changes)
        )


def remove_person(s: orm.Session, target: models.User, actor: models.User) -> None:
    """Delete an account and its memberships. Their past actions stay in the audit log by email."""
    if target.id == actor.id:
        raise errors.Conflict("You can't remove yourself.")
    if target.role == "org_admin" and not target.disabled and _admins(s, target.org_id) <= 1:
        raise errors.Conflict("This is the last admin. Make someone else an admin first.")
    feed.audit(s, target.org_id, f"user:{actor.email}", "people.removed", target.email)
    s.execute(sa.delete(models.TeamMember).where(models.TeamMember.user_id == target.id))
    s.delete(target)
    s.flush()


# ---------------------------------------------------------------- team membership


def set_member(
    s: orm.Session, team: models.Team, user: models.User, api_role: str, actor: str = "keel"
) -> models.TeamMember:
    """Add someone to a team, or change their team role."""
    role = stored_team_role(api_role)
    if user.org_id != team.org_id:
        raise ValueError("That person isn't in this org.")
    m = s.get(models.TeamMember, {"team_id": team.id, "user_id": user.id})
    if m is None:
        m = models.TeamMember(team_id=team.id, user_id=user.id, role=role)
        s.add(m)
        feed.audit(s, team.org_id, actor, "team.member_added", user.email, f"role={api_role}", team.id)
    elif m.role != role:
        m.role = role
        feed.audit(s, team.org_id, actor, "team.member_role", user.email, f"role={api_role}", team.id)
    s.flush()
    return m


def remove_member(s: orm.Session, team: models.Team, user: models.User, actor: str) -> None:
    """Take someone off a team."""
    m = s.get(models.TeamMember, {"team_id": team.id, "user_id": user.id})
    if m is None:
        raise errors.Missing(f"{user.name} isn't on {team.name}.")
    s.delete(m)
    feed.audit(s, team.org_id, actor, "team.member_removed", user.email, "", team.id)
    s.flush()


def teams_of(s: orm.Session, user: models.User) -> list[tuple[models.Team, str]]:
    """(team, stored role) for each team the person is on."""
    return [
        (t, m.role)
        for t, m in s.execute(
            sa.select(models.Team, models.TeamMember)
            .join(models.TeamMember, models.TeamMember.team_id == models.Team.id)
            .where(models.TeamMember.user_id == user.id)
            .order_by(models.Team.name)
        )
    ]


def sync_sso_groups(s: orm.Session, user: models.User, groups: list[str]) -> list[str]:
    """Put the person on every team whose ``sso_groups`` match one of theirs. Never removes. Returns slugs added."""
    have = set(groups)
    added = []
    for team in s.scalars(sa.select(models.Team).where(models.Team.org_id == user.org_id)):
        if (
            have & set(team.sso_groups or [])
            and s.get(models.TeamMember, {"team_id": team.id, "user_id": user.id}) is None
        ):
            set_member(s, team, user, "member", actor="sso")
            added.append(team.slug)
    return added


# ---------------------------------------------------------------- Slack accounts


def link_slack_user(s: orm.Session, org_id: str, slack_user_id: str, email: str | None) -> models.User | None:
    """The Keel user for a Slack user: by stored id, else by email (and remember the id)."""
    if not slack_user_id:
        return None
    u = s.scalar(
        sa.select(models.User).where(models.User.org_id == org_id, models.User.slack_user_id == slack_user_id)
    )
    if u is not None or not email:
        return u
    u = s.scalar(
        sa.select(models.User).where(models.User.org_id == org_id, models.User.email == email.strip().lower())
    )
    if u is not None and not u.slack_user_id:
        u.slack_user_id = slack_user_id
        s.flush()
    return u
