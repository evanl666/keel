"""Services: health checks, incidents, and runbooks (L4, through the outbound runner).

Demo services use ``sim://<name>`` URLs; their state comes from the org's ``sim_services`` setting.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import statistics
import time

import httpx
import sqlalchemy as sa
from sqlalchemy import orm

from keel import feed, gateway, ledger, models, steward

FAILURES_BEFORE_INCIDENT = 3  # Three misses in a row: one blip isn't an incident, three minutes down is.
CHECK_TIMEOUT_S = 10.0  # Longer than any healthy health endpoint; short enough to keep the loop moving.
DEGRADED_LATENCY_MS = 1500  # Slower than this but up counts as degraded.
CHECKS_SHOWN = 60  # Sparkline length in the UI.
UPTIME_WINDOW = dt.timedelta(hours=24)
MIN_INTERVAL_S = 15  # Floor on check frequency, so a typo can't hammer someone's endpoint.


def _sim_check(session: orm.Session, svc: models.Service) -> tuple[bool, int | None, int | None, str | None]:
    org = session.get(models.Org, svc.org_id)
    state = (org.settings.get("sim_services", {}) if org else {}).get(svc.name, "up")
    # Stable pseudo-random latency so the sparkline looks alive but tests stay deterministic.
    jitter = int(hashlib.sha256(f"{svc.id}{models.utcnow():%H%M}".encode()).hexdigest()[:4], 16) % 60
    if state == "down":
        return False, None, 503, "503 Service Unavailable"
    if state == "slow":
        return True, DEGRADED_LATENCY_MS + 300 + jitter, 200, None
    return True, 40 + jitter, 200, None


def probe(session: orm.Session, svc: models.Service) -> tuple[bool, int | None, int | None, str | None]:
    """Run one check. Returns (ok, latency_ms, status_code, error_line)."""
    if svc.url.startswith("sim://"):
        return _sim_check(session, svc)
    start = time.perf_counter()
    try:
        resp = httpx.get(svc.url, timeout=CHECK_TIMEOUT_S, follow_redirects=True)
    except httpx.TimeoutException:
        return False, None, None, f"No answer within {CHECK_TIMEOUT_S:.0f} s."
    except httpx.HTTPError as exc:
        return False, None, None, f"Couldn't connect ({type(exc).__name__})."
    latency = int((time.perf_counter() - start) * 1000)
    ok = resp.status_code == svc.expect_status
    return (
        ok,
        latency,
        resp.status_code,
        None if ok else f"Got {resp.status_code}, expected {svc.expect_status}.",
    )


def check(session: orm.Session, svc: models.Service, now: dt.datetime | None = None) -> models.ServiceCheck:
    """Check a service, update its state, and open or close an incident."""
    now = now or models.utcnow()
    ok, latency, code, err = probe(session, svc)
    row = models.ServiceCheck(
        org_id=svc.org_id, service_id=svc.id, at=now, ok=ok, latency_ms=latency, status_code=code, error=err
    )
    session.add(row)
    session.flush()
    team = session.get(models.Team, svc.team_id)
    feed.SERVICE_UP.labels(team=team.slug if team else "", service=svc.name).set(1 if ok else 0)
    svc.next_check_at = now + dt.timedelta(seconds=max(svc.interval_s, MIN_INTERVAL_S))
    recent = list(
        session.scalars(
            sa.select(models.ServiceCheck.ok)
            .where(models.ServiceCheck.service_id == svc.id)
            .order_by(models.ServiceCheck.at.desc())
            .limit(FAILURES_BEFORE_INCIDENT)
        )
    )
    incident = open_incident(session, svc)
    old = svc.state
    if ok:
        svc.state = "degraded" if latency and latency > DEGRADED_LATENCY_MS else "up"
        if incident is not None:
            _resolve(session, svc, incident, team, now)
    elif len(recent) >= FAILURES_BEFORE_INCIDENT and not any(recent):
        svc.state = "down"
        if incident is None:
            _open(session, svc, team, err or "Health check failing", now)
    else:
        svc.state = "degraded" if old in ("up", "degraded") else old
    return row


def open_incident(session: orm.Session, svc: models.Service) -> models.Incident | None:
    """The service's unresolved incident, if any."""
    return session.scalar(
        sa.select(models.Incident).where(
            models.Incident.service_id == svc.id, models.Incident.resolved_at.is_(None)
        )
    )


