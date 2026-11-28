"""Keep team knowledge in sync with where it really lives: a web page, or a folder of Markdown on GitHub.

Each source owns its docs (``KnowledgeDoc.sync_id``). A sync adds new files, updates changed ones and removes
docs whose file is gone, so the steward never cites a page that no longer exists.
"""

from __future__ import annotations

import datetime as dt
import html.parser
import re
import urllib.parse

import httpx
import sqlalchemy as sa
from sqlalchemy import orm

from keel import errors, feed, knowledge, labels, models
from keel.connectors import github

FETCH_TIMEOUT_S = 20  # A docs page or a GitHub listing; slower than this is a problem worth reporting.
MAX_PAGE_BYTES = 2_000_000  # Bigger than any sane doc page; stops a binary or a dump from filling the DB.
MAX_FILES = 300  # Markdown files per GitHub source; a docs folder past this belongs in several sources.
MAX_FILE_BYTES = 400_000  # One Markdown file; larger ones are usually generated.
RETRY_AFTER_ERROR = dt.timedelta(hours=1)  # A failed sync tries again soon, not at the normal interval.
TEXT_SUFFIXES = (".md", ".mdx", ".markdown", ".txt", ".rst")
KINDS = ("url", "github")


class _Text(html.parser.HTMLParser):
    """HTML → readable text with paragraph breaks; skips scripts, styles and navigation."""

    SKIP = frozenset({"script", "style", "nav", "header", "footer", "noscript", "svg"})
    BLOCK = frozenset({"p", "div", "section", "article", "li", "br", "tr", "h1", "h2", "h3", "h4", "pre"})

    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False
        self._title_done = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title" and not self._skip and not self._title_done:
            self._in_title = True  # Only the page's own <title>; SVG icons carry <title>s too.
        elif tag in self.BLOCK:
            self.out.append("\n\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title" and self._in_title:
            self._in_title, self._title_done = False, True

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.out.append(data)

    def text(self) -> str:
        raw = "".join(self.out)
        paras = [" ".join(p.split()) for p in re.split(r"\n\s*\n", raw)]
        return "\n\n".join(p for p in paras if p)


def html_to_text(page: str) -> tuple[str, str]:
    """(title, text) of an HTML page."""
    p = _Text()
    p.feed(page)
    return " ".join(p.title.split()), p.text()


def check_target(kind: str, target: str) -> str:
    """Normalize a source target. Raises ValueError with a plain line when it's wrong."""
    target = target.strip()
    if kind == "url":
        u = urllib.parse.urlparse(target)
        if u.scheme not in ("http", "https") or not u.netloc:
            raise ValueError("Use a full web address, like https://wiki.example.com/runbooks/deploys.")
        return target
    if kind == "github":
        t = target.removeprefix("https://github.com/").strip("/")
        t = re.sub(r"/tree/[^/]+", "", t)
        if len(t.split("/")) < 2 or not all(t.split("/")[:2]):
            raise ValueError("Use owner/repo or owner/repo/path/to/folder.")
        return t
    raise ValueError("A source is a url or a github folder.")


def add_source(
    s: orm.Session, team: models.Team, kind: str, target: str, label: str, actor: str
) -> models.KnowledgeSource:
    """Register a source; the worker syncs it right away."""
    labels.rank(label)
    target = check_target(kind, target)
    dup = s.scalar(
        sa.select(models.KnowledgeSource).where(
            models.KnowledgeSource.team_id == team.id,
            models.KnowledgeSource.kind == kind,
            models.KnowledgeSource.target == target,
        )
    )
    if dup is not None:
        raise ValueError("This team already syncs that source.")
    src = models.KnowledgeSource(
        org_id=team.org_id,
        team_id=team.id,
        kind=kind,
        target=target,
        label=label,
        next_sync_at=models.utcnow(),
    )
    s.add(src)
    s.flush()
    feed.audit(s, team.org_id, actor, "knowledge.source_added", f"{kind}:{target}", f"label={label}", team.id)
    return src


def _client(
    auth: github.GitHubAuth | None, api_url: str, transport: httpx.BaseTransport | None
) -> httpx.Client:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": github.USER_AGENT}
    if auth is not None:
        headers["Authorization"] = f"Bearer {auth.bearer()}"
    return httpx.Client(base_url=api_url, headers=headers, timeout=FETCH_TIMEOUT_S, transport=transport)


def _fetch_url(target: str, transport: httpx.BaseTransport | None) -> list[tuple[str, str, str, str]]:
    with httpx.Client(timeout=FETCH_TIMEOUT_S, follow_redirects=True, transport=transport) as http:
        resp = http.get(target, headers={"User-Agent": github.USER_AGENT})
    if resp.status_code >= 400:
        raise errors.ConnectorError(errors.NOT_FOUND, f"The page answered {resp.status_code}.", sent=False)
    if len(resp.content) > MAX_PAGE_BYTES:
        raise errors.ConnectorError(
            errors.BAD_REQUEST, "The page is over 2 MB; point at a smaller page.", sent=False
        )
    ctype = resp.headers.get("content-type", "")
    if "html" in ctype:
        title, text = html_to_text(resp.text)
    elif ctype.startswith("text/") or "markdown" in ctype or "json" in ctype:
        title, text = "", resp.text
    else:
        raise errors.ConnectorError(
            errors.BAD_REQUEST, f"Keel can't read {ctype or 'this kind of file'}.", sent=False
        )
    title = (
        title
        or _md_title(text)
        or urllib.parse.urlparse(target).path.rstrip("/").rsplit("/", 1)[-1]
        or target
    )
    return [(target, title[:300], text, target)]


def _md_title(text: str) -> str:
    m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    return m.group(1).strip() if m else ""


def _fetch_github(
    target: str, auth: github.GitHubAuth | None, transport: httpx.BaseTransport | None
) -> list[tuple[str, str, str, str]]:
    parts = target.split("/")
    repo, folder = "/".join(parts[:2]), "/".join(parts[2:])
    api_url = auth.api_url if auth else "https://api.github.com"
    web_url = "https://github.com" if "api.github.com" in api_url else api_url.removesuffix("/api/v3")
    with _client(auth, api_url, transport) as http:

        def get(path: str, **kw: str) -> httpx.Response:
            r = http.get(path, params=kw or None)
            if r.status_code >= 400:
                raise errors.classify_http(
                    "GitHub", r.status_code, github._message(r), dict(r.headers), write=False
                )
            return r

        branch = get(f"/repos/{repo}").json().get("default_branch", "main")
        tree = get(f"/repos/{repo}/git/trees/{branch}", recursive="1").json().get("tree", [])
        files = [
            t
            for t in tree
            if t.get("type") == "blob"
            and t["path"].lower().endswith(TEXT_SUFFIXES)
            and (not folder or t["path"] == folder or t["path"].startswith(folder.rstrip("/") + "/"))
            and int(t.get("size") or 0) <= MAX_FILE_BYTES
        ]
        if not files:
            where = f"{repo}/{folder}" if folder else repo
            raise errors.ConnectorError(errors.NOT_FOUND, f"No Markdown files in {where}.", sent=False)
        out = []
        for f in files[:MAX_FILES]:
            raw = http.get(
                f"/repos/{repo}/contents/{urllib.parse.quote(f['path'])}",
                params={"ref": branch},
                headers={"Accept": "application/vnd.github.raw"},
            )
            if raw.status_code >= 400:
                continue
            text = raw.text
            name = f["path"].rsplit("/", 1)[-1].rsplit(".", 1)[0].replace("-", " ").replace("_", " ")
            out.append(
                (
                    f"github://{repo}/{f['path']}",
                    (_md_title(text) or name.title())[:300],
                    text,
                    f"{web_url}/{repo}/blob/{branch}/{f['path']}",
                )
            )
    return out


def sync(
    s: orm.Session, src: models.KnowledgeSource, transport: httpx.BaseTransport | None = None
) -> models.KnowledgeSource:
    """Pull the source now. Never raises for remote problems: they go on the source's status line."""
    team = s.get(models.Team, src.team_id)
    now = models.utcnow()
    try:
        if src.kind == "url":
            items = _fetch_url(src.target, transport)
        else:
            items = _fetch_github(src.target, github.auth_for_org(s, src.org_id), transport)
    except (errors.ConnectorError, httpx.HTTPError) as exc:
        line = (
            exc.line
            if isinstance(exc, errors.ConnectorError)
            else f"Couldn't reach it ({type(exc).__name__})."
        )
        src.status, src.status_line, src.next_sync_at = "error", line[:300], now + RETRY_AFTER_ERROR
        feed.audit(s, src.org_id, "knowledge sync", "knowledge.sync_failed", src.target, line, src.team_id)
        return src
    seen = set()
    added = changed = 0
    for source, title, text, url in items:
        if not text.strip():
            continue
        seen.add(source)
        old = s.scalar(
            sa.select(models.KnowledgeDoc).where(
                models.KnowledgeDoc.team_id == team.id, models.KnowledgeDoc.source == source
            )
        )
        if old is not None and old.content == text and old.title == title and old.label == src.label:
            continue
        knowledge.add(
            s,
            team,
            title,
            text,
            src.label,
            source,
            actor="knowledge sync",
            origin=src.kind,
            source_url=url,
            sync_id=src.id,
        )
        added, changed = (added + 1, changed) if old is None else (added, changed + 1)
    gone = [
        d
        for d in s.scalars(sa.select(models.KnowledgeDoc).where(models.KnowledgeDoc.sync_id == src.id))
        if d.source not in seen
    ]
    for d in gone:
        knowledge.delete(s, d, "knowledge sync")
    src.status = "ok"
    src.status_line = (
        f"Synced {len(seen)} doc{'s' if len(seen) != 1 else ''}: "
        f"{added} new, {changed} changed, {len(gone)} removed."
    )
    src.last_synced_at, src.next_sync_at = now, now + dt.timedelta(hours=max(1, src.every_hours))
    s.flush()
    return src


def due(s: orm.Session, now: dt.datetime) -> list[models.KnowledgeSource]:
    """Sources whose next sync time has come."""
    return list(
        s.scalars(
            sa.select(models.KnowledgeSource).where(
                sa.or_(
                    models.KnowledgeSource.next_sync_at.is_(None), models.KnowledgeSource.next_sync_at <= now
                )
            )
        )
    )
