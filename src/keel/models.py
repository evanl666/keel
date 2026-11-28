"""Database schema. Every tenant table carries ``org_id``; team-scoped tables carry ``team_id``."""

from __future__ import annotations

import datetime as dt
import uuid

import sqlalchemy as sa
from sqlalchemy import orm


def new_id() -> str:
    """Return a new random 32-char hex id."""
    return uuid.uuid4().hex


def utcnow() -> dt.datetime:
    """Return the current UTC time as an aware datetime."""
    return dt.datetime.now(dt.UTC)


class UTCDateTime(sa.types.TypeDecorator):
    """Timezone-aware datetime that comes back aware on SQLite too."""

    impl = sa.DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=dt.UTC)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=dt.UTC)
        return value


class Base(orm.DeclarativeBase):
    """Declarative base with a stable naming convention for constraints (clean migrations)."""

    metadata = sa.MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )
    type_annotation_map = {dt.datetime: UTCDateTime(), dict: sa.JSON, list: sa.JSON}  # noqa: RUF012 - SQLAlchemy reads this mapping by name


IdCol = orm.Mapped[str]


def id_column() -> orm.MappedColumn:
    """Primary key column with a random hex id."""
    return orm.mapped_column(sa.String(32), primary_key=True, default=new_id)


def org_fk() -> orm.MappedColumn:
    """Indexed foreign key to ``orgs``."""
    return orm.mapped_column(sa.String(32), sa.ForeignKey("orgs.id", ondelete="CASCADE"), index=True)


def team_fk(nullable: bool = False) -> orm.MappedColumn:
    """Indexed foreign key to ``teams``."""
    return orm.mapped_column(
        sa.String(32), sa.ForeignKey("teams.id", ondelete="CASCADE"), index=True, nullable=nullable
    )


class Org(Base):
    __tablename__ = "orgs"
    id: IdCol = id_column()
    name: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    commitment_seq: orm.Mapped[int] = orm.mapped_column(default=0)
    settings: orm.Mapped[dict] = orm.mapped_column(default=dict)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (sa.UniqueConstraint("org_id", "email", name="uq_users_org_email"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    email: orm.Mapped[str] = orm.mapped_column(sa.String(320))
    name: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    role: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="member")
    password_hash: orm.Mapped[str | None] = orm.mapped_column(sa.String(300), nullable=True)
    sso_subject: orm.Mapped[str | None] = orm.mapped_column(sa.String(300), nullable=True)
    slack_user_id: orm.Mapped[str | None] = orm.mapped_column(sa.String(40), nullable=True, index=True)
    github_login: orm.Mapped[str | None] = orm.mapped_column(sa.String(100), nullable=True)
    avatar_url: orm.Mapped[str | None] = orm.mapped_column(sa.String(500), nullable=True)
    disabled: orm.Mapped[bool] = orm.mapped_column(default=False)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    last_seen_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)


class Team(Base):
    __tablename__ = "teams"
    __table_args__ = (sa.UniqueConstraint("org_id", "slug", name="uq_teams_org_slug"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    slug: orm.Mapped[str] = orm.mapped_column(sa.String(60))
    name: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    color: orm.Mapped[str] = orm.mapped_column(sa.String(9), default="#7C5CFF")
    slack_channel_id: orm.Mapped[str | None] = orm.mapped_column(sa.String(40), nullable=True, index=True)
    slack_channel_name: orm.Mapped[str | None] = orm.mapped_column(sa.String(100), nullable=True)
    slack_member_count: orm.Mapped[int | None] = orm.mapped_column(nullable=True)
    github_repos: orm.Mapped[list] = orm.mapped_column(default=list)
    timezone: orm.Mapped[str] = orm.mapped_column(sa.String(60), default="UTC")
    brief_hour: orm.Mapped[int] = orm.mapped_column(default=9)
    sso_groups: orm.Mapped[list] = orm.mapped_column(default=list)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class TeamMember(Base):
    __tablename__ = "team_members"
    team_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="member")


class Invite(Base):
    """A one-time link that lets someone join the org (and some teams). Only the token's hash is stored."""

    __tablename__ = "invites"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    email: orm.Mapped[str] = orm.mapped_column(sa.String(320))
    role: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="member")
    teams: orm.Mapped[list] = orm.mapped_column(default=list)  # [{"slug": ..., "role": "admin"|"member"}]
    token_hash: orm.Mapped[str] = orm.mapped_column(sa.String(64), unique=True)
    invited_by: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    expires_at: orm.Mapped[dt.datetime] = orm.mapped_column()
    accepted_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    revoked_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)


class LoginFailure(Base):
    """A failed sign-in, kept briefly so lockouts work across replicas."""

    __tablename__ = "login_failures"
    id: IdCol = id_column()
    key: orm.Mapped[str] = orm.mapped_column(sa.String(320), index=True)  # "email:<addr>" or "ip:<addr>"
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, index=True)


