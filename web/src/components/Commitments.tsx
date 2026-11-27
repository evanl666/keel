import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import type { Commitment, CommitmentStatus, TeamSummary } from "../api/types";
import { cn } from "../lib/utils";
import { DueText, LabelBadge, PriorityIcon, RiskDot, STATUS_META, StatusIcon, TeamFlow } from "./keel";
import { Tooltip } from "./ui";

export const STATUS_ORDER: CommitmentStatus[] = ["in_progress", "blocked", "accepted", "proposed", "done", "dropped", "declined"];
const CLOSED = new Set<CommitmentStatus>(["done", "dropped", "declined"]);
const RISK_RANK = { overdue: 0, at_risk: 1, on_track: 2, none: 3 } as const;

export function sortCommitments(list: Commitment[]) {
  return [...list].sort(
    (a, b) =>
      RISK_RANK[a.risk] - RISK_RANK[b.risk] ||
      (a.due_at ? Date.parse(a.due_at) : Infinity) - (b.due_at ? Date.parse(b.due_at) : Infinity) ||
      a.key.localeCompare(b.key),
  );
}

function Person({ name }: { name: string | null }) {
  if (!name) return <Tooltip content="No owner yet"><span className="grid size-[22px] place-items-center rounded-full border border-dashed border-line-strong text-[10px] text-faint">?</span></Tooltip>;
  const initials = name.split(" ").map((p) => p[0]).join("").slice(0, 2);
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <Tooltip content={name}>
      <span className="grid size-[22px] place-items-center rounded-full text-[9.5px] font-semibold text-white/95" style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 58%), hsl(${(hue + 40) % 360} 55% 45%))` }}>
        {initials}
      </span>
    </Tooltip>
  );
}

export function CommitmentRow({ c, teams, showTeams = true }: { c: Commitment; teams: Record<string, TeamSummary>; showTeams?: boolean }) {
  const nav = useNavigate();
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      onClick={() => nav(`/commitments/${c.key}`)}
      onKeyDown={(e) => e.key === "Enter" && nav(`/commitments/${c.key}`)}
      tabIndex={0}
      role="link"
      className="group flex items-center gap-2.5 sm:gap-3 h-11 sm:h-[42px] px-4 border-t border-line first:border-t-0 cursor-pointer hover:bg-hover focus:bg-hover outline-none transition-colors"
    >
      <RiskDot risk={c.risk} />
      <span className="max-sm:hidden inline-flex shrink-0"><PriorityIcon priority={c.priority} /></span>
      <span className="w-11 shrink-0 font-mono text-[12px] text-faint">{c.key}</span>
      <StatusIcon status={c.status} />
      <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", CLOSED.has(c.status) ? "text-faint" : "text-fg")}>{c.title}</span>
      {(c.label === "confidential" || c.label === "restricted") && <LabelBadge label={c.label} className="max-sm:hidden" />}
      {showTeams && (
        <span className="hidden lg:inline-flex">
          <TeamFlow owner={c.owner_team} requester={c.requester_team} teams={teams} />
        </span>
      )}
      <span className="max-sm:hidden inline-flex shrink-0"><Person name={c.owner_person} /></span>
      <span className="sm:w-[86px] text-right shrink-0">
        {CLOSED.has(c.status) ? <span className="text-[12.5px] text-faint">{STATUS_META[c.status].label}</span> : <DueText iso={c.due_at} />}
      </span>
    </motion.div>
  );
}

export function CommitmentList({ items, teams, showTeams = true }: { items: Commitment[]; teams: Record<string, TeamSummary>; showTeams?: boolean }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ dropped: true, declined: true });
  const groups = useMemo(() => {
    return STATUS_ORDER.map((s) => [s, sortCommitments(items.filter((c) => c.status === s))] as const).filter(([, l]) => l.length);
  }, [items]);
  return (
    <div className="rounded-xl border border-line bg-panel shadow-card overflow-hidden">
      {groups.map(([s, list]) => {
        const closed = collapsed[s];
        return (
          <div key={s} className="border-t border-line first:border-t-0">
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [s]: !c[s] }))}
              className="w-full flex items-center gap-2.5 h-10 lg:h-9 px-4 bg-panel-2 text-left cursor-pointer hover:bg-hover transition-colors"
            >
              <ChevronRight className={cn("size-3.5 text-faint transition-transform", !closed && "rotate-90")} />
              <StatusIcon status={s} />
              <span className="text-[12.5px] font-semibold">{STATUS_META[s].label}</span>
              <span className="text-[12px] text-faint tabular">{list.length}</span>
            </button>
            <AnimatePresence initial={false}>
              {!closed && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t border-line">
                  <AnimatePresence initial={false}>
                    {list.map((c) => (
                      <CommitmentRow key={c.key} c={c} teams={teams} showTeams={showTeams} />
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

const BOARD: CommitmentStatus[] = ["proposed", "accepted", "in_progress", "blocked", "done"];

export function CommitmentBoard({ items, teams }: { items: Commitment[]; teams: Record<string, TeamSummary> }) {
  const nav = useNavigate();
  return (
    <div className="flex max-lg:items-start gap-3 scroll-x snap-x snap-mandatory scroll-px-4 -mx-4 px-4 sm:scroll-px-6 sm:-mx-6 sm:px-6 lg:grid lg:grid-cols-5 lg:mx-0 lg:px-0 lg:overflow-visible">
      {BOARD.map((s) => {
        const list = sortCommitments(items.filter((c) => c.status === s));
        return (
          <div key={s} className="w-[min(272px,80vw)] shrink-0 snap-start lg:w-auto lg:shrink min-w-0 rounded-xl border border-line bg-sunken/60 p-2">
            <div className="flex items-center gap-2 px-1.5 h-8">
              <StatusIcon status={s} />
              <span className="text-[12.5px] font-semibold">{STATUS_META[s].label}</span>
              <span className="text-[12px] text-faint tabular">{list.length}</span>
            </div>
            <div className="space-y-2 mt-1">
              <AnimatePresence initial={false}>
                {list.map((c) => (
                  <motion.button
                    layout
                    layoutId={`card-${c.key}`}
                    key={c.key}
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    onClick={() => nav(`/commitments/${c.key}`)}
                    className="w-full text-left rounded-lg border border-line bg-panel p-3 shadow-soft hover:border-line-strong transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 text-[11.5px] text-faint">
                      <RiskDot risk={c.risk} />
                      <span className="font-mono">{c.key}</span>
                      <span className="ml-auto"><PriorityIcon priority={c.priority} /></span>
                    </div>
                    <div className={cn("mt-1.5 text-[13px] leading-snug line-clamp-2", s === "done" ? "text-muted" : "text-fg")}>{c.title}</div>
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                      <TeamFlow owner={c.owner_team} requester={c.requester_team} teams={teams} />
                      {s !== "done" && <DueText iso={c.due_at} className="text-[11.5px] ml-auto whitespace-nowrap" />}
                    </div>
                  </motion.button>
                ))}
              </AnimatePresence>
              {!list.length && <div className="text-center text-[12px] text-faint py-6">Empty</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
