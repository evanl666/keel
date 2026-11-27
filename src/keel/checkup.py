"""Repo checkup: a five-minute health report from the GitHub API. Works on public repos with no token.

It's the first thing a new team sees, so it must be fast, specific and honest about what it couldn't check.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import statistics
import typing

import httpx
from sqlalchemy import orm

from keel import connections, feed, models

STALE_PR_DAYS = 14  # Two sprints without activity: the author has likely moved on.
REVIEW_WAIT_DAYS = 2  # Longer than this without a first review slows a team down noticeably.
OLD_UNOWNED_ISSUE_DAYS = 30  # A month with no assignee usually means nobody will pick it up.
SAMPLE_PRS = 30  # Recent merged PRs used for merge-time stats; enough for a stable median.
MAX_PR_REVIEW_LOOKUPS = 15  # Bounds API calls (60/hour without a token).
HTTP_TIMEOUT_S = 15.0
SEVERITY_COST = {"high": 15, "medium": 7, "low": 3}  # Points off 100 per finding; one high ≈ two mediums.
GRADES = ((90, "A"), (80, "B"), (70, "C"), (60, "D"))
OWNERS_PATHS = (".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS")


@dataclasses.dataclass
class Finding:
    """One thing worth fixing."""

    severity: str
    title: str
    detail: str
    url: str | None = None


def grade(score: int) -> str:
    """Letter grade for a 0–100 score."""
    return next((g for floor, g in GRADES if score >= floor), "F")


def score(findings: list[Finding]) -> int:
    """100 minus a cost per finding, floored at 0. No findings scores 100."""
    return max(0, 100 - sum(SEVERITY_COST[f.severity] for f in findings))


class CheckupError(Exception):
    """A checkup couldn't run; the message is one plain line."""


def _age_days(ts: str, now: dt.datetime) -> float:
    return (now - dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))).total_seconds() / 86400


def analyze(repo: str, token: str = "", api_url: str = "https://api.github.com",
            client: httpx.Client | None = None, now: dt.datetime | None = None) -> tuple[list[Finding], dict[str, typing.Any]]:
    """Inspect ``owner/name`` and return findings plus stats. Raises CheckupError with a plain reason."""
    if repo.count("/") != 1 or not all(repo.split("/")):
        raise CheckupError("Use the form owner/name, like vercel/next.js.")
    now = now or models.utcnow()
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    http = client or httpx.Client(base_url=api_url, headers=headers, timeout=HTTP_TIMEOUT_S)

    def get(path: str, **params: typing.Any) -> typing.Any:
        try:
            r = http.get(path, params=params)
        except httpx.HTTPError as exc:
            raise CheckupError(f"Couldn't reach GitHub ({type(exc).__name__}).") from exc
        if r.status_code == 404:
            return None
        if r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0":
            raise CheckupError("GitHub's rate limit is used up. Add a token in Setup or try again within the hour.")
        if r.status_code in (401, 403):
            raise CheckupError(f"GitHub refused access ({r.status_code}). The token may lack access to this repo.")
        if r.status_code >= 400:
            raise CheckupError(f"GitHub answered {r.status_code}.")
        return r.json()

    meta = get(f"/repos/{repo}")
    if meta is None:
        raise CheckupError(f"Can't find {repo}. Check the name, or add a token for private repos.")
    branch = meta.get("default_branch", "main")
    web = meta.get("html_url", f"https://github.com/{repo}")
    findings: list[Finding] = []

    open_prs = get(f"/repos/{repo}/pulls", state="open", per_page=100) or []
    stale = [p for p in open_prs if _age_days(p["updated_at"], now) > STALE_PR_DAYS and not p.get("draft")]
    if stale:
        oldest = max(stale, key=lambda p: _age_days(p["updated_at"], now))
        findings.append(Finding("medium" if len(stale) < 5 else "high", f"{len(stale)} stale pull request{'s' * (len(stale) != 1)}",
                                f"No activity for over {STALE_PR_DAYS} days. Oldest: #{oldest['number']} “{oldest['title'][:70]}”.",
                                oldest["html_url"]))
    waiting = []
    for p in [p for p in open_prs if not p.get("draft")][:MAX_PR_REVIEW_LOOKUPS]:
        if _age_days(p["created_at"], now) <= REVIEW_WAIT_DAYS:
            continue
        reviews = get(f"/repos/{repo}/pulls/{p['number']}/reviews", per_page=1) or []
        if not reviews:
            waiting.append(p)
    if waiting:
        findings.append(Finding("medium", f"{len(waiting)} PR{'s' * (len(waiting) != 1)} waiting for a first review",
                                f"Open more than {REVIEW_WAIT_DAYS} days with no review, e.g. #{waiting[0]['number']}.",
                                waiting[0]["html_url"]))

    closed = get(f"/repos/{repo}/pulls", state="closed", per_page=SAMPLE_PRS, sort="updated", direction="desc") or []
    merged = [p for p in closed if p.get("merged_at")]
    merge_hours = [(_age_days(p["created_at"], now) - _age_days(p["merged_at"], now)) * 24 for p in merged]
    median_merge_h = round(statistics.median(merge_hours), 1) if merge_hours else None
    if median_merge_h is not None and median_merge_h > 72:
        findings.append(Finding("medium", "Slow merges", f"Median time from open to merge is {median_merge_h / 24:.1f} days "
                                f"over the last {len(merged)} merged PRs."))

    issues = [i for i in (get(f"/repos/{repo}/issues", state="open", per_page=100) or []) if "pull_request" not in i]
    unowned = [i for i in issues if not i.get("assignees") and _age_days(i["created_at"], now) > OLD_UNOWNED_ISSUE_DAYS]
    if unowned:
        findings.append(Finding("low" if len(unowned) < 10 else "medium",
                                f"{len(unowned)} old issue{'s' * (len(unowned) != 1)} with no owner",
                                f"Open over {OLD_UNOWNED_ISSUE_DAYS} days with nobody assigned.", f"{web}/issues?q=is%3Aopen+no%3Aassignee"))

    ci_state = "unknown"
    runs = get(f"/repos/{repo}/commits/{branch}/check-runs", per_page=50)
    if runs and runs.get("check_runs"):
        conclusions = {r.get("conclusion") for r in runs["check_runs"]}
        ci_state = "failing" if conclusions & {"failure", "timed_out", "cancelled"} else "passing"
        if ci_state == "failing":
            findings.append(Finding("high", f"CI is failing on {branch}",
                                    "The latest commit on the default branch has failing checks.", f"{web}/commits/{branch}"))
    elif runs is not None:
        findings.append(Finding("low", "No CI checks on the default branch",
                                "Nothing reported checks for the latest commit."))

    has_owners = any(get(f"/repos/{repo}/contents/{path}") is not None for path in OWNERS_PATHS)
    if not has_owners:
        findings.append(Finding("low", "No CODEOWNERS file", "Reviews aren't routed to owners automatically.",
                                "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners"))
    community = get(f"/repos/{repo}/community/profile") or {}
    files = community.get("files") or {}
    if not files.get("contributing"):
        findings.append(Finding("low", "No CONTRIBUTING guide", "New contributors have to guess the workflow."))
    if get(f"/repos/{repo}/contents/SECURITY.md") is None and get(f"/repos/{repo}/contents/.github/SECURITY.md") is None:
        findings.append(Finding("low", "No security policy", "There's no SECURITY.md telling people how to report issues."))

    stats = {
        "open_prs": len(open_prs), "stale_prs": len(stale), "awaiting_review": len(waiting),
        "median_merge_hours": median_merge_h if median_merge_h is not None else "n/a",
        "open_issues": len(issues), "unowned_old_issues": len(unowned), "ci": ci_state,
        "default_branch": branch, "stars": meta.get("stargazers_count", 0),
        "not_checked": "branch protection (needs admin access)",
    }
    findings.sort(key=lambda f: list(SEVERITY_COST).index(f.severity))
    return findings, stats