def _open(
    session: orm.Session, svc: models.Service, team: models.Team | None, why: str, now: dt.datetime
) -> None:
    if team is None:
        return
    st = gateway.steward_for(session, team.id)
    summary = f"{svc.name} is down: {why}"
    inc = models.Incident(
        org_id=svc.org_id, team_id=team.id, service_id=svc.id, opened_at=now, summary=summary
    )
    session.add(inc)
    session.flush()
    c = ledger.create(
        session,
        team=team,
        title=f"Restore {svc.name}",
        detail=summary,
        priority="urgent",
        owner_person=svc.owner,
        status="accepted",
        source_kind="service",
        source_ref=f"incident:{inc.id}",
        actor=st.name,
        steward_name=st.name,
        due_at=now + dt.timedelta(hours=4),
    )
    inc.commitment_id = c.id
    feed.activity(
        session,
        svc.org_id,
        team.id,
        "service",
        "🔴",
        f"{svc.name} is down. {st.name} opened {c.key}.",
        f"/teams/{team.slug}/services",
    )
    runbooks = ", ".join(r["name"] for r in svc.runbooks) or "none"
    text = (
        f"🔴 {svc.name} is down ({why}). Logged {c.key}."
        + (f" Owner: {svc.owner}." if svc.owner else "")
        + f" Runbooks: {runbooks}."
    )
    steward.say(session, team, text, op_id=f"incident:{inc.id}:open", commitment=c)


def _resolve(
    session: orm.Session,
    svc: models.Service,
    inc: models.Incident,
    team: models.Team | None,
    now: dt.datetime,
) -> None:
    inc.resolved_at = now
    minutes = max(1, int((now - inc.opened_at).total_seconds() // 60))
    if team is None:
        return
    st = gateway.steward_for(session, team.id)
    c = session.get(models.Commitment, inc.commitment_id) if inc.commitment_id else None
    if c is not None and c.status in ledger.OPEN_STATUSES:
        ledger.update(session, c, st.name, status="done", note=f"{svc.name} recovered after {minutes} min.")
    feed.activity(
        session,
        svc.org_id,
        team.id,
        "service",
        "🟢",
        f"{svc.name} is back after {minutes} min.",
        f"/teams/{team.slug}/services",
    )
    steward.say(
        session,
        team,
        f"🟢 {svc.name} is back after {minutes} min." + (f" Closed {c.key}." if c else ""),
        op_id=f"incident:{inc.id}:resolved",
        commitment=c,
    )


def stats(session: orm.Session, svc: models.Service, now: dt.datetime | None = None) -> dict:
    """Uptime, median latency and recent checks for the UI."""
    now = now or models.utcnow()
    day = list(
        session.scalars(
            sa.select(models.ServiceCheck).where(
                models.ServiceCheck.service_id == svc.id, models.ServiceCheck.at >= now - UPTIME_WINDOW
            )
        )
    )
    latencies = [c.latency_ms for c in day if c.latency_ms is not None]
    recent = list(
        session.scalars(
            sa.select(models.ServiceCheck)
            .where(models.ServiceCheck.service_id == svc.id)
            .order_by(models.ServiceCheck.at.desc())
            .limit(CHECKS_SHOWN)
        )
    )[::-1]
    return {
        "uptime_24h": (sum(c.ok for c in day) / len(day)) if day else None,
        "latency_p50_ms": int(statistics.median(latencies)) if latencies else None,
        "checks": recent,
    }


def add(
    session: orm.Session,
    team: models.Team,
    name: str,
    url: str,
    owner: str | None = None,
    runbooks: list[dict] | None = None,
    interval_s: int = 60,
) -> models.Service:
    """Register a service to watch."""
    if not name.strip():
        raise ValueError("A service needs a name.")
    if not url.startswith(("http://", "https://", "sim://")):
        raise ValueError("The URL must start with http:// or https://.")
    svc = models.Service(
        org_id=team.org_id,
        team_id=team.id,
        name=name.strip(),
        url=url,
        owner=owner,
        runbooks=runbooks or [],
        interval_s=max(interval_s, MIN_INTERVAL_S),
        next_check_at=models.utcnow(),
    )
    session.add(svc)
    session.flush()
    feed.activity(
        session,
        team.org_id,
        team.id,
        "service",
        "🩺",
        f"Now watching {svc.name} for {team.name}",
        f"/teams/{team.slug}/services",
    )
    return svc


def run_runbook(session: orm.Session, svc: models.Service, runbook_id: str, actor: str) -> models.Operation:
    """Propose a runbook run. Below L4 it waits for approval; the runner executes it."""
    rb = next((r for r in svc.runbooks if r.get("id") == runbook_id), None)
    if rb is None:
        raise ValueError(f"{svc.name} has no runbook {runbook_id}.")
    team = session.get(models.Team, svc.team_id)
    assert team is not None
    inc = open_incident(session, svc)
    c = session.get(models.Commitment, inc.commitment_id) if inc and inc.commitment_id else None
    return gateway.propose(
        session,
        gateway.Proposal(
            team=team,
            kind="runbook.run",
            target=f"svc:{svc.name}:{rb['id']}",
            payload={
                "service": svc.name,
                "runbook": rb["id"],
                "command": rb.get("command", rb["id"]),
                "text": f"Run {rb['name']} on {svc.name}",
            },
            summary=f"Run {rb['name']} on {svc.name}",
            op_id=f"runbook:{svc.id}:{rb['id']}:{models.new_id()[:8]}",
            audience_kind="admins",
            audience=f"{team.name} admins",
            commitment=c,
            actor=actor,
            preview=f"Runbook **{rb['name']}** on **{svc.name}**\n\n`{rb.get('command', rb['id'])}`",
        ),
    )
