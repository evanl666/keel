import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUp, Check, Lock, TrendingUp } from "lucide-react";
import { errorLine } from "../../api/client";
import { useLevel, useSetLevel } from "../../api/hooks";
import type { Level, TeamDetail } from "../../api/types";
import { Button, Card, CardHeader, Input, Skeleton } from "../../components/ui";
import { LevelBadge } from "../../components/keel";
import { useToast } from "../../components/toast";
import { ago, fullDate } from "../../lib/time";
import { cn } from "../../lib/utils";

function Meter({ label, value, max, target, fmt, ok }: { label: string; value: number; max: number; target: number; fmt: (n: number) => string; ok: boolean }) {
  const pct = Math.min(100, (value / max) * 100);
  const tpct = Math.min(100, (target / max) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="tabular">
          <b className={cn("text-[16px]", ok ? "text-ok" : "text-fg")}>{fmt(value)}</b>
          <span className="text-muted"> / {fmt(target)} needed</span>
        </span>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-hover overflow-visible">
        <motion.div className={cn("h-full rounded-full", ok ? "bg-ok" : "bg-fg/70")} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} />
        <span className="absolute -top-1 -bottom-1 w-px bg-fg/40" style={{ left: `${tpct}%` }} />
      </div>
    </div>
  );
}

export function LevelTab({ t }: { t: TeamDetail }) {
  const { data: info } = useLevel(t.slug);
  const set = useSetLevel(t.slug);
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<Level | null>(null);

  if (!info)
    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5">
        <Skeleton className="lg:col-span-7 h-[420px] rounded-xl" />
        <Skeleton className="lg:col-span-5 h-[420px] rounded-xl" />
      </div>
    );

  const change = (to: Level) =>
    set.mutate(
      { level: to, reason: reason.trim() || (to > info.level ? "Promoted from the Level tab." : "Lowered from the Level tab.") },
      {
        onSuccess: (i) => {
          setConfirm(null);
          setReason("");
          toast({ title: `${t.steward.name} is now L${i.level} ${i.level_name}`, line: i.levels.find((l) => l.level === i.level)?.can, icon: to > info.level ? "🎉" : "🔽" });
        },
        onError: (e) => toast({ title: "Level not changed", line: errorLine(e), tone: "bad" }),
      },
    );

  const rate = info.approval_rate;
  const samplesOk = info.samples >= info.min_samples;
  const rateOk = rate != null && rate >= info.min_approval_rate;
  const next = info.level < 4 ? ((info.level + 1) as Level) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5">
      <Card className="lg:col-span-7 overflow-hidden">
        <CardHeader title="Authorization level" sub={`What ${t.steward.name} may do without asking. Anything above becomes an approval.`} />
        <div className="px-5 pb-5 space-y-2">
          {[...info.levels].reverse().map((l) => {
            const current = l.level === info.level;
            const below = l.level < info.level;
            return (
              <motion.div
                key={l.level}
                layout
                className={cn("relative flex items-center gap-x-4 gap-y-2 max-sm:flex-wrap rounded-lg border px-3.5 sm:px-4 py-3 transition-colors", current ? "border-fg/35 bg-hover/60" : "border-line")}
              >
                <span
                  className={cn(
                    "grid place-items-center size-8 rounded-lg text-[13px] font-semibold tabular shrink-0",
                    current ? "bg-ink text-ink-fg" : below ? "bg-hover text-fg" : "border border-line text-muted",
                  )}
                >
                  L{l.level}
                </span>
                <div className={cn("min-w-0 flex-1", current && "max-sm:basis-[calc(100%-3.25rem)]")}>
                  <div className={cn("text-[14px] font-semibold", !below && !current && "text-muted")}>{l.name}</div>
                  <div className="text-[12px] text-muted mt-0.5">{l.can}</div>
                </div>
                {current ? (
                  <span className="shrink-0 whitespace-nowrap text-[12px] font-medium inline-flex items-center gap-1.5 text-soft max-sm:order-last max-sm:ml-[48px]">
                    <span className="size-1.5 rounded-full live-dot bg-ok" /> {t.steward.name} is here
                  </span>
                ) : below ? (
                  <Check className="size-4 text-muted" />
                ) : info.eligible_for === l.level ? (
                  <span className="text-[12px] font-medium text-ok">Earned</span>
                ) : (
                  <Lock className="size-3.5 text-muted" />
                )}
              </motion.div>
            );
          })}
        </div>
      </Card>

      <div className="lg:col-span-5 space-y-5">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <TrendingUp className="size-4 text-muted" />
            {next ? `Toward L${next} ${info.levels.find((l) => l.level === next)?.name}` : "Highest level"}
          </div>
          {next ? (
            <>
              <p className="text-[12px] text-muted mt-1">Drafts approved without edits count toward the next level.</p>
              <div className="mt-4 space-y-4">
                <Meter label="Reviewed drafts" value={info.samples} max={Math.max(info.min_samples, info.samples) * 1.15} target={info.min_samples} fmt={(n) => String(Math.round(n))} ok={samplesOk} />
                <Meter label="Approved unchanged" value={(rate ?? 0) * 100} max={100} target={info.min_approval_rate * 100} fmt={(n) => `${Math.round(n)}%`} ok={rateOk} />
              </div>
              {info.eligible_for != null ? (
                confirm === info.eligible_for ? (
                  <div className="mt-5 space-y-2">
                    <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (goes in the audit log)" />
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" onClick={() => setConfirm(null)}>
                        Cancel
                      </Button>
                      <Button variant="success" loading={set.isPending} onClick={() => change(info.eligible_for!)}>
                        Confirm L{info.eligible_for}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="primary" className="mt-5 w-full" icon={<ArrowUp className="size-4" />} onClick={() => setConfirm(info.eligible_for)}>
                    Promote to L{info.eligible_for}
                  </Button>
                )
              ) : (
                <p className="mt-4 text-[12px] text-muted">
                  {!samplesOk ? `${info.min_samples - info.samples} more reviewed drafts to go.` : `Approval rate needs to reach ${Math.round(info.min_approval_rate * 100)}%.`}
                </p>
              )}
            </>
          ) : (
            <p className="text-[12px] text-muted mt-1">{t.steward.name} can do everything a steward can.</p>
          )}
          {info.level > 0 && (
            <button className="mt-4 max-sm:mt-2 max-sm:py-2.5 text-[12px] text-muted hover:text-bad cursor-pointer" onClick={() => change((info.level - 1) as Level)}>
              Lower to L{info.level - 1}
            </button>
          )}
        </Card>

        <Card>
          <CardHeader title="History" />
          <div className="px-5 pb-5">
            {info.history.length ? (
              <ol className="relative border-l border-line ml-2 space-y-4">
                {[...info.history].reverse().map((h, i) => (
                  <li key={i} className="pl-5 relative">
                    <span className={cn("absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-panel", h.to > h.from ? "bg-ok" : "bg-muted")} />
                    <div className="flex items-center gap-1.5 text-[14px]">
                      <LevelBadge level={h.from} />
                      <span className="text-muted">→</span>
                      <LevelBadge level={h.to} />
                      <span className="ml-auto text-[12px] text-muted" title={fullDate(h.at)}>
                        {ago(h.at)}
                      </span>
                    </div>
                    <div className="text-[12px] text-muted mt-1">{h.reason}</div>
                    <div className="text-[12px] text-muted mt-0.5">by {h.actor}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-[12px] text-muted">No changes yet.</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
