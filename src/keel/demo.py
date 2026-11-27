"""``keel demo``: a believable company with three teams, no credentials, and a scripted story to play.

Everything outbound goes to the simulator (:mod:`keel.connectors.sim`), so nothing leaves the machine.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import random

import sqlalchemy as sa
from sqlalchemy import orm

from keel import (
    auth_utils,
    feed,
    gateway,
    inbox,
    knowledge,
    learning,
    ledger,
    models,
    rhythm,
    services,
    steward,
)

DEMO_ORG = "Acme"
DEMO_ADMIN_EMAIL = "avery@acme.example"
DEMO_SEQ_START = 87  # So the story's headline item is C-88, like a company that has used Keel for a while.
HISTORY_CHECKS = 60  # Past checks per service so sparklines are full on first open.
HISTORY_CHECK_SPACING = dt.timedelta(minutes=1)
CANARY_TOKEN = "kc-7f3a-payments-postmortem"  # Planted in a restricted doc; it must never leave Payments.
RNG_SEED = 7  # Same demo every time.

TEAMS = [
    # slug, name, color, steward, emoji, level, channel, members, repo, tz
    (
        "payments",
        "Payments",
        "#7C5CFF",
        "Pip",
        "🦉",
        2,
        "#payments",
        14,
        "acme/payments-api",
        "America/Los_Angeles",
    ),
    ("platform", "Platform", "#10B981", "Bolt", "🦫", 3, "#platform", 9, "acme/platform", "America/New_York"),
    ("mobile", "Mobile", "#F59E0B", "Echo", "🐙", 1, "#mobile", 11, "acme/mobile-app", "Europe/London"),
]
PEOPLE = {
    "payments": ["Maya Patel", "Jonas Berg", "Lena Ortiz"],
    "platform": ["Sam Okafor", "Iris Chen", "Theo Walsh"],
    "mobile": ["Ravi Kumar", "Nora Lind", "Kai Tanaka"],
}
# slug, title, owner, age (days), closed (days ago), due (days from now; negative is past), asking team
HISTORY = [
    ("payments", "Retry failed payouts with backoff", "Maya Patel", 27, 24, -23, None),
    ("payments", "Add 3DS fallback for EU cards", "Lena Ortiz", 25, 19, -18, "mobile"),
    ("payments", "Alert on webhook signature failures", "Jonas Berg", 21, 17.5, -16, "platform"),
    ("payments", "Document the refund states", "Lena Ortiz", 16, 12, -11, None),
    ("payments", "Fix duplicate receipt emails", "Maya Patel", 13, 12.8, -12, "mobile"),
    ("payments", "Archive 2025 dispute evidence", "Jonas Berg", 10, 6, -5, None),
    ("platform", "Bump Node base image to 22", "Sam Okafor", 28, 22, -21, "payments"),
    ("platform", "Grant Mobile a staging namespace", "Theo Walsh", 24, 23.6, -23, "mobile"),
    ("platform", "Rotate the shared Redis password", "Iris Chen", 20, 14, -13, "payments"),
    ("platform", "Speed up the docker layer cache", "Theo Walsh", 18, 9, -12, None),
    ("platform", "Add a read replica for reporting", "Sam Okafor", 15, 7, -6, "mobile"),
    ("platform", "Turn on audit logs for the CI bot", "Iris Chen", 11, 5, -4, "payments"),
    ("mobile", "Hotfix: login loop on iOS 19", "Ravi Kumar", 26, 25.97, -25, None),
    ("mobile", "Ship the Apple Pay button", "Nora Lind", 22, 15, -14, None),
    ("mobile", "Translate checkout into Japanese", "Kai Tanaka", 17, 8, -10, None),
    ("mobile", "Answer Platform's push-token question", "Ravi Kumar", 9, 8.96, -8, "platform"),
]
ALL_DUTIES = ["ledger", "front_desk", "rhythm", "services", "knowledge", "chores"]

DOCS = {
    "payments": [
        (
            "Runbook: refunds",
            "internal",
            """Refunds go through the refunds worker. If refunds stall, check the
