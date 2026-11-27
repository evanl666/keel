"""Sensitivity labels and the output gate's audience rules."""

from __future__ import annotations

import collections.abc

ORDER: tuple[str, ...] = ("public", "internal", "confidential", "restricted")
RANK: dict[str, int] = {name: i for i, name in enumerate(ORDER)}


def rank(label: str) -> int:
    """Return the numeric rank of ``label``; raises ValueError for unknown labels."""
    try:
        return RANK[label]
    except KeyError:
        raise ValueError(f"unknown label {label!r}; expected one of {', '.join(ORDER)}") from None


def strictest(labels: collections.abc.Iterable[str], default: str = "public") -> str:
    """Return the strictest label in ``labels``, or ``default`` when it is empty.

    Derived text (a summary, an answer) takes the strictest label of everything it used.
    """
    best = default
    for label in labels:
        if rank(label) > rank(best):
            best = label
    return best


def audience_allows(audience_max: str, content_label: str) -> bool:
    """True when an audience cleared up to ``audience_max`` may see ``content_label`` content."""
    return rank(content_label) <= rank(audience_max)


def audience_max_for_target(target_kind: str) -> str:
    """Default clearance for a destination kind.

    - ``team``: the team's own channel or members → confidential (not restricted).
    - ``org``: another team's channel, cross-team request → internal.
    - ``external``: shared/Connect channels, public repos → public.
    - ``admins``: approval cards seen by team admins → restricted.
    """
    return {"team": "confidential", "org": "internal", "external": "public", "admins": "restricted"}.get(
        target_kind, "public"
    )
