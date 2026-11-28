"""Team knowledge: store docs with labels, search with BM25, and never return what the audience can't see."""

from __future__ import annotations

import collections
import dataclasses
import datetime as dt
import math
import re
import typing

import sqlalchemy as sa
from sqlalchemy import orm

from keel import errors, feed, labels, models

CHUNK_CHARS = 900  # About 200 tokens: small enough to cite precisely, big enough to keep a paragraph whole.
TOP_K = 4  # Passages handed to the model; more mostly adds noise for short team docs.
BM25_K1, BM25_B = 1.5, 0.75  # Standard BM25 defaults (Robertson & Zaragoza).
STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "has",
        "have",
        "how",
        "i",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "was",
        "we",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "our",
        "your",
        "do",
        "does",
        "can",
    ]
)
_TOKEN = re.compile(r"[a-z0-9][a-z0-9_\-]*")
_CJK_RUN = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+")


STEM_MIN = 3  # Never cut a word below three letters: "bus", "ios", "red" and "need" stay whole.


def stem(word: str) -> str:
    """Fold common English endings so "refund"/"refunds"/"refunded" and "rotate"/"rotating" match.

    Deliberately light (no dictionary): -ies → -y, -sses → -ss, -ches/-shes/-xes/-zes, -ing, -ed, -s, then a
    final silent -e; never leaves fewer than ``STEM_MIN`` letters. Accepts any lowercase word; returns it
    unchanged when nothing applies. The same function runs on notes and questions, so odd stems still match.
    """
    rules = (("ies", "y"), ("sses", "ss"), ("ches", "ch"), ("shes", "sh"), ("xes", "x"), ("zes", "z"))
    for suffix, repl in (*rules, ("ing", ""), ("ed", ""), ("s", "")):
        if word.endswith(suffix) and len(word) - len(suffix) + len(repl) >= STEM_MIN:
            if suffix == "s" and word.endswith(("ss", "us", "is")):
                break
            word = word[: len(word) - len(suffix)] + repl
            break
    if word.endswith("e") and not word.endswith("ee") and len(word) > STEM_MIN:
        word = word[:-1]
    return word


def tokenize(text: str) -> list[str]:
    """Lowercase stemmed words minus stopwords, plus overlapping character pairs for Chinese, Japanese and Korean.

    Those scripts have no spaces, so pairs stand in for words ("退款流程" → 退款, 款流, 流程); a lone CJK
    character is its own token. Empty or punctuation-only text gives an empty list.
    """
    low = text.lower()
    out = [stem(t) for t in _TOKEN.findall(low) if t not in STOPWORDS]
    for run in _CJK_RUN.findall(low):
        out += [run] if len(run) == 1 else [run[i : i + 2] for i in range(len(run) - 1)]
    return out


def chunks(text: str, size: int = CHUNK_CHARS) -> list[str]:
    """Split on blank lines, packing paragraphs up to ``size`` characters. Empty text gives []."""
    out: list[str] = []
    cur = ""
    for raw in re.split(r"\n\s*\n", text.strip()):
        para = raw.strip()
        if not para:
            continue
        if cur and len(cur) + len(para) + 2 > size:
            out.append(cur)
            cur = ""
        while len(para) > size:
            out.append(para[:size])
            para = para[size:]
        cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out


@dataclasses.dataclass
class Passage:
    """A searchable piece of a document."""

    doc_id: str
    title: str
    source: str
    label: str
    text: str
    score: float = 0.0
    source_url: str | None = None


