import { useState } from "react";
import { useNavigate } from "react-router";
import { motion } from "motion/react";
import type { CrossTeamEdge, TeamSummary } from "../api/types";
import { alpha } from "../lib/utils";

const W = 560;
const H = 320;
const R = 30;

export function TeamGraph({ teams, edges }: { teams: TeamSummary[]; edges: CrossTeamEdge[] }) {
  const nav = useNavigate();
  const [hover, setHover] = useState<string | null>(null);
  const cx = W / 2;
  const cy = H / 2 + 2;
  const rx = W / 2 - R - 80;
  const ry = H / 2 - R - 42;
  const pos: Record<string, { x: number; y: number }> = {};
  teams.forEach((t, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, teams.length)) * Math.PI * 2;
    pos[t.slug] = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
  const byslug = Object.fromEntries(teams.map((t) => [t.slug, t]));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="Open requests between teams">
      <defs>
        {teams.map((t) => (
          <radialGradient key={t.slug} id={`node-${t.slug}`} cx="35%" cy="30%" r="75%">
            <stop offset="0" stopColor={t.color} stopOpacity="0.6" />
            <stop offset="0.7" stopColor={t.color} stopOpacity="0.16" />
            <stop offset="1" stopColor={t.color} stopOpacity="0.1" />
          </radialGradient>
        ))}
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" fill="var(--faint)" />
        </marker>
        <marker id="arrow-risk" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" fill="var(--bad)" />
        </marker>
      </defs>

      {edges.map((e, i) => {
        const a = pos[e.from_team];
        const b = pos[e.to_team];
        if (!a || !b) return null;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const c = { x: (a.x + b.x) / 2 + nx * 46, y: (a.y + b.y) / 2 + ny * 46 };
        const toward = (p: { x: number; y: number }, q: { x: number; y: number }, d: number) => {
          const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          return { x: p.x + ((q.x - p.x) / l) * d, y: p.y + ((q.y - p.y) / l) * d };
        };
        const s = toward(a, c, R + 5);
        const t = toward(b, c, R + 9);
        const d = `M${s.x},${s.y} Q${c.x},${c.y} ${t.x},${t.y}`;
        const mid = { x: 0.25 * s.x + 0.5 * c.x + 0.25 * t.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * t.y };
        const risky = e.at_risk > 0;
        const dim = hover && hover !== e.from_team && hover !== e.to_team;
        const stroke = risky ? "var(--bad)" : "var(--line-strong)";
        const label = risky ? `${e.open} · ${e.at_risk} at risk` : `${e.open} open`;
        const lw = label.length * 6.1 + 16;
        return (
          <motion.g key={`${e.from_team}-${e.to_team}`} initial={{ opacity: 0 }} animate={{ opacity: dim ? 0.18 : 1 }} transition={{ delay: 0.15 + i * 0.08 }}>
            <path d={d} fill="none" stroke={stroke} strokeOpacity={risky ? 0.35 : 1} strokeWidth={1 + Math.min(e.open, 4) * 0.6} markerEnd={`url(#${risky ? "arrow-risk" : "arrow"})`} />
            <path d={d} fill="none" stroke={risky ? "var(--bad)" : alpha(byslug[e.from_team]?.color ?? "#888", 0.9)} strokeWidth={1.6} className="flow" strokeLinecap="round" />
            <g transform={`translate(${mid.x - lw / 2},${mid.y - 10})`}>
              <rect width={lw} height={20} rx={10} fill="var(--panel)" stroke={risky ? "color-mix(in srgb, var(--bad) 45%, transparent)" : "var(--line-strong)"} />
              <text x={lw / 2} y={13.5} textAnchor="middle" fontSize="11" fontWeight={500} fill={risky ? "var(--bad)" : "var(--muted)"}>
                {label}
              </text>
            </g>
          </motion.g>
        );
      })}

      {teams.map((t, i) => {
        const p = pos[t.slug];
        const above = p.y < cy - 10;
        const ny1 = above ? p.y - R - 24 : p.y + R + 22;
        const ny2 = above ? p.y - R - 10 : p.y + R + 37;
        return (
          <motion.g
            key={t.slug}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: hover && hover !== t.slug ? 0.75 : 1, scale: 1 }}
            transition={{ delay: i * 0.08, type: "spring", stiffness: 260, damping: 20 }}
            style={{ transformOrigin: `${p.x}px ${p.y}px`, cursor: "pointer" }}
            onMouseEnter={() => setHover(t.slug)}
            onMouseLeave={() => setHover(null)}
            onClick={() => nav(`/teams/${t.slug}`)}
          >
            <circle cx={p.x} cy={p.y} r={R + 10} fill={alpha(t.color, 0.07)} />
            <circle cx={p.x} cy={p.y} r={R} fill={`url(#node-${t.slug})`} stroke={alpha(t.color, 0.6)} strokeWidth={1.2} />
            <text x={p.x} y={p.y + 9} textAnchor="middle" fontSize="26" style={{ filter: t.steward.paused ? "grayscale(1)" : undefined }}>
              {t.steward.emoji}
            </text>
            <text x={p.x} y={ny1} textAnchor="middle" fontSize="12.5" fontWeight={600} fill="var(--fg)">
              {t.name}
            </text>
            <text x={p.x} y={ny2} textAnchor="middle" fontSize="11" fill="var(--faint)">
              {t.steward.name} · {t.counts.requests_in} in · {t.counts.requests_out} out
            </text>
          </motion.g>
        );
      })}
    </svg>
  );
}