class SyncCursor(Base):
    """Where a poller left off (e.g. GitHub issues per repo)."""

    __tablename__ = "sync_cursors"
    key: orm.Mapped[str] = orm.mapped_column(sa.String(300), primary_key=True)
    value: orm.Mapped[str] = orm.mapped_column(sa.String(100))
    updated_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, onupdate=utcnow)


class Steward(Base):
    __tablename__ = "stewards"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("teams.id", ondelete="CASCADE"), unique=True
    )
    name: orm.Mapped[str] = orm.mapped_column(sa.String(60))
    emoji: orm.Mapped[str] = orm.mapped_column(sa.String(16), default="🦉")
    level: orm.Mapped[int] = orm.mapped_column(default=1)
    paused: orm.Mapped[bool] = orm.mapped_column(default=False)
    duties: orm.Mapped[list] = orm.mapped_column(default=list)
    persona: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class LevelEvent(Base):
    __tablename__ = "level_events"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    from_level: orm.Mapped[int]
    to_level: orm.Mapped[int]
    reason: orm.Mapped[str] = orm.mapped_column(sa.Text)
    actor: orm.Mapped[str] = orm.mapped_column(sa.String(200))


class LevelSample(Base):
    """One human verdict on a steward draft. Drives promotion."""

    __tablename__ = "level_samples"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, index=True)
    action_kind: orm.Mapped[str] = orm.mapped_column(sa.String(60))
    outcome: orm.Mapped[str] = orm.mapped_column(sa.String(20))  # approved | edited | rejected | error


class Commitment(Base):
    __tablename__ = "commitments"
    __table_args__ = (
        sa.UniqueConstraint("org_id", "key", name="uq_commitments_org_key"),
        sa.UniqueConstraint("org_id", "source_ref", name="uq_commitments_org_source_ref"),
    )
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    key: orm.Mapped[str] = orm.mapped_column(sa.String(20))
    owner_team_id: orm.Mapped[str] = team_fk()
    requester_team_id: orm.Mapped[str | None] = team_fk(nullable=True)
    title: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    detail: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="proposed", index=True)
    priority: orm.Mapped[str] = orm.mapped_column(sa.String(10), default="normal")
    owner_person: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    requester_person: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    due_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    source_url: orm.Mapped[str | None] = orm.mapped_column(sa.String(500), nullable=True)
    source_kind: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="web")
    source_ref: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    label: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="internal")
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    updated_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, onupdate=utcnow)
    closed_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    last_nudged_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)

    events: orm.Mapped[list[CommitmentEvent]] = orm.relationship(
        back_populates="commitment", order_by="CommitmentEvent.at", cascade="all, delete-orphan"
    )


class CommitmentEvent(Base):
    __tablename__ = "commitment_events"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    commitment_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("commitments.id", ondelete="CASCADE"), index=True
    )
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    actor: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(40))
    text: orm.Mapped[str] = orm.mapped_column(sa.Text)
    commitment: orm.Mapped[Commitment] = orm.relationship(back_populates="events")


class InboxEvent(Base):
    """Every inbound event, deduplicated on (org, source, external_id) before any work happens."""

    __tablename__ = "inbox_events"
    __table_args__ = (sa.UniqueConstraint("org_id", "source", "external_id", name="uq_inbox_dedupe"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str | None] = team_fk(nullable=True)
    source: orm.Mapped[str] = orm.mapped_column(sa.String(20))
    external_id: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(60))
    payload: orm.Mapped[dict] = orm.mapped_column(default=dict)
    received_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    processed_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    outcome: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)


class Operation(Base):
    """An outgoing write. The row is the durable intent; dispatch may still repeat (see gateway)."""

    __tablename__ = "operations"
    __table_args__ = (sa.UniqueConstraint("org_id", "op_id", name="uq_operations_org_op_id"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    op_id: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(60))
    target: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    summary: orm.Mapped[str] = orm.mapped_column(sa.String(500))
    payload: orm.Mapped[dict] = orm.mapped_column(default=dict)
    label: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="internal")
    audience: orm.Mapped[str] = orm.mapped_column(sa.String(300), default="")
    idempotent: orm.Mapped[bool] = orm.mapped_column(default=False)
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), index=True)
    attempts: orm.Mapped[int] = orm.mapped_column(default=0)
    error_class: orm.Mapped[str | None] = orm.mapped_column(sa.String(40), nullable=True)
    error_line: orm.Mapped[str | None] = orm.mapped_column(sa.Text, nullable=True)
    remote_ref: orm.Mapped[str | None] = orm.mapped_column(sa.String(500), nullable=True)
    commitment_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("commitments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    updated_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, onupdate=utcnow)
    lease_until: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    next_attempt_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    # The message that led to this write, so a person's edit or rejection can become a lesson.
    context: orm.Mapped[str | None] = orm.mapped_column(sa.Text, nullable=True)


class Approval(Base):
    __tablename__ = "approvals"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    operation_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("operations.id", ondelete="CASCADE"), unique=True
    )
    title: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    preview: orm.Mapped[str] = orm.mapped_column(sa.Text)
    reason: orm.Mapped[str] = orm.mapped_column(sa.Text)
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="pending", index=True)
    decided_by: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    decided_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    operation: orm.Mapped[Operation] = orm.relationship()