def bm25(query: str, passages: list[Passage], top_k: int = TOP_K) -> list[Passage]:
    """Rank passages for ``query``. Returns at most ``top_k`` with a positive score; [] for empty input."""
    q = tokenize(query)
    if not q or not passages:
        return []
    docs = [tokenize(f"{p.title} {p.text}") for p in passages]
    avg = sum(len(d) for d in docs) / len(docs) or 1.0
    df: collections.Counter[str] = collections.Counter()
    for d in docs:
        df.update(set(d))
    n = len(docs)
    for p, d in zip(passages, docs, strict=True):
        tf = collections.Counter(d)
        score = 0.0
        for term in q:
            if term not in tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            score += (
                idf * tf[term] * (BM25_K1 + 1) / (tf[term] + BM25_K1 * (1 - BM25_B + BM25_B * len(d) / avg))
            )
        p.score = score
    return sorted((p for p in passages if p.score > 0), key=lambda p: -p.score)[:top_k]


def add(
    session: orm.Session,
    team: models.Team,
    title: str,
    content: str,
    label: str = "internal",
    source: str | None = None,
    actor: str = "keel",
    *,
    origin: str | None = None,
    source_url: str | None = None,
    review_by: dt.date | None = None,
    sync_id: str | None = None,
) -> models.KnowledgeDoc:
    """Add or replace a document. Same team + source replaces; so does a hand-written doc with the same title."""
    labels.rank(label)
    if not content.strip():
        raise ValueError("A knowledge doc needs some content.")
    if not title.strip():
        raise ValueError("A knowledge doc needs a title.")
    source = source or source_for_title(team, title)
    doc = find(session, team, title, source)
    if origin is None:
        origin = "file" if source.startswith("file://") else "url" if source.startswith("http") else "manual"
    if source_url is None and source.startswith(("http://", "https://")):
        source_url = source
    if doc is None:
        doc = models.KnowledgeDoc(
            org_id=team.org_id,
            team_id=team.id,
            title=title,
            source=source,
            label=label,
            content=content,
            origin=origin,
            source_url=source_url,
            review_by=review_by,
            sync_id=sync_id,
        )
        session.add(doc)
        verb = "added"
    else:
        doc.title, doc.label, doc.content, doc.origin = title, label, content, origin
        doc.source_url = source_url or doc.source_url
        doc.sync_id = sync_id or doc.sync_id
        if review_by is not None:
            doc.review_by = review_by
        verb = "updated"
    session.flush()
    feed.activity(
        session,
        team.org_id,
        team.id,
        "knowledge",
        "📚",
        f"{team.name} knowledge {verb}: {title}",
        f"/teams/{team.slug}/knowledge",
    )
    feed.audit(session, team.org_id, actor, f"knowledge.{verb}", source, f"label={label}", team.id)
    return doc


def find(
    session: orm.Session, team: models.Team, title: str, source: str | None
) -> models.KnowledgeDoc | None:
    """The doc :func:`add` would replace: same source, or a hand-written doc with the same title."""
    source = source or source_for_title(team, title)
    doc = session.scalar(
        sa.select(models.KnowledgeDoc).where(
            models.KnowledgeDoc.team_id == team.id, models.KnowledgeDoc.source == source
        )
    )
    if doc is None and source.startswith("keel://"):
        doc = session.scalar(
            sa.select(models.KnowledgeDoc).where(
                models.KnowledgeDoc.team_id == team.id,
                sa.func.lower(models.KnowledgeDoc.title) == title.strip().lower(),
                models.KnowledgeDoc.source.like("keel://%"),
            )
        )
    return doc


def source_for_title(team: models.Team, title: str) -> str:
    """The stable source id of a hand-written doc."""
    return f"keel://{team.slug}/{re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')}"


@dataclasses.dataclass
class SearchResult:
    """Visible passages plus how many matches were withheld from this audience."""

    passages: list[Passage]
    withheld: int

    @property
    def label(self) -> str:
        """Strictest label of the passages used."""
        return labels.strictest(p.label for p in self.passages)


