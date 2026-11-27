"""MCP server: every team's steward as tools for Claude Code, Cursor or any MCP client.

``keel mcp --as you@company.com`` runs it on stdio. The tools act as that Keel user: they see what the user
may see (restricted knowledge is withheld and counted, as in Slack) and writes are recorded under their name.
Without ``--as`` the server is read-only and sees only org-wide material.
"""

from __future__ import annotations

import functools
import typing

import sqlalchemy as sa
from mcp import types as mcp_types
from mcp.server import mcpserver
from mcp.server.mcpserver import exceptions as mcp_exceptions
from sqlalchemy import orm

from keel import (
    brain,
    checkup,
    connections,
    db,
    feed,
    knowledge,
    labels,
    learning,
    ledger,
    llm,
    models,
    promises,
    steward,
)
from keel import wrapped as wrapped_mod
from keel.api import serial

MAX_LIST = 50  # Rows returned to an assistant at once; more crowds out its context.
INSTRUCTIONS = """Keel gives every team an AI steward that keeps the team's commitments ledger and knowledge.
Use list_teams first to learn team slugs. Use ask_team for "how do I…/who owns…" questions about a team,
list_commitments to see what a team promised and what is overdue, and log_commitment when the user commits
to work for a team. Answers cite their sources in [brackets]; repeat the citations."""
READ_ONLY = mcp_types.ToolAnnotations(readOnlyHint=True, openWorldHint=False)
WRITES = mcp_types.ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)


class Identity:
    """Who the tools act as: an org, and a user or nobody (read-only, org clearance)."""

    def __init__(self, email: str = "") -> None:
        db.migrate()
        with db.session() as s:
            org = s.scalar(sa.select(models.Org).order_by(models.Org.created_at).limit(1))
            if org is None:
                raise ValueError("Keel has no organisation yet. Run keel demo or the setup wizard first.")
            self.org_id = org.id
            self.user_id: str | None = None
            self.email = email.strip().lower()
            if self.email:
                user = s.scalar(
                    sa.select(models.User).where(
                        models.User.org_id == org.id, sa.func.lower(models.User.email) == self.email
                    )
                )
                if user is None or user.disabled:
                    raise ValueError(f"No active Keel user {email!r}. Use the email you sign in with.")
                self.user_id = user.id

    def user(self, s: orm.Session) -> models.User | None:
        """The user row in this session, or None when read-only."""
        return s.get(models.User, self.user_id) if self.user_id else None

    @property
    def actor(self) -> str:
        """Audit actor name."""
        return f"user:{self.email} via mcp" if self.email else "mcp"


_F = typing.TypeVar("_F", bound=typing.Callable[..., typing.Any])


def _plain(fn: _F) -> _F:
    """Show ValueError messages to the assistant; MCP hides other exceptions' text as crashes."""

    @functools.wraps(fn)
    def wrapper(*args: typing.Any, **kwargs: typing.Any) -> typing.Any:
        try:
            return fn(*args, **kwargs)
        except ValueError as exc:
            raise mcp_exceptions.ToolError(str(exc)) from exc

    return typing.cast(_F, wrapper)


def _team(s: orm.Session, ident: Identity, slug: str) -> models.Team:
    team = steward.team_by_slug(s, ident.org_id, slug.strip().lstrip("#@"))
    if team is None:
        names = ", ".join(s.scalars(sa.select(models.Team.slug).where(models.Team.org_id == ident.org_id)))
        raise ValueError(f"No team {slug!r}. Teams: {names or 'none yet'}.")
    return team


