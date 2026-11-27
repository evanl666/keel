import { memo, useId, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "motion/react";
import { Lock, Globe, Building2, ShieldAlert, ArrowRight, SignalHigh, SignalMedium, SignalLow, AlertOctagon } from "lucide-react";
import type { CommitmentStatus, Label, Level, OpStatus, Priority, Risk, ServiceCheck, TeamSummary } from "../api/types";
import { useTeams } from "../api/hooks";
import { cn, alpha } from "../lib/utils";
import { due } from "../lib/time";
import { Tooltip } from "./ui";

export function useTeamMap(): Record<string, TeamSummary> {
  const { data } = useTeams();
  return useMemo(() => Object.fromEntries((data ?? []).map((t) => [t.slug, t])), [data]);
}

const AVATAR = { xs: 20, sm: 28, md: 36, lg: 52, xl: 72 } as const;

export function StewardAvatar({ emoji, color, paused, active = true, size = "md", className }: { emoji: string; color: string; paused?: boolean; active?: boolean; size?: keyof typeof AVATAR; className?: string }) {
  const px = AVATAR[size];
  const breathe = active && !paused && px >= 36;
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full select-none", breathe && "breathe", className)}
      style={{ width: px, height: px, ["--ring" as string]: color }}
      title={paused ? "Paused" : undefined}
    >
      <span
        className={cn("absolute inset-0 rounded-full transition-[filter] duration-500", paused && "grayscale opacity-60")}
        style={{
          background: `radial-gradient(circle at 30% 25%, ${alpha(color, 0.55)}, ${alpha(color, 0.18)} 60%, ${alpha(color, 0.1)})`,
          boxShadow: `inset 0 0 0 1px ${alpha(color, 0.45)}, 0 ${px / 8}px ${px / 2.5}px -${px / 6}px ${alpha(color, 0.7)}`,
        }}
      />
      <span className={cn("relative leading-none transition-[filter] duration-500", paused && "grayscale opacity-70")} style={{ fontSize: px * 0.52 }}>
        {emoji}
      </span>
    </span>
  );
}

const LEVEL_TONES = ["var(--lv0)", "var(--lv1)", "var(--lv2)", "var(--lv3)", "var(--lv4)"];

export function LevelBadge({ level, name, className }: { level: Level; name?: string; className?: string }) {
  const c = LEVEL_TONES[level];
  return (
    <span
      className={cn("inline-flex items-center gap-1 h-5 pl-1 pr-1.5 rounded-md text-[11px] font-semibold border whitespace-nowrap", className)}
      style={{ color: c, borderColor: alpha(c, 0.32), background: alpha(c, 0.1) }}
    >
      <span className="inline-flex gap-[1.5px] items-end h-2.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="w-[2.5px] rounded-[1px]" style={{ height: 3 + i * 2, background: i < level ? c : alpha(c, 0.3) }} />
        ))}
      </span>
      L{level}
      {name && <span className="font-medium opacity-85">{name}</span>}
    </span>
  );
}

const LABELS: Record<Label, { color: string; icon: ReactNode; tip: string }> = {
  public: { color: "var(--t-green2)", icon: <Globe className="size-3" />, tip: "Anyone can see this, including other teams." },
  internal: { color: "var(--t-blue)", icon: <Building2 className="size-3" />, tip: "Anyone at Acme can see this." },
  confidential: { color: "var(--t-amber)", icon: <Lock className="size-3" />, tip: "Only this team and named people can see this." },
  restricted: { color: "var(--t-red)", icon: <ShieldAlert className="size-3" />, tip: "Only named people. Stewards never quote it." },
};

export function LabelBadge({ label, className, withTip = true }: { label: Label; className?: string; withTip?: boolean }) {
  const l = LABELS[label];
  const el = (
    <span
      className={cn("inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11px] font-medium border capitalize whitespace-nowrap", className)}
      style={{ color: l.color, borderColor: alpha(l.color, 0.3), background: alpha(l.color, 0.09) }}
    >
      {l.icon}
      {label}
    </span>
  );
  return withTip ? <Tooltip content={l.tip}>{el}</Tooltip> : el;
}

export const OP_STATUS: Record<OpStatus, { label: string; color: string; spin?: boolean }> = {
  awaiting_approval: { label: "Awaiting approval", color: "var(--t-violet)" },
  intent_recorded: { label: "Recorded", color: "var(--t-gray)" },
  dispatching: { label: "Sending", color: "var(--t-blue)", spin: true },
  acked: { label: "Acknowledged", color: "var(--t-sky)" },
  unknown: { label: "Checking", color: "var(--t-amber)", spin: true },
  reconciled: { label: "Confirmed", color: "var(--t-green)" },
  needs_review: { label: "Needs review", color: "var(--t-orange)" },
  done: { label: "Done", color: "var(--t-green2)" },
  failed: { label: "Failed", color: "var(--t-red)" },
  rejected: { label: "Rejected", color: "var(--t-gray)" },
};