class KnowledgeDoc(Base):
    __tablename__ = "knowledge_docs"
    __table_args__ = (sa.UniqueConstraint("team_id", "source", name="uq_knowledge_team_source"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    title: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    source: orm.Mapped[str] = orm.mapped_column(sa.String(500))
    label: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="internal")
    content: orm.Mapped[str] = orm.mapped_column(sa.Text)
    origin: orm.Mapped[str] = orm.mapped_column(
        sa.String(20), default="manual"
    )  # manual|file|url|github|slack
    source_url: orm.Mapped[str | None] = orm.mapped_column(sa.String(500), nullable=True)
    review_by: orm.Mapped[dt.date | None] = orm.mapped_column(sa.Date, nullable=True)
    sync_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("knowledge_sources.id", ondelete="CASCADE"), nullable=True, index=True
    )
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    updated_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, onupdate=utcnow)


class KnowledgeSource(Base):
    """A place Keel keeps a team's knowledge in sync with: a web page or a GitHub folder of Markdown."""

    __tablename__ = "knowledge_sources"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(20))  # url | github
    target: orm.Mapped[str] = orm.mapped_column(sa.String(500))
    label: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="internal")
    every_hours: orm.Mapped[int] = orm.mapped_column(default=24)
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="pending")  # pending | ok | error
    status_line: orm.Mapped[str] = orm.mapped_column(sa.String(300), default="Waiting for the first sync.")
    last_synced_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    next_sync_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True, index=True)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class Lesson(Base):
    """Something a team taught its steward: a corrected draft, a rejected one, a triage fix, or a rule."""

    __tablename__ = "lessons"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(20))  # reply | triage | rule
    situation: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    before: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    after: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    note: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    label: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="internal")
    source: orm.Mapped[str] = orm.mapped_column(sa.String(200), default="")
    author: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    active: orm.Mapped[bool] = orm.mapped_column(default=True, index=True)
    uses: orm.Mapped[int] = orm.mapped_column(default=0)
    last_used_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    updated_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, onupdate=utcnow)


class KnowledgeGap(Base):
    """A question the steward couldn't answer from the team's notes, and what people said since."""

    __tablename__ = "knowledge_gaps"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    question: orm.Mapped[str] = orm.mapped_column(sa.Text)
    asked_by: orm.Mapped[str] = orm.mapped_column(sa.String(200), default="")
    count: orm.Mapped[int] = orm.mapped_column(default=1)
    thread_ref: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True, index=True)
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="open", index=True)
    suggested_answer: orm.Mapped[str | None] = orm.mapped_column(sa.Text, nullable=True)
    suggested_by: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    doc_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("knowledge_docs.id", ondelete="SET NULL"), nullable=True
    )
    closed_by: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    last_asked_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    closed_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)


class Canary(Base):
    """A unique token planted in restricted knowledge. Seeing it in output to the wrong audience = leak."""

    __tablename__ = "canaries"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    token: orm.Mapped[str] = orm.mapped_column(sa.String(80), unique=True)
    doc_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("knowledge_docs.id", ondelete="CASCADE"), nullable=True
    )
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    tripped_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)


class Service(Base):
    __tablename__ = "services"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    name: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    url: orm.Mapped[str] = orm.mapped_column(sa.String(500))
    owner: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True)
    expect_status: orm.Mapped[int] = orm.mapped_column(default=200)
    interval_s: orm.Mapped[int] = orm.mapped_column(default=60)
    state: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="unknown")
    runbooks: orm.Mapped[list] = orm.mapped_column(default=list)  # [{id, name, min_level, command}]
    next_check_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class ServiceCheck(Base):
    __tablename__ = "service_checks"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    service_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("services.id", ondelete="CASCADE"), index=True
    )
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, index=True)
    ok: orm.Mapped[bool]
    latency_ms: orm.Mapped[int | None] = orm.mapped_column(nullable=True)
    status_code: orm.Mapped[int | None] = orm.mapped_column(nullable=True)
    error: orm.Mapped[str | None] = orm.mapped_column(sa.String(300), nullable=True)


