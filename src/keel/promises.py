"""Promise archaeology: find the "I'll fix this by Friday" comments in a GitHub repo and check which were kept.

Works on any public repo with no token and no install, which makes it Keel's zero-setup hook: point it at a
repo and see the team's promises the way a steward would track them.

How a promise is judged (a heuristic, and the report says so):

* kept: the issue or PR it was made on was closed as completed (or merged) after the promise;
* dropped: the thread was closed as not planned (or the PR closed unmerged);
* follow-up: the work was pushed to a later PR ("in a follow-up"), or the thread was already closed. We can't
  see follow-up PRs, so these are listed but left out of the kept rate;
* overdue: still open past the date the author gave;
* gone quiet: still open with no date, older than ``QUIET_DAYS``;
* open: still open and not yet late.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import re
import statistics
import typing

import httpx
import pydantic
from langchain_core import language_models

from keel import brain, checkup, models, svg

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 30  # A month shows a pattern without dragging in promises nobody remembers.
MAX_COMMENT_PAGES = 3  # 300 issue comments; bounds calls for tokenless use (60 requests/hour).
MAX_COMMENT_PAGES_WITH_TOKEN = 10  # 1,000 comments; a token allows 5,000 requests/hour.
MIN_JUDGED = 3  # Below this a kept rate is noise ("100%" from one promise), so we show n/a.
MAX_THREAD_LOOKUPS = 40  # Issues/PRs whose state we fetch; with the pages above stays under 50 calls.
QUIET_DAYS = 14  # Two sprints with no date and no close: the promise has likely been forgotten.
MODEL_BATCH = 20  # Candidates per model call: one call per batch keeps a scan to a few seconds.
QUOTE_CHARS = 180  # Long enough for the sentence with the promise, short enough for a card.
SAMPLE_PROMISERS = 3  # People named in the summary.

STATUSES = ("kept", "overdue", "quiet", "dropped", "follow_up", "open")
JUDGED = ("kept", "overdue", "quiet", "dropped")  # Statuses that count toward the kept rate.
STATUS_LABEL = {
    "kept": "kept",
    "overdue": "overdue",
    "quiet": "gone quiet",
    "dropped": "dropped",
    "follow_up": "follow-up",
    "open": "open",
}

_ACTIONS = (
    "take|fix|look|send|open|submit|put up|push|work|handle|update|add|address|investigate|dig|check|write|"
    "make|follow|review|clean|file|create|change|rebase|implement|prepare|port|backport|remove|refactor|"
    "get (?:to|back|this|it|a)|land|ship|merge|test|document|debug|patch|revert|bump|tackle|finish"
)
PROMISE_RE = re.compile(
    r"\b(?:i'?ll|i will|i'm going to|i am going to|i'm gonna|let me|i can|we'll|we will)\s+"
    r"(?:(?:try to|also|quickly|go ahead and|definitely|then|just|probably|happily|gladly|soon)\s+)?"
    rf"(?:{_ACTIONS})\b"
    r"|\b(?:i'm|i am) (?:working on (?:it|this|that|a fix|the fix)|on it)\b"
    r"|(?:^|(?<=[.!] ))(?:working on (?:it|this|that|a fix|the fix)|on it)\b"
    r"|\bpr (?:is )?(?:coming|incoming|on (?:the|its) way)\b",
    re.IGNORECASE | re.MULTILINE,
)
HEDGE_RE = re.compile(
    r"\b(?:if|when) (?:i|we) (?:have|get|find) (?:the )?(?:time|a chance|bandwidth)\b|\bmaybe\b|\bmight\b|"
    r"\b(?:once|if|when) (?:i'm |i am |it's |it is |this is )?assigned\b|\bif (?:you|that's|it's|that is)\b|"
    r"\?\s*$|^if\b|\b(?:wouldn't|won't|doesn't|didn't|don't) let me\b",
    re.IGNORECASE,
)
DEFER_RE = re.compile(
    r"\b(?:follow[- ]?up|separate pr|another pr|future pr|next pr|later pr|in a later|next release)\b",
    re.IGNORECASE,
)
_BLOCKS = re.compile(r"```.*?```|<!--.*?-->", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_QUOTED = re.compile(r"\"[^\"\n]{1,80}\"|“[^”\n]{1,80}”")


@dataclasses.dataclass
class Promise:
    """One promise found in a comment and how it turned out."""

    who: str
    quote: str
    said_at: str
    url: str
    number: int
    thread_title: str
    is_pr: bool
    what: str
    due: str | None = None
    deferred: bool = False
    status: str = "open"
    resolved_at: str | None = None
    days_to_keep: float | None = None
    age_days: float = 0.0


@dataclasses.dataclass
class Report:
    """A promise scan of one repo."""

    repo: str
    days: int
    scanned_comments: int
    checked_threads: int
    promises: list[Promise]
    used_model: bool
    stats: dict[str, typing.Any]
    not_checked: list[str]

    def as_dict(self) -> dict[str, typing.Any]:
        """JSON-ready form."""
        return dataclasses.asdict(self)


class Judgement(pydantic.BaseModel):
    """The model's verdict on one candidate comment."""

    index: int
    promise: bool = pydantic.Field(
        description="True only if the author commits themselves or their team to concrete work"
    )
    what: str | None = pydantic.Field(
        default=None, description="Short imperative title of the work, max 70 chars"
    )
    due: str | None = pydantic.Field(default=None, description="YYYY-MM-DD if a date is stated or implied")
    deferred: bool = pydantic.Field(
        default=False, description="True if the work is pushed to a follow-up/later/separate PR"
    )


