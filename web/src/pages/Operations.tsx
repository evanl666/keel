import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, RotateCcw, Ban, ExternalLink, Eye } from "lucide-react";
import { errorLine } from "../api/client";
import { useOperations, useResolveOperation } from "../api/hooks";
import type { OpStatus, Operation, ResolveOutcome } from "../api/types";
import { Button, Card, EmptyState, PageHeader, Segmented, SkeletonRows } from "../components/ui";
import { OpStatusPill, TeamChip, useTeamMap } from "../components/keel";
import { useToast } from "../components/toast";
import { ago, fullDate } from "../lib/time";
import { cn } from "../lib/utils";

type Filter = "all" | "in_flight" | "done" | "failed";

const IN_FLIGHT: OpStatus[] = ["awaiting_approval", "intent_recorded", "dispatching", "acked", "unknown", "reconciled"];
const FINISHED_BAD: OpStatus[] = ["failed", "rejected"];

const STEPS: OpStatus[] = ["intent_recorded", "dispatching", "acked", "reconciled", "done"];

function Steps({ status }: { status: OpStatus }) {
  const idx = status === "unknown" ? 2 : status === "needs_review" ? 3 : STEPS.indexOf(status);
  const bad = status === "failed" || status === "rejected";
  return (
    <div className="flex items-center gap-[3px]" title={`intent → dispatch → ack → reconcile → done`}>
      {STEPS.map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-[5px] w-3 rounded-full transition-colors",
            bad ? "bg-bad/35" : i < idx || status === "done" ? "bg-ok/80" : i === idx ? (status === "needs_review" || status === "unknown" ? "bg-[#fb923c]" : "bg-accent") : "bg-line-strong",
          )}
        />
      ))}
    </div>
  );
}