def build(email: str = "") -> mcpserver.MCPServer:
    """Create the server with its tools, bound to the user with ``email`` (read-only when empty)."""
    ident = Identity(email)
    server = mcpserver.MCPServer(name="keel", title="Keel team stewards", instructions=INSTRUCTIONS)

    @server.tool(annotations=READ_ONLY)
    @_plain
    def list_teams() -> list[dict[str, typing.Any]]:
        """Teams with their steward, open commitments, overdue count and health (0–100)."""
        with db.session() as s:
            teams = s.scalars(
                sa.select(models.Team).where(models.Team.org_id == ident.org_id).order_by(models.Team.slug)
            )
            out = []
            for t in teams:
                summary = serial.team_summary(s, t)
                out.append(
                    {
                        "slug": t.slug,
                        "name": t.name,
                        "steward": (summary.get("steward") or {}).get("name"),
                        "open": summary["counts"]["open"],
                        "overdue": summary["counts"]["overdue"],
                        "health": summary.get("health"),
                    }
                )
            return out

    @server.tool(annotations=READ_ONLY)
    @_plain
    def ask_team(team: str, question: str) -> dict[str, typing.Any]:
        """Ask a team's steward. Answers come only from the team's knowledge, with sources cited.

        Args:
            team: Team slug from list_teams, e.g. "payments".
            question: The question, e.g. "how do I rotate the Stripe webhook secret?".
        """
        if not question.strip():
            raise ValueError("Ask a question first.")
        with db.session() as s:
            t = _team(s, ident, team)
            found = knowledge.search(s, [t.id], question, steward.clearance_for(s, ident.user(s), t))
            st = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == t.id))
            reply = learning.answer(
                s,
                t,
                llm.for_org(s, ident.org_id),
                question,
                found,
                steward=st.name if st else "Steward",
                asked_by=ident.actor,
            )
            feed.audit(s, ident.org_id, ident.actor, "mcp.ask", t.slug, question[:200], t.id)
            return {
                "answer": reply.text,
                "open_question": reply.gap is not None,
                "sources": [p.title for p in found.passages],
                "withheld_sources": found.withheld,
            }

    @server.tool(annotations=READ_ONLY)
    @_plain
    def list_commitments(team: str = "", status: str = "open") -> list[dict[str, typing.Any]]:
        """What teams promised: key, title, status, risk (on_track/at_risk/overdue), owner and due date.

        Args:
            team: Team slug; empty for every team.
            status: "open", "closed", "all", or one status such as "blocked".
        """
        with db.session() as s:
            q = sa.select(models.Commitment).where(models.Commitment.org_id == ident.org_id)
            teams = (
                [_team(s, ident, team)]
                if team
                else list(s.scalars(sa.select(models.Team).where(models.Team.org_id == ident.org_id)))
            )
            q = q.where(models.Commitment.owner_team_id.in_([t.id for t in teams]))
            if status == "open":
                q = q.where(models.Commitment.status.in_(ledger.OPEN_STATUSES))
            elif status == "closed":
                q = q.where(models.Commitment.status.in_(ledger.CLOSED_STATUSES))
            elif status != "all":
                if status not in ledger.STATUSES:
                    raise ValueError(
                        f"status must be open, closed, all or one of {', '.join(ledger.STATUSES)}."
                    )
                q = q.where(models.Commitment.status == status)
            clearance = {t.id: steward.clearance_for(s, ident.user(s), t) for t in teams}
            idx, now = serial.TeamIndex(s, ident.org_id), models.utcnow()
            rows = s.scalars(
                q.order_by(models.Commitment.due_at.is_(None), models.Commitment.due_at).limit(MAX_LIST * 2)
            )
            out = []
            for c in rows:
                if not labels.audience_allows(clearance[c.owner_team_id], c.label):
                    continue
                j = serial.commitment(c, idx, now)
                out.append(
                    {
                        k: j[k]
                        for k in ("key", "title", "status", "risk", "owner_team", "owner_person", "due_at")
                    }
                )
            return out[:MAX_LIST]

    @server.tool(annotations=WRITES)
    @_plain
    def log_commitment(
        team: str, title: str, due: str = "", owner: str = "", detail: str = ""
    ) -> dict[str, typing.Any]:
        """Log a commitment on a team's ledger, e.g. when the user says "I'll ship the fix by Friday".

        Args:
            team: Team slug that owns the work.
            title: Short imperative title, e.g. "Rotate the Stripe webhook secret".
            due: Due date as YYYY-MM-DD or plain words like "Friday"; empty for none.
            owner: Person doing the work; defaults to the user the server acts as.
            detail: Optional context, such as a link.
        """
        if not ident.user_id:
            raise ValueError("This Keel MCP server is read-only. Start it with --as your@email to log work.")
        with db.session() as s:
            t = _team(s, ident, team)
            due_at = None
            if due.strip():
                due_at = brain.parse_due(due, models.utcnow(), t.timezone)
                if due_at is None:
                    raise ValueError(
                        f"Couldn't read the date {due!r}. Use YYYY-MM-DD or words like 'Friday'."
                    )
            c = ledger.create(
                s,
                team=t,
                title=title,
                actor=ident.actor,
                detail=detail,
                due_at=due_at,
                owner_person=owner or (ident.user(s).name if ident.user(s) else None),
                status="accepted",
                source_kind="mcp",
            )
            return {
                "key": c.key,
                "title": c.title,
                "due": ledger.day(c.due_at, t.timezone, "%Y-%m-%d") if c.due_at else None,
            }

    @server.tool(annotations=WRITES)
    @_plain
    def update_commitment(key: str, status: str, note: str = "") -> dict[str, typing.Any]:
        """Change a commitment's status, e.g. mark C-42 done.

        Args:
            key: Commitment key such as "C-42".
            status: One of proposed, accepted, in_progress, blocked, done, dropped, declined.
            note: Optional note for the timeline.
        """
        if not ident.user_id:
            raise ValueError(
                "This Keel MCP server is read-only. Start it with --as your@email to change work."
            )
        with db.session() as s:
            c = ledger.get(s, ident.org_id, key.strip().upper())
            if c is None:
                raise ValueError(f"No commitment {key!r}.")
            ledger.update(s, c, ident.actor, status=status, note=note or None)
            return {"key": c.key, "status": c.status}

    @server.tool(annotations=READ_ONLY)
    @_plain
    def team_wrapped(team: str, days: int = wrapped_mod.WRAPPED_DAYS) -> dict[str, typing.Any]:
        """A team's recap for the last `days` days: kept on time, fastest close, best partner, persona."""
        with db.session() as s:
            t = _team(s, ident, team)
            facts = wrapped_mod.compute(s, t, days=days)
            facts["headline"] = wrapped_mod.headline(llm.for_org(s, ident.org_id), facts)
            return facts

    @server.tool(annotations=mcp_types.ToolAnnotations(readOnlyHint=True, openWorldHint=True))
    @_plain
    def find_promises(repo: str, days: int = promises.LOOKBACK_DAYS) -> dict[str, typing.Any]:
        """Scan a GitHub repo's comments for promises ("I'll fix this by Friday") and which were kept.

        Args:
            repo: owner/name, e.g. "fastapi/fastapi".
            days: How far back to look.
        """
        with db.session() as s:
            res = connections.resolve(s, ident.org_id, "github")
            chat = llm.for_org(s, ident.org_id)
        try:
            report = promises.scan(
                repo,
                days=days,
                token=res.secrets.get("token", ""),
                api_url=res.config.get("api_url") or "https://api.github.com",
                model=chat,
            )
        except checkup.CheckupError as exc:
            raise ValueError(str(exc)) from exc
        late = [p for p in report.promises if p.status in ("overdue", "quiet")]
        return {
            "repo": report.repo,
            "stats": {k: v for k, v in report.stats.items() if k not in ("oldest_unkept", "fastest_kept")},
            "late": [
                {
                    "who": p.who,
                    "what": p.what,
                    "url": p.url,
                    "days_ago": round(p.age_days),
                    "status": p.status,
                }
                for p in late[:MAX_LIST]
            ],
            "not_checked": report.not_checked,
        }

    return server


def serve(email: str = "") -> None:
    """Run on stdio until the client disconnects."""
    build(email).run("stdio")