def search(
    session: orm.Session, team_ids: list[str], query: str, clearance: str, top_k: int = TOP_K
) -> SearchResult:
    """Search the teams' docs. Passages above ``clearance`` are counted as withheld, never returned."""
    docs = list(
        session.scalars(sa.select(models.KnowledgeDoc).where(models.KnowledgeDoc.team_id.in_(team_ids)))
    )
    passages = [
        Passage(d.id, d.title, d.source, d.label, text, source_url=d.source_url)
        for d in docs
        for text in chunks(d.content)
    ]
    ranked = bm25(query, passages, top_k=top_k * 3)
    visible = [p for p in ranked if labels.audience_allows(clearance, p.label)]
    hidden_docs = {p.doc_id for p in ranked if not labels.audience_allows(clearance, p.label)}
    return SearchResult(passages=visible[:top_k], withheld=len(hidden_docs))


# ---------------------------------------------------------------- upkeep: edit, delete, review dates


REVIEW_AFTER = dt.timedelta(
    days=90
)  # A quarter: long enough for stable runbooks, short enough to catch drift.


def is_stale(doc: models.KnowledgeDoc, today: dt.date | None = None) -> bool:
    """True once the doc's review date has passed."""
    return doc.review_by is not None and doc.review_by < (today or models.utcnow().date())


def link(doc_or_passage: models.KnowledgeDoc | Passage, team_slug: str, base_url: str) -> str:
    """A link a person can open: the original when it's on the web, else the doc in Keel."""
    url = getattr(doc_or_passage, "source_url", None) or ""
    src = doc_or_passage.source
    if not url and src.startswith(("http://", "https://")):
        url = src
    if url:
        return url
    doc_id = doc_or_passage.id if isinstance(doc_or_passage, models.KnowledgeDoc) else doc_or_passage.doc_id
    return f"{base_url.rstrip('/')}/teams/{team_slug}/knowledge?doc={doc_id}"


def update(
    session: orm.Session,
    doc: models.KnowledgeDoc,
    actor: str,
    *,
    title: str | None = None,
    content: str | None = None,
    label: str | None = None,
    review_by: dt.date | typing.Literal["keep"] | None = "keep",
) -> models.KnowledgeDoc:
    """Edit a doc by hand. Synced docs are read-only: they'd be overwritten on the next sync."""
    if doc.sync_id:
        raise errors.Conflict("This doc is synced from elsewhere. Edit it at its source.")
    if title is not None:
        if not title.strip():
            raise ValueError("A knowledge doc needs a title.")
        doc.title = title.strip()[:300]
    if content is not None:
        if not content.strip():
            raise ValueError("A knowledge doc needs some content.")
        doc.content = content
    if label is not None:
        labels.rank(label)
        doc.label = label
    if review_by != "keep":
        doc.review_by = review_by
    session.flush()
    feed.audit(session, doc.org_id, actor, "knowledge.edited", doc.source, f"label={doc.label}", doc.team_id)
    return doc


def mark_reviewed(session: orm.Session, doc: models.KnowledgeDoc, actor: str) -> models.KnowledgeDoc:
    """Someone checked it's still true: push the review date a quarter out."""
    doc.review_by = models.utcnow().date() + REVIEW_AFTER
    session.flush()
    feed.audit(
        session,
        doc.org_id,
        actor,
        "knowledge.reviewed",
        doc.source,
        f"review_by={doc.review_by}",
        doc.team_id,
    )
    return doc


def delete(session: orm.Session, doc: models.KnowledgeDoc, actor: str) -> None:
    """Remove a doc. Stewards stop citing it at once."""
    feed.audit(session, doc.org_id, actor, "knowledge.deleted", doc.source, doc.title, doc.team_id)
    session.delete(doc)
    session.flush()


def stale_docs(session: orm.Session, team_id: str) -> list[models.KnowledgeDoc]:
    """Docs past their review date, oldest first."""
    today = models.utcnow().date()
    return list(
        session.scalars(
            sa.select(models.KnowledgeDoc)
            .where(models.KnowledgeDoc.team_id == team_id, models.KnowledgeDoc.review_by < today)
            .order_by(models.KnowledgeDoc.review_by)
        )
    )
