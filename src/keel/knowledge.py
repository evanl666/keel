"""Team knowledge: store docs with labels, search with BM25, and never return what the audience can't see."""

from __future__ import annotations

import collections
import dataclasses
import math
import re

import sqlalchemy as sa
from sqlalchemy import orm

from keel import feed, labels, models

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


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens without stopwords. Empty text gives an empty list."""
    return [t for t in _TOKEN.findall(text.lower()) if t not in STOPWORDS]


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
) -> models.KnowledgeDoc:
    """Add or replace a document (same team + source replaces)."""
    labels.rank(label)
    if not content.strip():
        raise ValueError("A knowledge doc needs some content.")
    source = source or f"keel://{team.slug}/{re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')}"
    doc = session.scalar(
        sa.select(models.KnowledgeDoc).where(
            models.KnowledgeDoc.team_id == team.id, models.KnowledgeDoc.source == source
        )
    )
    if doc is None:
        doc = models.KnowledgeDoc(
            org_id=team.org_id, team_id=team.id, title=title, source=source, label=label, content=content
        )
        session.add(doc)
        verb = "added"
    else:
        doc.title, doc.label, doc.content = title, label, content
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
    passages = [Passage(d.id, d.title, d.source, d.label, text) for d in docs for text in chunks(d.content)]
    ranked = bm25(query, passages, top_k=top_k * 3)
    visible = [p for p in ranked if labels.audience_allows(clearance, p.label)]
    hidden_docs = {p.doc_id for p in ranked if not labels.audience_allows(clearance, p.label)}
    return SearchResult(passages=visible[:top_k], withheld=len(hidden_docs))