queue depth on the payments dashboard first.

To retry a stuck refund batch, run the retry-refunds runbook. It is safe to run twice: refunds are keyed by
refund_id, so a repeat is ignored by the processor.

Escalate to the on-call (rotation in PagerDuty: payments-primary) when more than 50 refunds are stuck for
over 30 minutes.""",
        ),
        (
            "Webhook signing",
            "internal",
            """Outgoing webhooks are signed with HMAC-SHA256. The signing secret lives in
the secrets service under payments/webhook-signing.

Rotation: create the new secret, enable dual-signing for 7 days so merchants can switch, then retire the old
one. Platform owns the secrets API; Payments owns the rotation schedule.

Merchants verify with the Keel-Signature header. Docs: developers.acme.example/webhooks.""",
        ),
        (
            "On-call handbook",
            "internal",
            """Payments on-call is a weekly rotation starting Monday 10:00 Pacific.
Acknowledge pages within 5 minutes. checkout-api has priority over everything else.

First steps for checkout-api 5xx: check the deploy log, then the database connection pool, then roll back
the last deploy if errors started right after it.""",
        ),
        (
            "Postmortem: October double charges",
            "restricted",
            f"""Restricted: legal review pending.

On Oct 14 a retry storm caused 212 double charges totalling $18,400. Root cause: the card processor timed
out after committing, and our client retried without an idempotency key. Fix: idempotency keys on every
charge call. Reference {CANARY_TOKEN}. Do not share outside Payments until legal signs off.""",
        ),
    ],
    "platform": [
        (
            "Deploy guide",
            "internal",
            """All services deploy through the deploy-api. Merge to main triggers a
canary at 5% for 15 minutes, then a full rollout if error rate stays under 1%.

Rollback: run the rollback runbook for the service, or click Roll back in the deploy dashboard.""",
        ),
        (
            "Secrets API v2",
            "internal",
            """Secrets API v2 adds versioned secrets and dual-read for rotation.
Teams should migrate by December 12; v1 goes read-only after that.

Migration: switch the client to secrets-v2, then call rotate() with dual_window_days.""",
        ),
    ],
    "mobile": [
        (
            "Release process",
            "internal",
            """Mobile releases every second Tuesday. Code freeze is the Thursday
before. Release notes are due the Monday before release and go to #mobile-releases.