DEMO_FINDINGS = [
    Finding("high", "CI is failing on main", "The latest commit on the default branch has failing checks.", None),
    Finding("medium", "6 stale pull requests", "No activity for over 14 days. Oldest: #412 “Retry webhooks with jitter”.", None),
    Finding("medium", "3 PRs waiting for a first review", "Open more than 2 days with no review, e.g. #431.", None),
    Finding("low", "11 old issues with no owner", "Open over 30 days with nobody assigned.", None),
    Finding("low", "No CODEOWNERS file", "Reviews aren't routed to owners automatically.", None),
]
DEMO_STATS = {"open_prs": 14, "stale_prs": 6, "awaiting_review": 3, "median_merge_hours": 31.5, "open_issues": 57,
              "unowned_old_issues": 11, "ci": "failing", "default_branch": "main", "stars": 0,
              "not_checked": "branch protection (needs admin access)"}


def run(session: orm.Session, checkup: models.Checkup) -> models.Checkup:
    """Run a stored checkup and save the result (demo orgs get a canned report for acme/* repos)."""
    org = session.get(models.Org, checkup.org_id)
    try:
        if org is not None and org.settings.get("demo") and checkup.repo.startswith("acme/"):
            findings, st = DEMO_FINDINGS, dict(DEMO_STATS)
        else:
            res = connections.resolve(session, checkup.org_id, "github")
            findings, st = analyze(checkup.repo, token=res.secrets.get("token", ""),
                                   api_url=res.config.get("api_url") or "https://api.github.com")
    except CheckupError as exc:
        checkup.status, checkup.error_line = "failed", str(exc)
        return checkup
    checkup.score = score(findings)
    checkup.grade = grade(checkup.score)
    checkup.findings = [dataclasses.asdict(f) for f in findings]
    checkup.stats, checkup.status = st, "done"
    feed.activity(session, checkup.org_id, None, "brief", "🩻",
                  f"Checkup of {checkup.repo}: {checkup.grade} ({checkup.score}/100), {len(findings)} findings",
                  f"/checkup?id={checkup.id}")
    return checkup