class Incident(Base):
    __tablename__ = "incidents"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    service_id: orm.Mapped[str] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("services.id", ondelete="CASCADE"), index=True
    )
    opened_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    resolved_at: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    summary: orm.Mapped[str] = orm.mapped_column(sa.Text)
    commitment_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.String(32), sa.ForeignKey("commitments.id", ondelete="SET NULL"), nullable=True
    )


class Brief(Base):
    __tablename__ = "briefs"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(20))
    title: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    markdown: orm.Mapped[str] = orm.mapped_column(sa.Text)
    data: orm.Mapped[dict] = orm.mapped_column(default=dict)
    period: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="")  # e.g. 2026-11-26 or 2026-W48
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, index=True)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str] = team_fk()
    role: orm.Mapped[str] = orm.mapped_column(sa.String(10))
    text: orm.Mapped[str] = orm.mapped_column(sa.Text)
    user_id: orm.Mapped[str | None] = orm.mapped_column(sa.String(32), nullable=True)
    meta: orm.Mapped[dict] = orm.mapped_column(default=dict)
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, index=True)


class Activity(Base):
    """Human-readable feed. Integer id doubles as the SSE cursor."""

    __tablename__ = "activity"
    id: orm.Mapped[int] = orm.mapped_column(
        sa.BigInteger().with_variant(sa.Integer, "sqlite"), primary_key=True
    )
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str | None] = team_fk(nullable=True)
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(20))
    icon: orm.Mapped[str] = orm.mapped_column(sa.String(16))
    text: orm.Mapped[str] = orm.mapped_column(sa.Text)
    link: orm.Mapped[str | None] = orm.mapped_column(sa.String(300), nullable=True)


class AuditLog(Base):
    """Append-only record of who did what. Never updated or deleted by the app."""

    __tablename__ = "audit_log"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    team_id: orm.Mapped[str | None] = team_fk(nullable=True)
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, index=True)
    actor: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    action: orm.Mapped[str] = orm.mapped_column(sa.String(80))
    target: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    detail: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")


class Job(Base):
    """Work queue in the database (FOR UPDATE SKIP LOCKED on Postgres). No broker needed."""

    __tablename__ = "jobs"
    __table_args__ = (sa.Index("ix_jobs_ready", "status", "run_at"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(40))
    payload: orm.Mapped[dict] = orm.mapped_column(default=dict)
    dedupe_key: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True, unique=True)
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="queued")
    run_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
    attempts: orm.Mapped[int] = orm.mapped_column(default=0)
    locked_by: orm.Mapped[str | None] = orm.mapped_column(sa.String(100), nullable=True)
    lease_until: orm.Mapped[dt.datetime | None] = orm.mapped_column(nullable=True)
    last_error: orm.Mapped[str | None] = orm.mapped_column(sa.Text, nullable=True)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class Connection(Base):
    """A configured integration. Secrets are encrypted at rest with the instance key."""

    __tablename__ = "connections"
    __table_args__ = (sa.UniqueConstraint("org_id", "kind", name="uq_connections_org_kind"),)
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    kind: orm.Mapped[str] = orm.mapped_column(sa.String(20))  # model | slack | github
    config: orm.Mapped[dict] = orm.mapped_column(default=dict)
    secret_enc: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="ok")
    status_line: orm.Mapped[str] = orm.mapped_column(sa.Text, default="")
    updated_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow, onupdate=utcnow)


class Checkup(Base):
    __tablename__ = "checkups"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    repo: orm.Mapped[str] = orm.mapped_column(sa.String(200))
    status: orm.Mapped[str] = orm.mapped_column(sa.String(20), default="running")
    error_line: orm.Mapped[str | None] = orm.mapped_column(sa.Text, nullable=True)
    score: orm.Mapped[int | None] = orm.mapped_column(nullable=True)
    grade: orm.Mapped[str | None] = orm.mapped_column(sa.String(2), nullable=True)
    findings: orm.Mapped[list] = orm.mapped_column(default=list)
    stats: orm.Mapped[dict] = orm.mapped_column(default=dict)
    created_at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)


class SimRecord(Base):
    """What the demo's simulated Slack and GitHub received. Lets the demo run with no credentials."""

    __tablename__ = "sim_records"
    id: IdCol = id_column()
    org_id: orm.Mapped[str] = org_fk()
    system: orm.Mapped[str] = orm.mapped_column(sa.String(20))
    target: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    text: orm.Mapped[str] = orm.mapped_column(sa.Text)
    op_id: orm.Mapped[str | None] = orm.mapped_column(sa.String(200), nullable=True, index=True)
    ref: orm.Mapped[str] = orm.mapped_column(sa.String(300))
    at: orm.Mapped[dt.datetime] = orm.mapped_column(default=utcnow)