class Judgements(pydantic.BaseModel):
    """Verdicts for a batch."""

    items: list[Judgement]


JUDGE_PROMPT = """You read GitHub comments and find promises: the author commits themselves (or "we", their
team) to concrete work, like "I'll fix this by Friday", "I'll send a PR", "I'll take a look", "working on it".
Claiming work counts too: "I can take this", "I'll take this one".
Not promises: asking others, hedges ("if I have time", "maybe"), offers that wait on someone else's approval
("I can do it if you want", "once assigned I'll open a PR"), quotes of others, past tense ("I fixed it").
Mark deferred when the work is pushed to a follow-up, later or separate PR. Resolve relative dates against
the comment date; leave due empty when no date is stated or clearly implied. One item per comment, by index."""


def clean(body: str) -> str:
    """Comment text without code, quoted replies or HTML comments."""
    text = _QUOTED.sub("…", _INLINE_CODE.sub(r"\1", _BLOCKS.sub(" ", body or "")))
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(">"))


def quote_of(text: str, limit: int = QUOTE_CHARS) -> str:
    """The sentence that holds the promise, trimmed to ``limit`` characters."""
    flat = " ".join(text.split())
    m = PROMISE_RE.search(flat)
    if not m:
        return flat[:limit]
    stops = [flat.rfind(mark, 0, m.start()) for mark in (". ", "! ", "? ")]
    start = max((i + 2 for i in stops if i != -1), default=0)
    if m.start() - start > limit // 2:
        start = m.start()
    ends = [
        i for i in (flat.find(". ", m.end()), flat.find("! ", m.end()), flat.find("? ", m.end())) if i != -1
    ]
    end = min(ends) + 1 if ends else len(flat)
    q = flat[start:end].strip()
    return q if len(q) <= limit else q[: limit - 1].rstrip() + "…"


def is_bot(user: dict[str, typing.Any] | None) -> bool:
    """GitHub Apps and bot accounts never make promises we should hold anyone to."""
    if not user:
        return True
    return user.get("type") == "Bot" or str(user.get("login", "")).endswith("[bot]")


def _ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def _thread_number(comment: dict[str, typing.Any]) -> int | None:
    url = comment.get("issue_url") or comment.get("pull_request_url") or ""
    m = re.search(r"/(?:issues|pulls)/(\d+)$", url)
    return int(m[1]) if m else None


def candidates(comments: list[dict[str, typing.Any]]) -> list[dict[str, typing.Any]]:
    """Comments that look like promises by the rules: not bots, a promise phrase, no hedge.

    Keeps the earliest per person per thread, since repeating a promise doesn't make it two.
    """
    seen: set[tuple[str, int]] = set()
    out = []
    for c in sorted(comments, key=lambda c: c.get("created_at", "")):
        if is_bot(c.get("user")):
            continue
        number = _thread_number(c)
        text = clean(c.get("body", ""))
        if number is None or not PROMISE_RE.search(text) or HEDGE_RE.search(quote_of(text)):
            continue
        key = (c["user"]["login"], number)
        if key in seen:
            continue
        seen.add(key)
        out.append({**c, "_text": text, "_number": number})
    return out


