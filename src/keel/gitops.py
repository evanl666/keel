"""``keel apply -f keel.yaml``: declare teams, stewards, services and knowledge in a file and keep them in git.

Levels are earned, not declared: a file can set a new team's starting level or lower an existing one, but it
never raises a live steward's level. Raising goes through the level page, where a person signs it off.
"""

from __future__ import annotations

import pathlib

import pydantic
import sqlalchemy as sa
import yaml
from sqlalchemy import orm

from keel import demo, feed, knowledge, labels, levels, models, services
from keel.api import routes

Change = tuple[str, str]  # (create | update | keep | skip, one line)
ACTOR = "keel apply"


class StewardSpec(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")
    name: str = "Pip"
    emoji: str | None = None
    duties: list[str] | None = None


class RunbookSpec(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")
    id: str
    name: str
    min_level: int = 4


class ServiceSpec(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")
    name: str
    url: str
    owner: str | None = None
    interval_s: int = 60
    runbooks: list[RunbookSpec] = []


class DocSpec(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")
    path: str | None = None
    title: str | None = None
    content: str | None = None
    label: str = "internal"

    @pydantic.model_validator(mode="after")
    def _one_source(self) -> DocSpec:
        if bool(self.path) == bool(self.content):
            raise ValueError("A knowledge entry needs either path or content.")
        return self


class TeamSpec(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")
    slug: str
    name: str
    steward: StewardSpec = StewardSpec()
    level: int | None = None
    slack_channel: str | None = None
    github_repos: list[str] = []
    timezone: str | None = None
    brief_hour: int | None = None
    services: list[ServiceSpec] = []
    knowledge: list[DocSpec] = []


class Plan(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")
    org: str | None = None
    default_level: int | None = None
    teams: list[TeamSpec] = []


def load(path: pathlib.Path) -> Plan:
    """Parse and validate a keel.yaml. Raises ValueError with the first problem."""
    data = yaml.safe_load(path.read_text()) or {}
    try:
        plan = Plan.model_validate(data)
    except pydantic.ValidationError as exc:
        err = exc.errors()[0]
        raise ValueError(f"{path.name}: {'.'.join(str(x) for x in err['loc'])}: {err['msg']}") from exc
    slugs = [t.slug for t in plan.teams]
    if len(slugs) != len(set(slugs)):
        raise ValueError(f"{path.name}: a team slug appears twice.")
    return plan


def _org(s: orm.Session, plan: Plan, out: list[Change]) -> models.Org:
    org = s.scalar(sa.select(models.Org).order_by(models.Org.created_at))
    if org is None:
        org = models.Org(name=plan.org or "My company", settings={})
        s.add(org)
        s.flush()
        out.append(("create", f"org {org.name}"))
    elif plan.org and plan.org != org.name:
        out.append(("update", f"org name {org.name} → {plan.org}"))
        org.name = plan.org
    if plan.default_level is not None and org.settings.get("default_level") != plan.default_level:
        levels.level_def(plan.default_level)
        org.settings = {**org.settings, "default_level": plan.default_level}
        out.append(("update", f"default level → L{plan.default_level}"))
    return org


def _team(s: orm.Session, org: models.Org, spec: TeamSpec, out: list[Change]) -> models.Team:
    team = s.scalar(sa.select(models.Team).where(models.Team.org_id == org.id, models.Team.slug == spec.slug))
    if team is None:
        if spec.level is not None:
            levels.level_def(spec.level)
        team = routes.create_team(
            s,
            org,
            routes.NewTeam(
                name=spec.name,
                slug=spec.slug,
                steward_name=spec.steward.name,
                emoji=spec.steward.emoji,
                slack_channel=spec.slack_channel,
            ),
            None,
            level=spec.level,
        )
        out.append(
            ("create", f"team {spec.slug} with steward {spec.steward.name} at L{gateway_level(s, team)}")
        )
    else:
        changed = []
        if team.name != spec.name:
            team.name = spec.name
            changed.append("name")
        if spec.slack_channel and spec.slack_channel not in (
            team.slack_channel_id,
            team.slack_channel_name,
            f"#{team.slack_channel_name}",
        ):
            ch = spec.slack_channel
            if ch[:1] in "CG" and ch[1:].isalnum() and ch.isupper():
                team.slack_channel_id = ch
            else:
                team.slack_channel_name = ch if ch.startswith("#") else f"#{ch}"
            changed.append("slack channel")
        if changed:
            out.append(("update", f"team {spec.slug}: {', '.join(changed)}"))
        else:
            out.append(("keep", f"team {spec.slug}"))
    if [r.lower() for r in team.github_repos or []] != [
        r.lower() for r in spec.github_repos
    ] and spec.github_repos:
        team.github_repos = spec.github_repos
        out.append(("update", f"team {spec.slug}: repos {', '.join(spec.github_repos)}"))
    if spec.timezone and spec.timezone != team.timezone:
        team.timezone = spec.timezone
        out.append(("update", f"team {spec.slug}: timezone {spec.timezone}"))
    if spec.brief_hour is not None and spec.brief_hour != team.brief_hour:
        if not 0 <= spec.brief_hour <= 23:
            raise ValueError(f"{spec.slug}: brief_hour must be 0–23.")
        team.brief_hour = spec.brief_hour
        out.append(("update", f"team {spec.slug}: brief at {spec.brief_hour}:00"))
    return team


def gateway_level(s: orm.Session, team: models.Team) -> int:
    """The team steward's current level."""
    st = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
    return st.level if st else 0


def _steward(s: orm.Session, team: models.Team, spec: TeamSpec, out: list[Change]) -> None:
    st = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
    if st is None:
        return
    if spec.steward.name != st.name or (spec.steward.emoji and spec.steward.emoji != st.emoji):
        st.name, st.emoji = spec.steward.name, spec.steward.emoji or st.emoji
        out.append(("update", f"{spec.slug} steward → {st.emoji} {st.name}"))
    if spec.steward.duties is not None and sorted(spec.steward.duties) != sorted(st.duties or []):
        bad = set(spec.steward.duties) - set(demo.ALL_DUTIES)
        if bad:
            raise ValueError(f"{spec.slug}: unknown duties {', '.join(sorted(bad))}.")
        st.duties = spec.steward.duties
        out.append(("update", f"{spec.slug} duties → {', '.join(st.duties)}"))
    if spec.level is not None and spec.level != st.level:
        if spec.level < st.level:
            levels.set_level(s, st, spec.level, f"Lowered by {ACTOR}.", ACTOR)
            out.append(("update", f"{spec.slug} level lowered to L{spec.level}"))
        else:
            out.append(
                (
                    "skip",
                    f"{spec.slug} level stays L{st.level}: raising a level needs a person on the level page",
                )
            )


def _services(s: orm.Session, team: models.Team, spec: TeamSpec, out: list[Change]) -> None:
    for sv in spec.services:
        row = s.scalar(
            sa.select(models.Service).where(models.Service.team_id == team.id, models.Service.name == sv.name)
        )
        rbs = [r.model_dump() for r in sv.runbooks]
        if row is None:
            services.add(s, team, sv.name, sv.url, sv.owner, rbs, sv.interval_s)
            out.append(("create", f"{spec.slug} service {sv.name} ({sv.url})"))
        elif (row.url, row.owner, row.runbooks, row.interval_s) != (
            sv.url,
            sv.owner,
            rbs,
            max(sv.interval_s, services.MIN_INTERVAL_S),
        ):
            row.url, row.owner, row.runbooks = sv.url, sv.owner, rbs
            row.interval_s = max(sv.interval_s, services.MIN_INTERVAL_S)
            out.append(("update", f"{spec.slug} service {sv.name}"))


def _knowledge(
    s: orm.Session, team: models.Team, spec: TeamSpec, base_dir: pathlib.Path, out: list[Change]
) -> None:
    for d in spec.knowledge:
        labels.rank(d.label)
        if d.path:
            p = (base_dir / d.path).resolve()
            if not p.is_file():
                out.append(("skip", f"{spec.slug} knowledge {d.path}: file not found"))
                continue
            content, title, source = (
                p.read_text(errors="replace"),
                d.title or p.stem.replace("-", " ").title(),
                f"file://{d.path}",
            )
        else:
            content, title, source = d.content or "", d.title or "Untitled", None
        existing = s.scalar(
            sa.select(models.KnowledgeDoc).where(
                models.KnowledgeDoc.team_id == team.id,
                models.KnowledgeDoc.source
                == (source or f"keel://{team.slug}/{title.lower().replace(' ', '-')}"),
            )
        )
        if existing is not None and existing.content == content and existing.label == d.label:
            continue
        knowledge.add(s, team, title, content, d.label, source, actor=ACTOR)
        out.append(("update" if existing else "create", f"{spec.slug} knowledge {title} [{d.label}]"))


def apply(
    s: orm.Session, plan: Plan, base_dir: pathlib.Path = pathlib.Path("."), dry_run: bool = False
) -> list[Change]:
    """Make the database match the plan. Never deletes; returns what changed.

    With ``dry_run`` the session is rolled back before returning, so nothing is written. Otherwise the caller commits.
    """
    out: list[Change] = []
    org = _org(s, plan, out)
    for spec in plan.teams:
        team = _team(s, org, spec, out)
        _steward(s, team, spec, out)
        _services(s, team, spec, out)
        _knowledge(s, team, spec, base_dir, out)
    if dry_run:
        s.rollback()
        return out
    if any(v in ("create", "update") for v, _ in out):
        feed.audit(
            s,
            org.id,
            ACTOR,
            "apply",
            f"{len(plan.teams)} teams",
            "; ".join(w for v, w in out if v in ("create", "update"))[:2000],
        )
    return out
