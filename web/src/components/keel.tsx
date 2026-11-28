import { memo, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "motion/react";
import { Lock, Globe, Building2, ShieldAlert, ArrowRight, SignalHigh, SignalMedium, SignalLow, AlertOctagon } from "lucide-react";
import type { CommitmentStatus, Label, Level, OpStatus, Priority, Risk, ServiceCheck, TeamSummary } from "../api/types";
import { useTeams } from "../api/hooks";
import { cn } from "../lib/utils";
import { due } from "../lib/time";
import { Tooltip } from "./ui";

export function useTeamMap(): Record<string, TeamSummary> {
  const { data } = useTeams();
  return useMemo(() => Object.fromEntries((data ?? []).map((t) => [t.slug, t])), [data]);
}

const AVATAR = { xs: 20, sm: 28, md: 36, lg: 52, xl: 72 } as const;

export function StewardAvatar({ emoji, color, paused, size = "md", className }: { emoji: string; color: string; paused?: boolean; active?: boolean; size?: keyof typeof AVATAR; className?: string }) {
  const px = AVATAR[size];
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full select-none", className)}
      style={{ width: px, height: px, background: `color-mix(in srgb, ${color} 13%, var(--panel))` }}
      title={paused ? "Paused" : undefined}
    >
      <span className={cn("relative leading-none transition-[filter] duration-300", paused && "grayscale opacity-60")} style={{ fontSize: px * 0.54 }}>
        {emoji}
      </span>
    </span>
  );
}

export function LevelBadge({ level, name, className }: { level: Level; name?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[12px] font-medium whitespace-nowrap bg-hover text-soft", className)}>
      <span className="inline-flex gap-[1.5px] items-end h-2.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("w-[2.5px] rounded-[1px]", i < level ? "bg-soft" : "bg-line-strong")} style={{ height: 3 + i * 2 }} />
        ))}
      </span>
      L{level}
      {name && <span className="font-normal text-muted">{name}</span>}
    </span>
  );
}

const LABELS: Record<Label, { cls: string; icon: ReactNode; tip: string }> = {
  public: { cls: "bg-hover text-soft", icon: <Globe className="size-3" />, tip: "Anyone can see this, including other teams." },
  internal: { cls: "bg-hover text-soft", icon: <Building2 className="size-3" />, tip: "Anyone at Acme can see this." },
  confidential: { cls: "bg-warn-soft text-warn", icon: <Lock className="size-3" />, tip: "Only this team and named people can see this." },
  restricted: { cls: "bg-bad-soft text-bad", icon: <ShieldAlert className="size-3" />, tip: "Only named people. Stewards never quote it." },
};

export function LabelBadge({ label, className, withTip = true }: { label: Label; className?: string; withTip?: boolean }) {
  const l = LABELS[label];
  const el = (
    <span className={cn("inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[12px] font-medium capitalize whitespace-nowrap", l.cls, className)}>
      {l.icon}
      {label}
    </span>
  );
  return withTip ? <Tooltip content={l.tip}>{el}</Tooltip> : el;
}

export const OP_STATUS: Record<OpStatus, { label: string; color: string; cls: string; spin?: boolean }> = {
  awaiting_approval: { label: "Awaiting approval", color: "var(--accent)", cls: "bg-accent-soft text-accent" },
  intent_recorded: { label: "Recorded", color: "var(--muted)", cls: "bg-hover text-soft" },
  dispatching: { label: "Sending", color: "var(--accent)", cls: "bg-accent-soft text-accent", spin: true },
  acked: { label: "Acknowledged", color: "var(--accent)", cls: "bg-accent-soft text-accent" },
  unknown: { label: "Checking", color: "var(--warn)", cls: "bg-warn-soft text-warn", spin: true },
  reconciled: { label: "Confirmed", color: "var(--ok)", cls: "bg-ok-soft text-ok" },
  needs_review: { label: "Needs review", color: "var(--warn)", cls: "bg-warn-soft text-warn" },
  done: { label: "Done", color: "var(--ok)", cls: "bg-ok-soft text-ok" },
  failed: { label: "Failed", color: "var(--bad)", cls: "bg-bad-soft text-bad" },
  rejected: { label: "Rejected", color: "var(--muted)", cls: "bg-hover text-soft" },
};

export function OpStatusPill({ status }: { status: OpStatus }) {
  const s = OP_STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 h-5 px-1.5 rounded-md text-[12px] font-medium whitespace-nowrap", s.cls)}>
      {s.spin && <span className="size-1.5 rounded-full live-dot bg-current" />}
      {s.label}
    </span>
  );
}

