"""Small, dependency-free SVGs: README badges and 1200×630 share cards.

Badges follow the shields.io look so they sit well next to CI and coverage badges. Cards are sized for
link previews (Open Graph, Slack unfurls, X/LinkedIn), so a team can paste one anywhere.
"""

from __future__ import annotations

import dataclasses
import html

BADGE_HEIGHT = 20  # shields.io standard height, so ours lines up with other README badges.
BADGE_PAD = 6  # Horizontal padding per side inside each half of a badge.
CARD_W, CARD_H = 1200, 630  # Open Graph image size; Slack, X and LinkedIn all crop to this ratio.
MAX_CARD_LINE = 64  # Characters that fit one card line at the body font size.
COLORS = {
    "green": "#2EA043",
    "lime": "#7BB026",
    "yellow": "#D4A72C",
    "orange": "#E8833A",
    "red": "#D1453B",
    "grey": "#6E7781",
    "purple": "#7C5CFF",
}
_NARROW = set("ijlt.,:;|!'()[] 1")
_WIDE = set("mwMW%@")


def text_width(text: str) -> float:
    """Approximate rendered width of 11px Verdana, the badge font. Good to within a few pixels."""
    w = 0.0
    for ch in text:
        if ch in _NARROW:
            w += 3.9
        elif ch in _WIDE:
            w += 10.0
        elif ch.isupper() or ord(ch) > 0x2000:
            w += 7.6
        else:
            w += 6.6
    return w


def color_for_rate(rate: float | None) -> str:
    """Badge colour for a 0–1 rate; None (nothing to judge yet) is grey."""
    if rate is None:
        return COLORS["grey"]
    for floor, name in ((0.9, "green"), (0.75, "lime"), (0.6, "yellow"), (0.4, "orange")):
        if rate >= floor:
            return COLORS[name]
    return COLORS["red"]


def color_for_grade(grade: str) -> str:
    """Badge colour for a checkup letter grade."""
    return {"A": COLORS["green"], "B": COLORS["lime"], "C": COLORS["yellow"], "D": COLORS["orange"]}.get(
        grade, COLORS["red"]
    )


def badge(label: str, value: str, color: str) -> str:
    """A shields.io-style two-part badge, e.g. ``badge("promises kept", "82%", "#2EA043")``."""
    lw = round(text_width(label) + 2 * BADGE_PAD)
    vw = round(text_width(value) + 2 * BADGE_PAD)
    w = lw + vw
    lab, val = html.escape(label), html.escape(value)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{BADGE_HEIGHT}" role="img" '
        f'aria-label="{lab}: {val}"><title>{lab}: {val}</title>'
        '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/>'
        '<stop offset="1" stop-opacity=".1"/></linearGradient>'
        f'<clipPath id="r"><rect width="{w}" height="{BADGE_HEIGHT}" rx="3" fill="#fff"/></clipPath>'
        f'<g clip-path="url(#r)"><rect width="{lw}" height="{BADGE_HEIGHT}" fill="#3B3355"/>'
        f'<rect x="{lw}" width="{vw}" height="{BADGE_HEIGHT}" fill="{color}"/>'
        f'<rect width="{w}" height="{BADGE_HEIGHT}" fill="url(#s)"/></g>'
        '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" '
        'font-size="11">'
        f'<text x="{lw / 2}" y="15" fill="#010101" fill-opacity=".3">{lab}</text>'
        f'<text x="{lw / 2}" y="14">{lab}</text>'
        f'<text x="{lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">{val}</text>'
        f'<text x="{lw + vw / 2}" y="14">{val}</text></g></svg>'
    )


MAX_ROWS = 4  # more stat rows than this don't fit beside the big number


@dataclasses.dataclass
class Card:
    """What goes on a share card. Every field is plain text; the renderer escapes and truncates."""

    eyebrow: str
    title: str
    big: str
    big_caption: str
    rows: list[tuple[str, str]] = dataclasses.field(default_factory=list)
    quote: str = ""
    accent: str = COLORS["purple"]
    footer: str = "keel · an AI steward for every team"


def _fit(text: str, limit: int = MAX_CARD_LINE) -> str:
    text = " ".join(text.split())
    return html.escape(text if len(text) <= limit else text[: limit - 1].rstrip() + "…")


def card(c: Card) -> str:
    """Render a 1200×630 share card."""
    shown = c.rows[:MAX_ROWS]
    # Rows share the band between the title (y≈216) and the quote box (y=500). Four rows get a
    # smaller label and value so each pair keeps a clear gap from the next.
    roomy = len(shown) <= 3
    step, label_px, value_px, gap = (74, 22, 30, 32) if roomy else (66, 18, 26, 27)
    rows = "".join(
        f'<text x="640" y="{240 + i * step}" font-size="{label_px}" fill="#A99FD6">{_fit(k, 40)}</text>'
        f'<text x="640" y="{240 + gap + i * step}" font-size="{value_px}" font-weight="600" '
        f'fill="#F4F1FF">{_fit(v, 34)}</text>'
        for i, (k, v) in enumerate(shown)
    )
    quote = (
        f'<rect x="72" y="500" width="1056" height="64" rx="14" fill="#ffffff" fill-opacity=".06"/>'
        f'<text x="96" y="541" font-size="24" font-style="italic" fill="#D9D3F5">{_fit(c.quote, 80)}</text>'
        if c.quote
        else ""
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{CARD_W}" height="{CARD_H}" '
        f'viewBox="0 0 {CARD_W} {CARD_H}" role="img" aria-label="{_fit(c.title, 40)}: {_fit(c.big)} {_fit(c.big_caption)}">'
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#140F2E"/><stop offset="1" stop-color="#2A1650"/></linearGradient>'
        '<radialGradient id="glow" cx=".18" cy=".2" r=".6">'
        f'<stop offset="0" stop-color="{c.accent}" stop-opacity=".45"/>'
        f'<stop offset="1" stop-color="{c.accent}" stop-opacity="0"/></radialGradient></defs>'
        f'<rect width="{CARD_W}" height="{CARD_H}" fill="url(#bg)"/>'
        f'<rect width="{CARD_W}" height="{CARD_H}" fill="url(#glow)"/>'
        '<g font-family="Inter,Segoe UI,Helvetica Neue,Arial,sans-serif">'
        f'<text x="72" y="100" font-size="22" letter-spacing="4" fill="{c.accent}" font-weight="700">'
        f"{_fit(c.eyebrow.upper(), 48)}</text>"
        f'<text x="72" y="156" font-size="44" font-weight="700" fill="#FFFFFF">{_fit(c.title, 40)}</text>'
        f'<text x="72" y="350" font-size="168" font-weight="800" fill="#FFFFFF">{_fit(c.big, 6)}</text>'
        f'<text x="76" y="410" font-size="30" fill="#CFC7F2">{_fit(c.big_caption, 30)}</text>'
        f'<line x1="600" y1="216" x2="600" y2="460" stroke="#ffffff" stroke-opacity=".12" stroke-width="2"/>'
        f"{rows}{quote}"
        f'<text x="72" y="604" font-size="20" fill="#8F86B8">⚓ {_fit(c.footer, 70)}</text>'
        "</g></svg>"
    )