Hotfixes need a Platform reviewer when they touch auth.""",
        ),
    ],
}

SERVICES = {
    "payments": [
        (
            "checkout-api",
            "Maya Patel",
            [
                {
                    "id": "restart",
                    "name": "Restart pods",
                    "min_level": 4,
                    "command": "kubectl rollout restart deploy/checkout-api",
                },
                {
                    "id": "rollback",
                    "name": "Roll back last deploy",
                    "min_level": 4,
                    "command": "deployctl rollback checkout-api",
                },
            ],
        ),
        (
            "webhooks",
            "Jonas Berg",
            [
                {
                    "id": "retry",
                    "name": "Retry failed webhooks",
                    "min_level": 4,
                    "command": "webhookctl retry --failed --since 1h",
                }
            ],
        ),
    ],
    "platform": [
        (
            "auth",
            "Sam Okafor",
            [
                {
                    "id": "restart",
                    "name": "Restart pods",
                    "min_level": 4,
                    "command": "kubectl rollout restart deploy/auth",
                }
            ],
        ),
        ("deploy-api", "Iris Chen", []),
    ],
    "mobile": [
        (
            "push-gateway",
            "Kai Tanaka",
            [{"id": "drain", "name": "Drain the push queue", "min_level": 4, "command": "pushctl drain"}],
        )
    ],
}


def _days(n: float) -> dt.timedelta:
    return dt.timedelta(days=n)


def seed(session: orm.Session, now: dt.datetime | None = None) -> models.Org:
    """Create the demo org. Returns the existing one if already seeded."""
    existing = session.scalar(sa.select(models.Org).where(models.Org.name == DEMO_ORG))
    if existing is not None and existing.settings.get("demo"):
        return existing
    now = now or models.utcnow()
    rng = random.Random(RNG_SEED)
    org = models.Org(
        name=DEMO_ORG,
        commitment_seq=DEMO_SEQ_START,
        settings={
            "demo": True,
            "demo_step": 0,
            "setup_complete": True,
            "sim_services": {},
            "default_level": 1,
            "label_default": "internal",
        },
    )
    session.add(org)
    session.flush()
    admin = models.User(
        org_id=org.id,
        email=DEMO_ADMIN_EMAIL,
        name="Avery Chen",
        role="org_admin",
        password_hash=auth_utils.hash_password("demo"),
    )
    session.add(admin)
    teams: dict[str, models.Team] = {}
    for slug, name, color, st_name, emoji, level, channel, members, repo, tz in TEAMS:
        team = models.Team(
            org_id=org.id,
            slug=slug,
            name=name,
            color=color,
            slack_channel_id=f"sim-{slug}",
            slack_channel_name=channel,
            slack_member_count=members,
            github_repos=[repo],
            timezone=tz,
            created_at=now - _days(60),
        )
        session.add(team)
        session.flush()
        teams[slug] = team
        session.add(
            models.Steward(
                org_id=org.id,
                team_id=team.id,
                name=st_name,
                emoji=emoji,
                level=level,
                duties=ALL_DUTIES,
                created_at=now - _days(60),
            )
        )
        session.add(models.TeamMember(team_id=team.id, user_id=admin.id, role="team_admin"))
        for i, person in enumerate(PEOPLE[slug]):
            u = models.User(org_id=org.id, email=f"{person.split()[0].lower()}@acme.example", name=person)
            session.add(u)
            session.flush()
            session.add(
                models.TeamMember(team_id=team.id, user_id=u.id, role="team_admin" if i == 0 else "member")
            )
        # Level history: started at L1, earned its way up.
        for lv in range(1, level):
            session.add(
                models.LevelEvent(
                    org_id=org.id,
                    team_id=team.id,
                    at=now - _days(45 - lv * 12),
                    from_level=lv,
                    to_level=lv + 1,
                    actor="user:avery@acme.example",
                    reason=f"Promoted after {50 + lv * 7} approvals at {96 + lv}% unedited.",
                )
            )
        # Approval samples: Payments is close to earning L3.
        n_samples = {"payments": 47, "platform": 64, "mobile": 18}[slug]
        for i in range(n_samples):
            outcome = "rejected" if i % 29 == 3 else ("edited" if i % 17 == 5 else "approved")
            session.add(
                models.LevelSample(
                    org_id=org.id,
                    team_id=team.id,
                    at=now - _days(rng.uniform(0.2, 28)),
                    action_kind=rng.choice(["slack.post_team", "slack.reply_thread", "github.comment"]),
                    outcome=outcome,
                )
            )
    session.flush()
    pay, plat, mob = teams["payments"], teams["platform"], teams["mobile"]

    def c(
        team: models.Team,
        title: str,
        *,
        due: float | None,
        status: str = "accepted",
        owner: str | None = None,
        requester: models.Team | None = None,
        priority: str = "normal",
        age: float = 5,
        source: str = "slack",
        closed: float | None = None,
    ) -> models.Commitment:
        row = ledger.create(
            session,
            team=team,
            title=title,
            actor="demo",
            due_at=now + _days(due) if due is not None else None,
            owner_person=owner,
            requester_team=requester,
            priority=priority,
            status=status,
            source_kind=source,
            source_url=f"https://acme.slack.example/archives/{team.slug}/p{rng.randint(10**9, 10**10)}",
            requester_person=PEOPLE[requester.slug][1] if requester else None,
            steward_name=next(t[3] for t in TEAMS if t[0] == team.slug),
        )
        row.created_at = row.updated_at = now - _days(age)
        if closed is not None:
            row.closed_at = now - _days(closed)
        return row

    # The headline item, C-88: Platform asked Payments to rotate the signing secret; due in a day, not started.
    c88 = c(
        pay,
        "Rotate webhook signing secret",
        due=1.1,
        status="accepted",
        requester=plat,
        priority="high",
        owner="Jonas Berg",
        age=6,
    )
    ledger.add_event(
        session, c88, "Bolt", "note", "Platform needs this before the secrets v1 read-only date (Dec 12)."
    )
    c(
        pay,
        "Add idempotency keys to every charge call",
        due=6,
        status="in_progress",
        owner="Maya Patel",
        priority="high",
        age=9,
    )
    c(pay, "Ship refunds dashboard v2", due=-1.2, owner="Lena Ortiz", age=12)
    c(pay, "Answer Mobile: Apple Pay token format", due=3, status="proposed", requester=mob, age=1)
    c(pay, "Upgrade Stripe SDK to v14", due=9, owner="Jonas Berg", priority="low", age=4)
    c(pay, "Quarterly PCI evidence pack", due=None, status="blocked", owner="Maya Patel", age=16)
    for title, closed in (
        ("Fix currency rounding in invoices", 0.4),
        ("Move payouts cron to the job queue", 2.5),
    ):
        c(pay, title, due=-closed, status="done", owner="Jonas Berg", age=8, closed=closed)
    c(plat, "Secrets API v2 migration guide", due=2, status="in_progress", owner="Iris Chen", age=6)
    c(
        plat,
        "Raise auth rate limit for mobile login",
        due=1,
        status="accepted",
        requester=mob,
        owner="Sam Okafor",
        age=2,
    )
    c(plat, "Postgres 16 upgrade for shared cluster", due=14, owner="Theo Walsh", priority="high", age=10)
    c(plat, "Deprecate deploy-api v1 endpoints", due=-3, status="in_progress", owner="Iris Chen", age=20)
    c(plat, "Cut CI time under 10 minutes", due=None, status="done", owner="Theo Walsh", age=15, closed=1.2)
    c(mob, "Release notes for 4.2", due=4, owner="Nora Lind", age=3)
    c(
        mob,
        "Crash on Android 15 login screen",
        due=0.6,
        status="in_progress",
        owner="Ravi Kumar",
        priority="urgent",
        age=1,
    )
    c(mob, "Dark mode for receipts", due=20, status="proposed", owner="Kai Tanaka", priority="low", age=7)
    c(plat, "Review Payments' rotation plan", due=2, status="proposed", requester=pay, age=0.5)

    # A month of closed work so Team Wrapped has a story: Payments lands everything on time, Platform mostly
    # serves other teams, Mobile closes some asks within the hour.
    by_slug = {"payments": pay, "platform": plat, "mobile": mob}
    for slug, title, owner, age, closed, due, asker in HISTORY:
        c(
            by_slug[slug],
            title,
            due=due,
            status="done",
            owner=owner,
            age=age,
            closed=closed,
            requester=by_slug[asker] if asker else None,
        )

    for slug, docs in DOCS.items():
        for title, label, content in docs:
            doc = knowledge.add(session, teams[slug], title, content, label=label, actor="demo")
            doc.updated_at = now - _days(rng.uniform(1, 30))
            if CANARY_TOKEN in content:
                session.add(
                    models.Canary(org_id=org.id, team_id=teams[slug].id, token=CANARY_TOKEN, doc_id=doc.id)
                )

    for slug, svcs in SERVICES.items():
        for name, owner, runbooks in svcs:
            svc = services.add(session, teams[slug], name, f"sim://{name}", owner=owner, runbooks=runbooks)
            for i in range(HISTORY_CHECKS):
                slow = rng.random() < 0.05
                session.add(
                    models.ServiceCheck(
                        org_id=org.id,
                        service_id=svc.id,
                        ok=True,
                        at=now - HISTORY_CHECK_SPACING * (HISTORY_CHECKS - i),
                        latency_ms=rng.randint(380, 700) if slow else rng.randint(35, 120),
                        status_code=200,
                    )
                )
            svc.state = "up"

    # A past operation that needed a person: a GitHub comment whose response was lost, never found.
    session.add(
        models.Operation(
            org_id=org.id,
            team_id=plat.id,
            op_id="c-91:comment-pr-2207",
            kind="github.comment",
            target="acme/platform#2207",
            summary="Comment on acme/platform#2207: canary metrics look good",
            payload={"body": "Canary metrics look good."},
            status="needs_review",
            attempts=1,
            error_class="unknown_outcome",
            created_by="steward",
            error_line="Keel couldn't tell if this went through: GitHub returned 502 and the comment list timed out. Check, then mark it done or retry.",
            created_at=now - _days(0.3),
        )
    )
    for team, text in (
        (mob, "Nora, the 4.2 release notes are due Monday. Want me to start a draft from merged PRs?"),
        (mob, "Heads up #mobile: the Android 15 login crash is marked urgent and due today."),
    ):
        steward.say(
            session, team, text, op_id=f"seed:{team.slug}:{hashlib.sha1(text.encode()).hexdigest()[:8]}"
        )
    session.add_all(
        [
            models.ChatMessage(
                org_id=org.id,
                team_id=pay.id,
                role="user",
                text="What's at risk this week?",
                user_id=admin.id,
                at=now - _days(0.2),
            ),
            models.ChatMessage(
                org_id=org.id,
                team_id=pay.id,
                role="steward",
                at=now - _days(0.2) + dt.timedelta(seconds=3),
                text="Two things: C-88 Rotate webhook signing secret is due tomorrow and hasn't started, and "
                "refunds dashboard v2 is a day overdue. Want me to nudge Jonas and Lena?",
                meta={"sources": [], "actions": []},
            ),
        ]
    )
    session.flush()
    _seed_learning(session, teams, now)
    for team in teams.values():
        rhythm.make_brief(session, team, "daily", post=False, now=now)
    feed.audit(session, org.id, "keel", "demo.seeded", DEMO_ORG)
    return org


# slug, kind, author, days ago, uses, fields
LESSONS: list[tuple[str, str, str, float, int, dict[str, str]]] = [
    (
        "payments",
        "rule",
        "Maya Patel",
        12,
        64,
        {"note": "Tag @payments-oncall on anything about webhooks or payouts."},
    ),
    (
        "payments",
        "rule",
        "Jonas Berg",
        5,
        23,
        {"note": "Keep channel replies to two sentences. Link the runbook instead of pasting it."},
    ),
    (
        "payments",
        "reply",
        "Maya Patel",
        3,
        6,
        {
            "situation": "@Pip when does the PCI scan window open?",
            "before": "The PCI scan window opens next Monday at 9am PT. Let me know if you need anything else!",
            "after": "PCI scan window: Mon 9:00 PT. Steps in [Runbook: PCI scan].",
        },
    ),
    (
        "payments",
        "triage",
        "Lena Ortiz",
        2,
        2,
        {
            "situation": "lol I'll fix the coffee machine by Friday",
            "before": "Logged as work: Fix the coffee machine",
            "after": learning.NOT_WORK,
            "note": "a joke",
        },
    ),
    (
        "payments",
        "triage",
        "Jonas Berg",
        1,
        1,
        {
            "situation": "we'll have the payout retry fix out by EOW",
            "before": "Logged: Ship payout retry fix",
            "after": "due Fri (I had Sun)",
        },
    ),
    (
        "payments",
        "reply",
        "Lena Ortiz",
        0.5,
        0,
        {
            "situation": "@Pip can you post this week's refund numbers for finance?",
            "before": "Refunds this week: 412 for $38,910, up 6% on last week.",
            "note": "Finance numbers go to Lena first, never straight to the channel.",
        },
    ),
    (
        "platform",
        "rule",
        "Sam Okafor",
        9,
        31,
        {"note": "Always include the Grafana link when talking about latency."},
    ),
]
# slug, question, asked by, times asked, days ago, suggested answer, suggested by
GAPS: list[tuple[str, str, str, int, float, str | None, str | None]] = [
    ("payments", "How do we rotate the Adyen API key?", "Jonas Berg", 3, 0.4, None, None),
    (
        "payments",
        "Who approves refunds over $10k?",
        "Ravi Kumar",
        2,
        1.2,
        "Refunds over $10k need sign-off from Maya or Lena. Post the ticket in #payments-approvals and tag "
        "both of us; one approval is enough.",
        "Lena Ortiz",
    ),
    ("platform", "What's the max replica count for the API pods?", "Kai Tanaka", 1, 2.5, None, None),
]


def _seed_learning(session: orm.Session, teams: dict[str, models.Team], now: dt.datetime) -> None:
    """Lessons and open questions, so the Learning tab tells a story on first open."""
    for slug, kind, author, ago, uses, fields in LESSONS:
        source = {"rule": "teach", "triage": "commitment:demo"}.get(kind, "approval:demo")
        r = learning.add_lesson(session, teams[slug], kind=kind, author=author, source=source, **fields)
        r.created_at = r.updated_at = now - _days(ago)
        r.uses = uses
        r.last_used_at = now - _days(min(ago, 0.1)) if uses else None
    for slug, question, by, count, ago, answer, answered_by in GAPS:
        g = learning.log_gap(session, teams[slug], question, asked_by=by)
        g.count, g.created_at, g.last_asked_at = count, now - _days(ago + 3), now - _days(ago)
        if answer:
            g.suggested_answer, g.suggested_by, g.status = answer, answered_by, "suggested"


# ---------------------------------------------------------------- the scripted story


def _inbox(
    session: orm.Session,
    org: models.Org,
    team: models.Team,
    text: str,
    user: str,
    directed: bool = True,
    *,
    ts: str | None = None,
    thread_ts: str | None = None,
) -> None:
    ts = ts or f"{models.utcnow().timestamp():.6f}"
    inbox.record(
        session,
        org.id,
        team.id,
        "slack",
        f"demo-{org.settings.get('demo_step', 0)}-{team.slug}",
        "message",
        {
            "text": text,
            "user_name": user,
            "channel": f"sim-{team.slug}",
            "ts": ts,
            "thread_ts": thread_ts or ts,
            "directed": directed,
            "permalink": f"https://acme.slack.example/archives/{team.slug}",
        },
    )


def _set_service(session: orm.Session, org: models.Org, name: str, state: str, checks: int) -> None:
    org.settings = {**org.settings, "sim_services": {**org.settings.get("sim_services", {}), name: state}}
    session.flush()
    svc = session.scalar(
        sa.select(models.Service).where(models.Service.org_id == org.id, models.Service.name == name)
    )
    if svc is None:
        return
    for _ in range(checks):
        services.check(session, svc)


def _team(session: orm.Session, org: models.Org, slug: str) -> models.Team:
    team = session.scalar(
        sa.select(models.Team).where(models.Team.org_id == org.id, models.Team.slug == slug)
    )
    assert team is not None
    return team


def _step_request(s: orm.Session, org: models.Org) -> None:
    _inbox(
        s,
        org,
        _team(s, org, "payments"),
        "@Pip can someone add retry with backoff to the payouts webhook consumer by Friday?",
        "Lena Ortiz",
    )


def _step_promise(s: orm.Session, org: models.Org) -> None:
    _inbox(s, org, _team(s, org, "mobile"), "I'll ship the 4.2 release notes tomorrow", "Nora Lind")


def _step_outage(s: orm.Session, org: models.Org) -> None:
    _set_service(s, org, "checkout-api", "down", services.FAILURES_BEFORE_INCIDENT)


def _step_crossteam(s: orm.Session, org: models.Org) -> None:
    steward.ask_team(
        s,
        _team(s, org, "platform"),
        "payments",
        "Migrate webhook signing to Secrets API v2",
        op_id="demo:ask-payments-secrets-v2",
        due_at=models.utcnow() + _days(10),
        detail="v1 goes read-only on Dec 12.",
        requester_person="Sam Okafor",
    )


def _step_lost_response(s: orm.Session, org: models.Org) -> None:
    plat = _team(s, org, "platform")
    gateway.propose(
        s,
        gateway.Proposal(
            team=plat,
            kind="github.create_issue",
            target="acme/platform",
            op_id="demo:issue-secrets-v1-readonly",
            payload={
                "repo": "acme/platform",
                "title": "Secrets v1 goes read-only Dec 12: track team migrations",
                "body": "Tracking issue for teams still on Secrets API v1.",
                "_sim_fault": "503_after_commit",
            },
            summary="Open an issue in acme/platform: track Secrets v1 migrations",
            audience_kind="org",
            audience="acme/platform (org members)",
            idempotent=False,
        ),
    )


def _step_recover(s: orm.Session, org: models.Org) -> None:
    _set_service(s, org, "checkout-api", "up", 1)


def _step_done(s: orm.Session, org: models.Org) -> None:
    _inbox(
        s,
        org,
        _team(s, org, "payments"),
        "C-88 is done: new signing secret is live with dual-signing on",
        "Jonas Berg",
    )


def _step_leak(s: orm.Session, org: models.Org) -> None:
    steward.say(
        s,
        _team(s, org, "mobile"),
        f"FYI from the payments postmortem: {CANARY_TOKEN}: 212 double charges in October.",
        op_id="demo:leak-attempt",
    )


OPEN_QUESTION_TS = "1764300000.000100"  # Fixed, so the next step can reply in the same thread.


def _step_open_question(s: orm.Session, org: models.Org) -> None:
    _inbox(
        s,
        org,
        _team(s, org, "payments"),
        "@Pip what's our SLA for Klarna disputes?",
        "Theo Walsh",
        ts=OPEN_QUESTION_TS,
    )


def _step_thread_answer(s: orm.Session, org: models.Org) -> None:
    _inbox(
        s,
        org,
        _team(s, org, "payments"),
        "Klarna disputes get a first reply within 2 business days. Lena owns the queue in Zendesk.",
        "Lena Ortiz",
        directed=False,
        ts=f"{float(OPEN_QUESTION_TS) + 60:.6f}",
        thread_ts=OPEN_QUESTION_TS,
    )


def _step_brief(s: orm.Session, org: models.Org) -> None:
    for slug in ("payments", "platform", "mobile"):
        rhythm.make_brief(s, _team(s, org, slug), "daily", post=False)


STEPS = [
    ("A request in #payments becomes a commitment", _step_request),
    ("A promise in #mobile: Echo (L1) drafts the reply for approval", _step_promise),
    ("checkout-api goes down: incident and urgent commitment", _step_outage),
    ("Platform's steward asks Payments for work", _step_crossteam),
    ("GitHub write whose response is lost: Keel reconciles before retrying", _step_lost_response),
    ("checkout-api recovers: the incident closes itself", _step_recover),
    ("Jonas says C-88 is done in Slack", _step_done),
    ("A leak attempt: restricted text blocked by a canary", _step_leak),
    ("Pip can't answer from the notes, so it logs an open question", _step_open_question),
    ("Lena answers in the thread: Pip suggests saving it to knowledge", _step_thread_answer),
    ("Fresh daily briefs", _step_brief),
]


def tick(session: orm.Session, org: models.Org) -> str | None:
    """Play the next scripted step. Returns its title, or None when the story is over."""
    step = int(org.settings.get("demo_step", 0))
    if step >= len(STEPS):
        return None
    title, fn = STEPS[step]
    fn(session, org)
    org.settings = {**org.settings, "demo_step": step + 1}
    session.flush()
    return title