function ReviewCard({ o }: { o: Operation }) {
  const resolve = useResolveOperation();
  const toast = useToast();
  const teams = useTeamMap();
  const [pending, setPending] = useState<ResolveOutcome | null>(null);
  const run = (outcome: ResolveOutcome) => {
    setPending(outcome);
    resolve.mutate(
      { id: o.id, outcome },
      {
        onSuccess: () =>
          toast({
            title: outcome === "done" ? "Marked done" : outcome === "retry" ? "Retrying with the same op_id" : "Cancelled",
            line: outcome === "retry" ? "If the first try did land, the target sees the same op_id and won't double up." : o.summary,
            icon: outcome === "done" ? "✅" : outcome === "retry" ? "🔁" : "🛑",
          }),
        onError: (e) => toast({ title: "Not changed", line: errorLine(e), tone: "bad" }),
        onSettled: () => setPending(null),
      },
    );
  };
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 60, transition: { duration: 0.25 } }} className="px-4 sm:px-5 py-4 border-t border-[#fb923c]/15 first:border-t-0">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <OpStatusPill status={o.status} />
            <span className="font-medium text-[14px] truncate">{o.summary}</span>
          </div>
          <div className="mt-2 text-[13px] text-[#fb923c] flex items-start gap-2 leading-snug">
            <span className="mt-[6px] size-1.5 rounded-full bg-current shrink-0" />
            {o.error_line ?? "Keel didn't hear back after sending."}
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap text-[12px] text-faint">
            <TeamChip slug={o.team_slug} team={teams[o.team_slug]} size="xs" />
            <code className="max-w-full truncate font-mono text-[11.5px] text-muted bg-hover border border-line rounded px-1.5 py-px" title={o.op_id}>{o.op_id}</code>
            <span>
              {o.kind} → <span className="font-mono text-[11.5px]">{o.target}</span>
            </span>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <span>· {o.attempts} {o.attempts === 1 ? "attempt" : "attempts"}</span>
              <span title={fullDate(o.updated_at)}>· {ago(o.updated_at)}</span>
            </span>
            {o.remote_ref && (
              <a href={o.remote_ref.startsWith("http") ? o.remote_ref : undefined} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                <ExternalLink className="size-3" /> Check target
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} loading={pending === "cancel"} disabled={!!pending} onClick={() => run("cancel")}>
            Cancel
          </Button>
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={pending === "retry"} disabled={!!pending} onClick={() => run("retry")}>
            Retry
          </Button>
          <Button size="sm" variant="success" icon={<Check className="size-3.5" />} loading={pending === "done"} disabled={!!pending} onClick={() => run("done")}>
            Mark done
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

export function Operations() {
  const { data, isLoading } = useOperations();
  const teams = useTeamMap();
  const [filter, setFilter] = useState<Filter>("all");
  const [team, setTeam] = useState("");

  const review = useMemo(() => (data ?? []).filter((o) => o.status === "needs_review"), [data]);
  const rest = useMemo(() => {
    const list = (data ?? []).filter((o) => o.status !== "needs_review" && (!team || o.team_slug === team));
    const f = list.filter((o) =>
      filter === "all" ? true : filter === "in_flight" ? IN_FLIGHT.includes(o.status) : filter === "done" ? o.status === "done" : FINISHED_BAD.includes(o.status),
    );
    return f.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [data, filter, team]);
  const countOf = (f: Filter) =>
    (data ?? []).filter(
      (o) =>
        o.status !== "needs_review" &&
        (!team || o.team_slug === team) &&
        (f === "all" ? true : f === "in_flight" ? IN_FLIGHT.includes(o.status) : f === "done" ? o.status === "done" : FINISHED_BAD.includes(o.status)),
    ).length;

  return (
    <div>
      <PageHeader
        title="Outbox"
        sub="Every write a steward makes, with a stable op_id. If an outcome is unclear, Keel checks before it retries."
        right={
          <div className="flex items-center gap-1 max-w-full scroll-x">
            {[{ slug: "", name: "All teams" }, ...Object.values(teams)].map((t) => (
              <button
                key={t.slug}
                onClick={() => setTeam(t.slug)}
                className={cn(
                  "shrink-0 whitespace-nowrap h-7 max-sm:h-10 max-sm:px-3 px-2.5 rounded-md text-[12.5px] cursor-pointer transition-colors flex items-center gap-1.5",
                  team === t.slug ? "bg-hover text-fg border border-line" : "text-muted hover:text-fg border border-transparent",
                )}
              >
                {"steward" in t && <span className="size-1.5 rounded-full" style={{ background: (t as { color: string }).color }} />}
                {t.name}
              </button>
            ))}
          </div>
        }
      />

      <AnimatePresence initial={false}>
        {review.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-6">
            <Card className="overflow-hidden border-[#fb923c]/30" glow="rgba(251,146,60,0.09)">
              <div className="flex items-center gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-[#fb923c]/15">
                <span className="grid shrink-0 place-items-center size-7 rounded-lg bg-[#fb923c]/15 text-[#fb923c]">
                  <Eye className="size-4" />
                </span>
                <div>
                  <div className="text-[14px] font-semibold">
                    Needs review <span className="text-[#fb923c] tabular ml-1">{review.length}</span>
                  </div>
                  <div className="text-[12.5px] text-muted">Keel couldn't tell if these went through. Check, then mark done or retry.</div>
                </div>
              </div>
              <AnimatePresence initial={false}>
                {review.map((o) => (
                  <ReviewCard key={o.id} o={o} />
                ))}
              </AnimatePresence>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: countOf("all") },
            { value: "in_flight", label: "In flight", count: countOf("in_flight") },
            { value: "done", label: "Done", count: countOf("done") },
            { value: "failed", label: "Failed", count: countOf("failed") },
          ]}
        />
        <div className="text-[12px] text-faint flex items-center gap-2">
          <span className="flex items-center gap-1.5">
            <span className="live-dot size-1.5 rounded-full bg-ok" /> Updates every few seconds
          </span>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="hidden xl:grid grid-cols-[150px_minmax(0,1fr)_110px_190px_90px] gap-4 px-5 h-9 items-center border-b border-line text-[11px] uppercase tracking-[0.07em] text-faint bg-sunken/60">
          <span>Status</span>
          <span>Operation</span>
          <span>Team</span>
          <span>op_id</span>
          <span className="text-right">Updated</span>
        </div>
        {isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={6} />
          </div>
        ) : !rest.length ? (
          <EmptyState icon="📭" title="Nothing here" line="When a steward sends something, it shows up here with its op_id." />
        ) : (
          <motion.div layout>
            <AnimatePresence initial={false}>
              {rest.map((o) => (
                <motion.div
                  key={o.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] [grid-template-areas:'status_status_updated'_'op_op_op'_'team_id_id'] gap-x-3 gap-y-2 px-4 sm:px-5 py-3 items-center xl:items-start xl:grid-cols-[150px_minmax(0,1fr)_110px_190px_90px] xl:[grid-template-areas:none] xl:gap-4 border-b border-line last:border-b-0 hover:bg-hover/60 transition-colors"
                >
                  <div className="[grid-area:status] xl:[grid-area:auto] flex items-center gap-3 xl:flex-col xl:items-start xl:gap-1.5 pt-px">
                    <OpStatusPill status={o.status} />
                    <Steps status={o.status} />
                  </div>
                  <div className="[grid-area:op] xl:[grid-area:auto] min-w-0">
                    <div className="text-[13px] truncate">{o.summary}</div>
                    <div className="mt-0.5 text-[12px] text-faint truncate">
                      {o.kind} → <span className="font-mono text-[11.5px]">{o.target}</span>
                      {o.attempts > 1 && <span> · {o.attempts} attempts</span>}
                      {o.remote_ref && (
                        <>
                          {" · "}
                          <a href={o.remote_ref.startsWith("http") ? o.remote_ref : undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                            {o.remote_ref.startsWith("http") ? "open" : o.remote_ref}
                          </a>
                        </>
                      )}
                    </div>
                    {o.error_line && (
                      <div className={cn("mt-1.5 text-[12.5px] leading-snug flex items-start gap-2", o.status === "failed" ? "text-bad" : "text-[#fb923c]")}>
                        <span className="mt-[6px] size-1.5 rounded-full bg-current shrink-0" />
                        {o.error_line}
                      </div>
                    )}
                  </div>
                  <div className="[grid-area:team] xl:[grid-area:auto] pt-px">
                    <TeamChip slug={o.team_slug} team={teams[o.team_slug]} size="xs" />
                  </div>
                  <code className="[grid-area:id] xl:[grid-area:auto] min-w-0 pt-0.5 font-mono text-[11.5px] text-muted truncate" title={o.op_id}>
                    {o.op_id}
                  </code>
                  <span className="[grid-area:updated] xl:[grid-area:auto] pt-0.5 text-right text-[12px] text-faint tabular whitespace-nowrap" title={fullDate(o.updated_at)}>
                    {ago(o.updated_at)}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </Card>
    </div>
  );
}
