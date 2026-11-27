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
import { alpha, cn } from "../../lib/utils";

const LEVEL_TONES = ["var(--lv0)", "var(--lv1)", "var(--lv2)", "var(--lv3)", "var(--lv4)"];

function Meter({ label, value, max, target, fmt, ok }: { label: string; value: number; max: number; target: number; fmt: (n: number) => string; ok: boolean }) {
  const pct = Math.min(100, (value / max) * 100);
  const tpct = Math.min(100, (target / max) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-muted">{label}</span>
        <span className="tabular">
          <b className={cn("text-[15px]", ok ? "text-ok" : "text-fg")}>{fmt(value)}</b>
          <span className="text-faint"> / {fmt(target)} needed</span>
        </span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-sunken border border-line overflow-visible">
        <motion.div className={cn("h-full rounded-full", ok ? "bg-ok" : "bg-accent")} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
        <span className="absolute -top-1 -bottom-1 w-px bg-fg/50" style={{ left: `${tpct}%` }} />
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
      <div className="grid grid-cols-12 gap-5">
        <Skeleton className="col-span-7 h-[420px] rounded-xl" />
        <Skeleton className="col-span-5 h-[420px] rounded-xl" />
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
    <div className="grid grid-cols-12 gap-5">
      <Card className="col-span-7 overflow-hidden">
        <CardHeader title="Authorization level" sub={`What ${t.steward.name} may do without asking. Anything above becomes an approval.`} />
        <div className="px-5 pb-5 space-y-2">
          {[...info.levels].reverse().map((l) => {
            const current = l.level === info.level;
            const below = l.level < info.level;
            const c = LEVEL_TONES[l.level];
            return (
              <motion.div
                key={l.level}
                layout
                className={cn("relative flex items-center gap-4 rounded-xl border px-4 py-3 transition-colors", current ? "border-transparent" : "border-line")}
                style={current ? { background: `linear-gradient(90deg, ${alpha(c, 0.16)}, ${alpha(c, 0.04)})`, boxShadow: `inset 0 0 0 1px ${alpha(c, 0.45)}` } : undefined}
              >
                <span
                  className="grid place-items-center size-9 rounded-lg text-[13px] font-bold tabular shrink-0"
                  style={{ color: below || current ? c : "var(--faint)", background: below || current ? alpha(c, 0.14) : "var(--sunken)", boxShadow: `inset 0 0 0 1px ${below || current ? alpha(c, 0.35) : "var(--line)"}` }}
                >
                  L{l.level}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn("text-[14px] font-semibold", !below && !current && "text-muted")}>{l.name}</div>
                  <div className="text-[12.5px] text-muted mt-0.5">{l.can}</div>
                </div>
                {current ? (
                  <span className="text-[11.5px] font-semibold px-2 h-6 rounded-full inline-flex items-center gap-1" style={{ color: c, background: alpha(c, 0.14) }}>
                    <span className="size-1.5 rounded-full live-dot" style={{ background: c, color: c }} /> {t.steward.name} is here
                  </span>
                ) : below ? (
                  <Check className="size-4 text-faint" />
                ) : info.eligible_for === l.level ? (
                  <span className="text-[11.5px] font-medium text-ok">Earned</span>
                ) : (
                  <Lock className="size-3.5 text-faint" />
                )}
              </motion.div>
            );
          })}
        </div>
      </Card>

      <div className="col-span-5 space-y-5">
        <Card className="p-5" glow={info.eligible_for != null ? "rgba(34,197,94,0.1)" : undefined}>
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <TrendingUp className="size-4 text-accent" />
            {next ? `Toward L${next} ${info.levels.find((l) => l.level === next)?.name}` : "Highest level"}
          </div>
          {next ? (
            <>
              <p className="text-[12.5px] text-muted mt-1">Drafts approved without edits count toward the next level.</p>
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
                  <Button variant="primary" size="lg" className="mt-5 w-full" icon={<ArrowUp className="size-4" />} onClick={() => setConfirm(info.eligible_for)}>
                    Promote to L{info.eligible_for}
                  </Button>
                )
              ) : (
                <p className="mt-4 text-[12.5px] text-faint">
                  {!samplesOk ? `${info.min_samples - info.samples} more reviewed drafts to go.` : `Approval rate needs to reach ${Math.round(info.min_approval_rate * 100)}%.`}
                </p>
              )}
            </>
          ) : (
            <p className="text-[12.5px] text-muted mt-1">{t.steward.name} can do everything a steward can.</p>
          )}
          {info.level > 0 && (
            <button className="mt-4 text-[12px] text-faint hover:text-bad cursor-pointer" onClick={() => change((info.level - 1) as Level)}>
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
                    <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-panel" style={{ background: LEVEL_TONES[h.to] }} />
                    <div className="flex items-center gap-1.5 text-[13px]">
                      <LevelBadge level={h.from} />
                      <span className="text-faint">→</span>
                      <LevelBadge level={h.to} />
                      <span className="ml-auto text-[11.5px] text-faint" title={fullDate(h.at)}>
                        {ago(h.at)}
                      </span>
                    </div>
                    <div className="text-[12.5px] text-muted mt-1">{h.reason}</div>
                    <div className="text-[11.5px] text-faint mt-0.5">by {h.actor}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-[12.5px] text-faint">No changes yet.</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