export function OpStatusPill({ status }: { status: OpStatus }) {
  const s = OP_STATUS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full text-[11.5px] font-medium border whitespace-nowrap"
      style={{ color: s.color, borderColor: alpha(s.color, 0.28), background: alpha(s.color, 0.1) }}
    >
      <span className={cn("size-1.5 rounded-full", s.spin && "live-dot")} style={{ background: s.color, color: s.color }} />
      {s.label}
    </span>
  );
}

export const STATUS_META: Record<CommitmentStatus, { label: string; color: string }> = {
  proposed: { label: "Proposed", color: "var(--t-gray)" },
  accepted: { label: "Accepted", color: "#a1a7b3" },
  in_progress: { label: "In progress", color: "var(--t-yellow)" },
  blocked: { label: "Blocked", color: "var(--t-red)" },
  done: { label: "Done", color: "var(--t-indigo)" },
  dropped: { label: "Dropped", color: "#6c727e" },
  declined: { label: "Declined", color: "#6c727e" },
};

export function StatusIcon({ status, size = 14 }: { status: CommitmentStatus; size?: number }) {
  const c = STATUS_META[status].color;
  const r = 6;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" aria-label={STATUS_META[status].label}>
      {status === "proposed" && <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="2.2 2.2" />}
      {status === "accepted" && <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" />}
      {status === "in_progress" && (
        <>
          <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M8 4.5 A3.5 3.5 0 0 1 8 11.5 Z" fill={c} />
        </>
      )}
      {status === "blocked" && (
        <>
          <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M4.2 11.8 L11.8 4.2" stroke={c} strokeWidth="1.6" />
        </>
      )}
      {status === "done" && (
        <>
          <circle cx="8" cy="8" r={7} fill={c} />
          <path d="M5 8.2 L7.1 10.2 L11 6" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {(status === "dropped" || status === "declined") && (
        <>
          <circle cx="8" cy="8" r={7} fill={c} />
          <path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

const RISK: Record<Risk, { color: string; label: string }> = {
  on_track: { color: "var(--ok)", label: "On track" },
  at_risk: { color: "var(--warn)", label: "At risk" },
  overdue: { color: "var(--bad)", label: "Overdue" },
  none: { color: "transparent", label: "" },
};

export function RiskDot({ risk, className }: { risk: Risk; className?: string }) {
  if (risk === "none") return <span className={cn("size-2 shrink-0", className)} />;
  const r = RISK[risk];
  return (
    <span
      title={r.label}
      className={cn("size-2 rounded-full shrink-0", risk !== "on_track" && "live-dot", className)}
      style={{ background: r.color, color: r.color }}
    />
  );
}

export function RiskTag({ risk }: { risk: Risk }) {
  if (risk === "none") return null;
  const r = RISK[risk];
  return (
    <span className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full text-[11.5px] font-medium border" style={{ color: r.color, borderColor: `color-mix(in srgb, ${r.color} 30%, transparent)`, background: `color-mix(in srgb, ${r.color} 10%, transparent)` }}>
      <span className="size-1.5 rounded-full" style={{ background: r.color }} />
      {r.label}
    </span>
  );
}

export function PriorityIcon({ priority }: { priority: Priority }) {
  const cls = "size-3.5 shrink-0";
  if (priority === "urgent") return <span title="Urgent"><AlertOctagon className={cn(cls, "text-bad")} /></span>;
  if (priority === "high") return <span title="High"><SignalHigh className={cn(cls, "text-muted")} /></span>;
  if (priority === "normal") return <span title="Normal"><SignalMedium className={cn(cls, "text-faint")} /></span>;
  return <span title="Low"><SignalLow className={cn(cls, "text-faint/70")} /></span>;
}

export function TeamChip({ slug, team, size = "sm", link = false }: { slug: string; team?: TeamSummary; size?: "xs" | "sm"; link?: boolean }) {
  const color = team?.color ?? "var(--t-gray)";
  const el = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border whitespace-nowrap font-medium transition-colors",
        size === "xs" ? "h-5 px-1.5 text-[11px]" : "h-[22px] px-2 text-[12px]",
        link && "hover:brightness-125",
      )}
      style={{ color, borderColor: alpha(color, 0.28), background: alpha(color, 0.1) }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {team?.name ?? slug}
    </span>
  );
  return link ? <Link to={`/teams/${slug}`} onClick={(e) => e.stopPropagation()}>{el}</Link> : el;
}

export function TeamFlow({ owner, requester, teams }: { owner: string; requester: string | null; teams: Record<string, TeamSummary> }) {
  if (!requester || requester === owner) return <TeamChip slug={owner} team={teams[owner]} size="xs" />;
  return (
    <span className="inline-flex items-center gap-1">
      <TeamChip slug={requester} team={teams[requester]} size="xs" />
      <ArrowRight className="size-3 text-faint" />
      <TeamChip slug={owner} team={teams[owner]} size="xs" />
    </span>
  );
}

export function DueText({ iso, className }: { iso: string | null; className?: string }) {
  const d = due(iso);
  return (
    <span
      className={cn(
        "tabular text-[12.5px] whitespace-nowrap",
        d.tone === "overdue" ? "text-bad font-medium" : d.tone === "soon" ? "text-warn" : d.tone === "none" ? "text-faint" : "text-muted",
        className,
      )}
      title={iso ? new Date(iso).toLocaleString() : undefined}
    >
      {d.text}
    </span>
  );
}

export function healthColor(v: number) {
  return v >= 80 ? "var(--ok)" : v >= 60 ? "var(--warn)" : "var(--bad)";
}

export function Ring({ value, size = 56, stroke = 5, color, children, track = "var(--line)" }: { value: number; size?: number; stroke?: number; color: string; children?: ReactNode; track?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.max(0, Math.min(100, value)) / 100) }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          style={{ stroke: color, filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} 45%, transparent))` }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">{children}</span>
    </span>
  );
}

export function HealthRing({ value, size = 52 }: { value: number; size?: number }) {
  return (
    <Tooltip content={`Team health ${value}/100: risk, overdue, incidents and open reviews.`}>
      <Ring value={value} size={size} stroke={4.5} color={healthColor(value)}>
        <span className="text-[13px] font-semibold tabular">{value}</span>
      </Ring>
    </Tooltip>
  );
}

export const Sparkline = memo(function Sparkline({ checks, color, height = 44 }: { checks: ServiceCheck[]; color: string; height?: number }) {
  const gid = "sg-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const w = 240;
  const h = height;
  const pts = useMemo(() => {
    const lats = checks.map((c) => c.latency_ms ?? 0);
    const max = Math.max(1, ...lats) * 1.15;
    const step = checks.length > 1 ? w / (checks.length - 1) : w;
    return checks.map((c, i) => ({ x: i * step, y: c.latency_ms == null ? null : h - 6 - ((c.latency_ms ?? 0) / max) * (h - 12), ok: c.ok }));
  }, [checks, h]);
  if (!checks.length) return <div className="h-11 grid place-items-center text-[12px] text-faint">No checks yet</div>;
  const line: string[] = [];
  let pen = false;
  for (const p of pts) {
    if (p.y == null) {
      pen = false;
      continue;
    }
    line.push(`${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    pen = true;
  }
  const valid = pts.filter((p) => p.y != null);
  const area = valid.length ? `M${valid[0].x},${h} ${valid.map((p) => `L${p.x.toFixed(1)},${p.y!.toFixed(1)}`).join(" ")} L${valid[valid.length - 1].x},${h} Z` : "";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full block" style={{ height: h }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line.join(" ")} fill="none" style={{ stroke: color }} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {pts.map((p, i) => (!p.ok ? <rect key={i} x={p.x - 1.5} y={0} width={3} height={h} fill="var(--bad)" opacity={0.55} rx={1} /> : null))}
    </svg>
  );
});