def judge(model: language_models.BaseChatModel | None, cands: list[dict[str, typing.Any]]) -> list[Judgement]:
    """Confirm candidates with the model in batches; rules decide when there is no model or a call fails."""
    out: list[Judgement] = []
    for start in range(0, len(cands), MODEL_BATCH):
        batch = cands[start : start + MODEL_BATCH]
        verdicts: dict[int, Judgement] = {}
        if model is not None:
            listing = "\n\n".join(
                f"[{i}] {c['created_at'][:10]} ({_ts(c['created_at']).strftime('%A')}) @{c['user']['login']}: "
                f"{quote_of(c['_text'], 500)}"
                for i, c in enumerate(batch)
            )
            try:
                res = typing.cast(
                    Judgements,
                    model.with_structured_output(Judgements).invoke(
                        [{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": listing}]
                    ),
                )
                verdicts = {j.index: j for j in res.items if 0 <= j.index < len(batch)}
            except Exception as exc:
                log.warning("promise model call failed, using rules: %s", exc)
        for i, c in enumerate(batch):
            j = verdicts.get(i) or _rule_judgement(i, c)
            out.append(j.model_copy(update={"index": start + i}))
    return out


def _rule_judgement(i: int, c: dict[str, typing.Any]) -> Judgement:
    text = quote_of(c["_text"], 500)
    due = brain.parse_due(text, _ts(c["created_at"]))
    return Judgement(
        index=i,
        promise=True,
        what=brain.title_from(quote_of(c["_text"], 120)),
        due=due.date().isoformat() if due else None,
        deferred=bool(DEFER_RE.search(text)),
    )


def outcome(p: Promise, thread: dict[str, typing.Any] | None, now: dt.datetime) -> Promise:
    """Set ``status`` from the thread's state. See the module docstring for the rules."""
    said = _ts(p.said_at)
    p.age_days = round((now - said).total_seconds() / 86400, 1)
    closed_at = thread.get("closed_at") if thread else None
    merged_at = ((thread or {}).get("pull_request") or {}).get("merged_at")
    if closed_at and _ts(closed_at) < said:
        p.status = "follow_up"
        return p
    if closed_at and not p.deferred:
        completed = (
            merged_at is not None
            if p.is_pr
            else thread.get("state_reason") not in ("not_planned", "duplicate")
        )
        p.status = "kept" if completed else "dropped"
        p.resolved_at = closed_at
        if completed:
            p.days_to_keep = round((_ts(closed_at) - said).total_seconds() / 86400, 1)
        return p
    if p.deferred:
        p.status = "follow_up"
        return p
    if p.due and dt.date.fromisoformat(p.due) < now.date():
        p.status = "overdue"
    elif not p.due and p.age_days > QUIET_DAYS:
        p.status = "quiet"
    else:
        p.status = "open"
    return p


def summarize(promises: list[Promise]) -> dict[str, typing.Any]:
    """Counts, the kept rate (None when nothing can be judged yet) and the standout promises."""
    counts = {s: sum(p.status == s for p in promises) for s in STATUSES}
    judged = sum(counts[s] for s in JUDGED)
    keep_days = [p.days_to_keep for p in promises if p.days_to_keep is not None]
    people: dict[str, list[int]] = {}
    for p in promises:
        made_kept = people.setdefault(p.who, [0, 0])
        made_kept[0] += 1
        made_kept[1] += p.status == "kept"
    unkept = [p for p in promises if p.status in ("overdue", "quiet")]
    kept = [p for p in promises if p.status == "kept" and p.days_to_keep is not None]
    return {
        "promises": len(promises),
        **counts,
        "judged": judged,
        "kept_rate": round(counts["kept"] / judged, 3) if judged >= MIN_JUDGED else None,
        "median_days_to_keep": round(statistics.median(keep_days), 1) if keep_days else None,
        "top_promisers": [
            {"who": who, "made": mk[0], "kept": mk[1]}
            for who, mk in sorted(people.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))[
                :SAMPLE_PROMISERS
            ]
        ],
        "oldest_unkept": dataclasses.asdict(max(unkept, key=lambda p: p.age_days)) if unkept else None,
        "fastest_kept": dataclasses.asdict(min(kept, key=lambda p: p.days_to_keep or 0)) if kept else None,
    }


def scan(
    repo: str,
    *,
    days: int = LOOKBACK_DAYS,
    token: str = "",
    api_url: str = "https://api.github.com",
    model: language_models.BaseChatModel | None = None,
    client: httpx.Client | None = None,
    now: dt.datetime | None = None,
) -> Report:
    """Scan ``owner/name`` for promises made in the last ``days`` days. Raises checkup.CheckupError."""
    repo = checkup.check_repo_name(repo)
    if days < 1:
        raise checkup.CheckupError("Look back at least one day.")
    now = now or models.utcnow()
    http = client or checkup.github_client(token, api_url)
    pages = MAX_COMMENT_PAGES_WITH_TOKEN if token else MAX_COMMENT_PAGES
    if checkup.fetch(http, f"/repos/{repo}") is None:
        raise checkup.CheckupError(f"Can't find {repo}. Check the name, or add a token for private repos.")
    since = (now - dt.timedelta(days=days)).isoformat().replace("+00:00", "Z")
    comments: list[dict[str, typing.Any]] = []
    for page in range(1, pages + 1):
        batch = (
            checkup.fetch(
                http,
                f"/repos/{repo}/issues/comments",
                since=since,
                sort="created",
                direction="asc",
                per_page=100,
                page=page,
            )
            or []
        )
        comments += batch
        if len(batch) < 100:
            break
    comments += (
        checkup.fetch(
            http, f"/repos/{repo}/pulls/comments", since=since, sort="created", direction="asc", per_page=100
        )
        or []
    )
    comments = [c for c in comments if c.get("created_at", "") >= since]

    cands = candidates(comments)
    verdicts = judge(model, cands)
    found = [(c, j) for c, j in zip(cands, verdicts, strict=True) if j.promise]
    found.sort(key=lambda cj: cj[0]["created_at"], reverse=True)
    numbers = list(dict.fromkeys(c["_number"] for c, _ in found))[:MAX_THREAD_LOOKUPS]
    threads = {n: checkup.fetch(http, f"/repos/{repo}/issues/{n}") for n in numbers}
    promises = []
    for c, j in found:
        if c["_number"] not in threads:
            continue
        t = threads[c["_number"]] or {}
        promises.append(
            outcome(
                Promise(
                    who=c["user"]["login"],
                    quote=quote_of(c["_text"]),
                    said_at=c["created_at"],
                    url=c.get("html_url", ""),
                    number=c["_number"],
                    thread_title=str(t.get("title", ""))[:120],
                    is_pr="pull_request" in t or "pull_request_url" in c,
                    what=(j.what or "")[:80] or brain.title_from(quote_of(c["_text"], 120)),
                    due=j.due,
                    deferred=j.deferred,
                ),
                t,
                now,
            )
        )
    not_checked = ["follow-up PRs (promises pushed to a later PR aren't traced yet)"]
    if len(found) > len(promises):
        not_checked.append(f"{len(found) - len(promises)} older promises (thread lookups are capped)")
    return Report(
        repo=repo,
        days=days,
        scanned_comments=len(comments),
        checked_threads=len(threads),
        promises=promises,
        used_model=model is not None,
        stats=summarize(promises),
        not_checked=not_checked,
    )


def rate_text(rate: float | None) -> str:
    """``82%``, or ``n/a`` when nothing can be judged yet."""
    return "n/a" if rate is None else f"{round(rate * 100)}%"


def badge(report: Report) -> str:
    """README badge: ``promises kept | 82%``."""
    rate = report.stats["kept_rate"]
    return svg.badge("promises kept", rate_text(rate), svg.color_for_rate(rate))


def card(report: Report) -> str:
    """The 1200×630 share card for a scan."""
    st = report.stats
    rows = [
        ("Promises found", f"{st['promises']} in {report.scanned_comments} comments"),
        ("Kept", str(st["kept"])),
        ("Late, quiet or dropped", str(st["overdue"] + st["quiet"] + st["dropped"])),
    ]
    if st["median_days_to_keep"] is not None:
        rows.append(("Median time to keep", f"{st['median_days_to_keep']:g} days"))
    quote = ""
    if old := st["oldest_unkept"]:
        # No @handle on a card meant for sharing: the point is the pattern, not calling someone out.
        quote = f"“{old['quote']}” ({round(old['age_days'])} days, no update)"
    return svg.card(
        svg.Card(
            eyebrow=f"Promise check · last {report.days} days",
            title=report.repo,
            big=rate_text(st["kept_rate"]) if st["kept_rate"] is not None else "—",
            big_caption="of promises kept" if st["kept_rate"] is not None else "nothing to judge yet",
            rows=rows,
            quote=quote,
            accent=svg.color_for_rate(st["kept_rate"])
            if st["kept_rate"] is not None
            else svg.COLORS["purple"],
        )
    )


def markdown(report: Report) -> str:
    """A Markdown summary for a GitHub job summary, an issue or a chat message."""
    st = report.stats
    lines = [
        f"### ⚓ Promise check: {report.repo} (last {report.days} days)",
        "",
        f"**{rate_text(st['kept_rate'])} kept** · {st['promises']} promises in {report.scanned_comments} comments · "
        f"{st['kept']} kept, {st['overdue']} overdue, {st['quiet']} gone quiet, {st['dropped']} dropped, "
        f"{st['follow_up']} follow-ups, {st['open']} still open",
        "",
    ]
    late = [p for p in report.promises if p.status in ("overdue", "quiet")]
    if late:
        lines += ["| Who | Promise | Said | Status |", "|---|---|---|---|"]
        for p in sorted(late, key=lambda p: -p.age_days):
            what = p.what.replace("|", "\\|")
            lines.append(
                f"| @{p.who} | [{what}]({p.url}) | {round(p.age_days)} days ago | {STATUS_LABEL[p.status]} |"
            )
        lines.append("")
    lines.append(
        "<sub>Kept means the issue or PR closed as completed after the promise. Not checked: "
        + "; ".join(report.not_checked)
        + ".</sub>"
    )
    return "\n".join(lines)


DEMO_PROMISES = [
    # who, quote, days ago, thread, is PR, title, due offset (days from the comment), deferred, thread closed after
    (
        "jonas-b",
        "I'll fix the rounding bug by Friday.",
        23,
        412,
        False,
        "Fix invoice rounding",
        3,
        False,
        None,
    ),
    (
        "maya-p",
        "On it, PR coming this afternoon.",
        19,
        431,
        True,
        "Send the idempotency PR",
        None,
        False,
        0.3,
    ),
    (
        "iris-c",
        "I'll update the migration guide in a follow-up.",
        17,
        433,
        True,
        "Update the guide",
        None,
        True,
        0.2,
    ),
    (
        "theo-w",
        "I'll take a look at the flaky deploy test.",
        26,
        398,
        False,
        "Fix the flaky deploy test",
        None,
        False,
        None,
    ),
    (
        "lena-o",
        "I'll take this one, should be done tomorrow.",
        12,
        445,
        False,
        "Ship refunds export",
        1,
        False,
        1.5,
    ),
    ("sam-o", "We'll bump the node image next week.", 15, 440, False, "Bump the node image", 7, False, 6),
    (
        "ravi-k",
        "Let me dig into the Android crash today.",
        4,
        452,
        False,
        "Debug the Android crash",
        0,
        False,
        None,
    ),
    ("kai-t", "I'll write the dark-mode spec.", 9, 449, False, "Write the dark-mode spec", None, False, None),
    (
        "jonas-b",
        "I'll add a regression test for this.",
        20,
        420,
        True,
        "Add a regression test",
        None,
        False,
        0.1,
    ),
    ("nora-l", "I'll send the release notes Monday.", 8, 447, False, "Send release notes", 4, False, None),
]


def demo_report(repo: str, now: dt.datetime | None = None) -> Report:
    """A canned scan for the demo org, so the page works with no network or token."""
    now = now or models.utcnow()
    out = []
    for who, quote, ago, number, is_pr, what, due_in, deferred, closed_after in DEMO_PROMISES:
        said = now - dt.timedelta(days=ago)
        thread = {"state": "open"}
        if closed_after is not None:
            closed = (said + dt.timedelta(days=closed_after)).isoformat().replace("+00:00", "Z")
            thread = {"state": "closed", "closed_at": closed, "state_reason": "completed"}
            if is_pr:
                thread["pull_request"] = {"merged_at": closed}
        due = (said + dt.timedelta(days=due_in)).date().isoformat() if due_in is not None else None
        p = Promise(
            who=who,
            quote=quote,
            said_at=said.isoformat().replace("+00:00", "Z"),
            url=f"https://github.com/{repo}/{'pull' if is_pr else 'issues'}/{number}",
            number=number,
            thread_title=what,
            is_pr=is_pr,
            what=what,
            due=due,
            deferred=deferred,
        )
        out.append(outcome(p, thread, now))
    return Report(
        repo=repo,
        days=LOOKBACK_DAYS,
        scanned_comments=318,
        checked_threads=len(out),
        promises=out,
        used_model=False,
        stats=summarize(out),
        not_checked=["demo data: a sample report, not a real scan"],
    )
