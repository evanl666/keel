// TypeScript port of keel/svg.py so mock mode serves the same badges and share cards as the server.
const COLORS = { green: "#2EA043", lime: "#7BB026", yellow: "#D4A72C", orange: "#E8833A", red: "#D1453B", grey: "#6E7781", purple: "#7C5CFF" };
const NARROW = new Set("ijlt.,:;|!'()[] 1");
const WIDE = new Set("mwMW%@");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function textWidth(text: string) {
  let w = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) w += 3.9;
    else if (WIDE.has(ch)) w += 10;
    else if (ch !== ch.toLowerCase() || ch.charCodeAt(0) > 0x2000) w += 7.6;
    else w += 6.6;
  }
  return w;
}

export function colorForRate(rate: number | null) {
  if (rate === null) return COLORS.grey;
  for (const [floor, c] of [[0.9, COLORS.green], [0.75, COLORS.lime], [0.6, COLORS.yellow], [0.4, COLORS.orange]] as const) if (rate >= floor) return c;
  return COLORS.red;
}

export function colorForGrade(grade: string) {
  return ({ A: COLORS.green, B: COLORS.lime, C: COLORS.yellow, D: COLORS.orange } as Record<string, string>)[grade] ?? COLORS.red;
}

export function badge(label: string, value: string, color: string) {
  const lw = Math.round(textWidth(label) + 12);
  const vw = Math.round(textWidth(value) + 12);
  const w = lw + vw;
  const lab = esc(label);
  const val = esc(value);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${lab}: ${val}"><title>${lab}: ${val}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#3B3355"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${lab}</text><text x="${lw / 2}" y="14">${lab}</text>` +
    `<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${val}</text><text x="${lw + vw / 2}" y="14">${val}</text></g></svg>`
  );
}

const fit = (text: string, limit = 64) => {
  const t = text.split(/\s+/).filter(Boolean).join(" ");
  return esc(t.length <= limit ? t : `${t.slice(0, limit - 1).trimEnd()}…`);
};

export interface CardSpec {
  eyebrow: string;
  title: string;
  big: string;
  bigCaption: string;
  rows: [string, string][];
  quote?: string;
  accent?: string;
}

export function card(c: CardSpec) {
  const accent = c.accent ?? COLORS.purple;
  const shown = c.rows.slice(0, 4);
  const step = shown.length <= 3 ? 74 : 60;
  const rows = shown
    .map(([k, v], i) => `<text x="640" y="${244 + i * step}" font-size="22" fill="#A99FD6">${fit(k, 40)}</text><text x="640" y="${276 + i * step}" font-size="30" font-weight="600" fill="#F4F1FF">${fit(v, 34)}</text>`)
    .join("");
  const quote = c.quote
    ? `<rect x="72" y="500" width="1056" height="64" rx="14" fill="#ffffff" fill-opacity=".06"/><text x="96" y="541" font-size="24" font-style="italic" fill="#D9D3F5">${fit(c.quote, 80)}</text>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${fit(c.title, 40)}: ${fit(c.big)} ${fit(c.bigCaption)}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#140F2E"/><stop offset="1" stop-color="#2A1650"/></linearGradient>` +
    `<radialGradient id="glow" cx=".18" cy=".2" r=".6"><stop offset="0" stop-color="${accent}" stop-opacity=".45"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="1200" height="630" fill="url(#bg)"/><rect width="1200" height="630" fill="url(#glow)"/>` +
    `<g font-family="Inter,Segoe UI,Helvetica Neue,Arial,sans-serif">` +
    `<text x="72" y="100" font-size="22" letter-spacing="4" fill="${accent}" font-weight="700">${fit(c.eyebrow.toUpperCase(), 48)}</text>` +
    `<text x="72" y="156" font-size="44" font-weight="700" fill="#FFFFFF">${fit(c.title, 40)}</text>` +
    `<text x="72" y="350" font-size="168" font-weight="800" fill="#FFFFFF">${fit(c.big, 6)}</text>` +
    `<text x="76" y="410" font-size="30" fill="#CFC7F2">${fit(c.bigCaption, 30)}</text>` +
    `<line x1="600" y1="216" x2="600" y2="460" stroke="#ffffff" stroke-opacity=".12" stroke-width="2"/>` +
    `${rows}${quote}<text x="72" y="604" font-size="20" fill="#8F86B8">⚓ ${fit("keel · an AI steward for every team", 70)}</text></g></svg>`
  );
}