export function UptimeBar({ checks }: { checks: ServiceCheck[] }) {
  return (
    <div className="flex gap-[2px] h-5 items-stretch">
      {checks.map((c, i) => (
        <Tooltip key={i} content={`${new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${c.ok ? `${c.latency_ms} ms` : `HTTP ${c.status_code ?? "—"}`}`} className="flex-1">
          <span className={cn("w-full rounded-[2px] transition-opacity hover:opacity-70", c.ok ? "bg-ok/70" : "bg-bad")} />
        </Tooltip>
      ))}
    </div>
  );
}

export function Markdown({ children, compact }: { children: string; compact?: boolean }) {
  return (
    <div className={cn("prose-keel", compact && "compact")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/") ? <Link to={href}>{children}</Link> : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function KeelMark({ size = 28 }: { size?: number }) {
  // Unique gradient ids: two marks can be on the page and one may be display:none.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={`keel-g${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a5b0ff" />
          <stop offset="1" stopColor="#5b6cff" />
        </linearGradient>
        <linearGradient id={`keel-bg${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1d2a" />
          <stop offset="1" stopColor="#0b0d14" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#keel-bg${uid})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="none" stroke="rgba(255,255,255,0.12)" />
      <path d="M6 14.5h20c-1.3 5.4-5.4 8.8-10 8.8S7.3 19.9 6 14.5z" fill={`url(#keel-g${uid})`} />
      <path d="M16 7.5v15.8" stroke="#dfe3ff" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 25.8c2.4-1 5-1 7.5 0s5.1 1 7.5 0" stroke="var(--t-indigo)" strokeOpacity="0.55" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export const DUTY_META: Record<string, { label: string; icon: string }> = {
  ledger: { label: "Ledger", icon: "📒" },
  front_desk: { label: "Front desk", icon: "🛎️" },
  rhythm: { label: "Rhythm", icon: "☀️" },
  services: { label: "Services", icon: "🩺" },
  knowledge: { label: "Knowledge", icon: "📚" },
  chores: { label: "Chores", icon: "🧹" },
};