export const STATUS_META: Record<CommitmentStatus, { label: string; color: string }> = {
  proposed: { label: "Proposed", color: "var(--faint)" },
  accepted: { label: "Accepted", color: "var(--muted)" },
  in_progress: { label: "In progress", color: "var(--warn)" },
  blocked: { label: "Blocked", color: "var(--bad)" },
  done: { label: "Done", color: "var(--accent)" },
  dropped: { label: "Dropped", color: "var(--faint)" },
  declined: { label: "Declined", color: "var(--faint)" },
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
          <path d="M5 8.2 L7.1 10.2 L11 6" fill="none" stroke="var(--panel)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {(status === "dropped" || status === "declined") && (
        <>
          <circle cx="8" cy="8" r={7} fill={c} />
          <path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" />
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
      className={cn("size-2 rounded-full shrink-0", risk === "overdue" && "live-dot", className)}
      style={{ background: r.color }}
    />
  );
}

export function RiskTag({ risk }: { risk: Risk }) {
  if (risk === "none") return null;
  const r = RISK[risk];
  return (
    <span className={cn("inline-flex items-center h-5 px-1.5 rounded-md text-[12px] font-medium whitespace-nowrap", risk === "overdue" ? "bg-bad-soft text-bad" : risk === "at_risk" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}>
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
  const color = team?.color ?? "var(--faint)";
  const el = (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-soft transition-colors", size === "xs" ? "text-[12px]" : "text-[13px]", link && "hover:text-fg")}>
      <span className="size-2 rounded-full shrink-0" style={{ background: color }} />
      {team?.name ?? slug}
    </span>
  );
  return link ? <Link to={`/teams/${slug}`} onClick={(e) => e.stopPropagation()}>{el}</Link> : el;
}

export function TeamFlow({ owner, requester, teams }: { owner: string; requester: string | null; teams: Record<string, TeamSummary> }) {
  if (!requester || requester === owner) return <TeamChip slug={owner} team={teams[owner]} size="xs" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 min-w-0">
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
        "tabular text-[12px] whitespace-nowrap",
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
          style={{ stroke: color }}
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
        <span className="text-[12px] font-semibold tabular">{value}</span>
      </Ring>
    </Tooltip>
  );
}

export const Sparkline = memo(function Sparkline({ checks, color, height = 44 }: { checks: ServiceCheck[]; color: string; height?: number }) {
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
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full block" style={{ height: h }}>
      <path d={line.join(" ")} fill="none" style={{ stroke: color }} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {pts.map((p, i) => (!p.ok ? <rect key={i} x={p.x - 1.5} y={0} width={3} height={h} fill="var(--bad)" opacity={0.35} rx={1} /> : null))}
    </svg>
  );
});

export function UptimeBar({ checks }: { checks: ServiceCheck[] }) {
  return (
    <div className="flex gap-[2px] h-5 items-stretch">
      {checks.map((c, i) => (
        <Tooltip key={i} content={`${new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${c.ok ? `${c.latency_ms} ms` : `HTTP ${c.status_code ?? "—"}`}`} className="flex-1">
          <span className={cn("w-full rounded-[2px] transition-opacity hover:opacity-70", c.ok ? "bg-ok/55" : "bg-bad")} />
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
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M6.5 14.5h19c-1.3 5.2-5.1 8.5-9.5 8.5s-8.2-3.3-9.5-8.5z" fill="var(--ink-fg)" />
      <path d="M16 7.5v15.5" stroke="var(--ink-fg)" strokeWidth="1.9" strokeLinecap="round" />
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

export function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", className)} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function SlackGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", className)} fill="currentColor" aria-hidden>
      <path d="M3.4 10.1a1.7 1.7 0 1 1-1.7-1.7h1.7v1.7zm.8 0a1.7 1.7 0 1 1 3.4 0v4.2a1.7 1.7 0 1 1-3.4 0v-4.2zM5.9 3.4a1.7 1.7 0 1 1 1.7-1.7v1.7H5.9zm0 .8a1.7 1.7 0 1 1 0 3.4H1.7a1.7 1.7 0 1 1 0-3.4h4.2zm6.7 1.7a1.7 1.7 0 1 1 1.7 1.7h-1.7V5.9zm-.8 0a1.7 1.7 0 1 1-3.4 0V1.7a1.7 1.7 0 1 1 3.4 0v4.2zm-1.7 6.7a1.7 1.7 0 1 1-1.7 1.7v-1.7h1.7zm0-.8a1.7 1.7 0 1 1 0-3.4h4.2a1.7 1.7 0 1 1 0 3.4h-4.2z" />
    </svg>
  );
}
