import { Link } from "react-router";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, ArrowUpRight, Inbox, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, errorLine } from "../api/client";
import { useMe, useOverview } from "../api/hooks";
import type { TeamSummary } from "../api/types";
import { Button, Card, CardHeader, Skeleton, Stat, EmptyState } from "../components/ui";
import { HealthRing, LevelBadge, StewardAvatar, useTeamMap } from "../components/keel";
import { TeamGraph } from "../components/TeamGraph";
import { ActivityFeed } from "../components/ActivityFeed";
import { mergeActivity, useStream } from "../components/stream";
import { useToast } from "../components/toast";
import { alpha, cn, plural } from "../lib/utils";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function DemoBanner() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative mb-5 sm:mb-6 flex items-center gap-3 rounded-xl border border-accent/25 bg-accent-soft/60 px-4 min-h-11 max-sm:py-2 overflow-hidden"
    >
      <span className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[#a5b0ff] to-[#5b6cff]" />
      <ShieldCheck className="size-4 text-accent shrink-0" />
      <span className="min-w-0 text-[13px] text-fg/90 sm:truncate max-sm:leading-snug">
        <span className="font-semibold">Demo workspace</span>
        <span className="text-muted max-sm:block"><span className="max-sm:hidden"> · </span>synthetic data · nothing leaves this machine</span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto shrink-0"
        icon={<Play className="size-3" />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.demoTick();
            await qc.invalidateQueries();
            toast(r.event ? { title: r.event.text, icon: r.event.icon } : { title: "That was the last scripted event", line: "The live feed keeps going on its own.", tone: "info" });
          } catch (e) {
            toast({ title: "The event didn't play", line: errorLine(e), tone: "bad" });
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="max-sm:hidden">Play next event</span>
        <span className="sm:hidden">Next event</span>
      </Button>
    </motion.div>
  );
}

function CountChip({ n, label, tone }: { n: number; label: string; tone?: "bad" | "warn" | "accent" }) {
  const on = n > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 h-6 px-2 rounded-md text-[12px] border whitespace-nowrap",
        !on && "border-line text-faint",
        on && !tone && "border-line text-muted bg-hover",
        on && tone === "bad" && "border-bad/30 text-bad bg-bad/10",
        on && tone === "warn" && "border-warn/30 text-warn bg-warn/10",
        on && tone === "accent" && "border-accent/30 text-accent bg-accent-soft",
      )}
    >
      <span className="font-semibold tabular">{n}</span>
      {label}
    </span>
  );
}

function StewardCard({ t, i }: { t: TeamSummary; i: number }) {
  const s = t.steward;
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
      <Link to={`/teams/${t.slug}`} className="group block h-full">
        <Card glow={alpha(t.color, 0.16)} className="h-full p-5 transition-all duration-200 group-hover:border-line-strong group-hover:-translate-y-0.5 group-hover:shadow-pop overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${alpha(t.color, 0.7)}, transparent)` }} />
          <div className="flex items-start gap-3.5">
            <StewardAvatar emoji={s.emoji} color={t.color} paused={s.paused} size="lg" />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[16px] font-semibold tracking-[-0.01em]">{s.name}</span>
                <LevelBadge level={s.level} />
              </div>
              <div className="text-[12.5px] text-muted mt-0.5 flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ background: t.color }} />
                {t.name}
                {s.paused && <span className="text-faint">· paused</span>}
              </div>
            </div>
            <HealthRing value={t.health} />
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-fg/80 min-h-[40px]">{s.status_line}</p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <CountChip n={t.counts.open} label="open" />
            <CountChip n={t.counts.at_risk} label="at risk" tone="warn" />
            <CountChip n={t.counts.overdue} label="overdue" tone="bad" />
            <CountChip n={t.counts.pending_approvals} label={t.counts.pending_approvals === 1 ? "approval" : "approvals"} tone="accent" />
            {t.counts.incidents_open > 0 && <CountChip n={t.counts.incidents_open} label="incident" tone="bad" />}
          </div>
          <ArrowUpRight className="absolute right-4 bottom-4 size-4 text-faint opacity-0 -translate-x-1 translate-y-1 transition-all group-hover:opacity-100 group-hover:translate-x-0 group-hover:translate-y-0" />
        </Card>
      </Link>
    </motion.div>
  );
}

export function Overview() {
  const { data, isLoading } = useOverview();
  const { data: me } = useMe();
  const stream = useStream();
  const teams = useTeamMap();
  const activity = mergeActivity(data?.activity, stream.items);
  const t = data?.totals;
  const name = me?.user?.name.split(" ")[0];

  return (
    <div>
      {me?.demo && <DemoBanner />}
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6 sm:mb-6">
        <div className="min-w-0">
          <h1 className="text-[22px] sm:text-[24px] font-semibold tracking-[-0.025em]">
            {greeting()}
            {name ? `, ${name}` : ""}.
          </h1>
          <p className="text-[13.5px] text-muted mt-1">
            {data ? (
              <>
                {plural(data.teams.length, "steward")} on duty for {data.org.name}.{" "}
                {t!.pending_approvals ? `${plural(t!.pending_approvals, "draft")} wait for you.` : "Nothing waits for you."}
              </>
            ) : (
              <span className="inline-block w-64"><Skeleton className="h-4" /></span>
            )}
          </p>
        </div>
        {!!t?.pending_approvals && (
          <Link to="/approvals" className="shrink-0 self-start sm:self-auto">
            <Button variant="primary" icon={<Inbox className="size-3.5" />} kbd="G A">
              Review {t.pending_approvals}
            </Button>
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {isLoading || !data
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-[210px] rounded-xl" />)
          : data.teams.map((tm, i) => <StewardCard key={tm.slug} t={tm} i={i} />)}
      </div>

      <Card className="mt-4 px-4 py-4 sm:px-6">
        {t ? (
          <div className="grid grid-cols-2 gap-y-4 sm:grid-cols-4 lg:grid-cols-7 lg:gap-y-0 lg:divide-x lg:divide-line">
            {[
              <Stat key="o" label="Open" value={t.open} />,
              <Stat key="d" label="Done · 7d" value={t.done_7d} tone="ok" />,
              <Stat key="r" label="At risk" value={t.at_risk} tone={t.at_risk ? "warn" : undefined} />,
              <Stat key="v" label="Overdue" value={t.overdue} tone={t.overdue ? "bad" : undefined} />,
              <Stat key="a" label="Approvals" value={t.pending_approvals} tone={t.pending_approvals ? "accent" : undefined} />,
              <Stat key="i" label="Incidents" value={t.incidents_open} tone={t.incidents_open ? "bad" : "ok"} />,
              <Stat key="n" label="To review" value={t.ops_needs_review} tone={t.ops_needs_review ? "warn" : undefined} />,
            ].map((el, i) => (
              <div key={i} className={cn("min-w-0", i > 0 && "lg:pl-5", i % 2 === 1 && "max-sm:pl-4 max-sm:border-l max-sm:border-line", i % 4 !== 0 && "sm:max-lg:pl-4 sm:max-lg:border-l sm:max-lg:border-line")}>
                {el}
              </div>
            ))}
          </div>
        ) : (
          <Skeleton className="h-12" />
        )}
      </Card>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-7 flex flex-col min-w-0">
          <CardHeader title="Between teams" sub="Open requests flow from the asking team to the owning team. Red means at risk." />
          <div className="px-2 sm:px-4 pb-4 flex-1 flex items-center">
            {data ? (
              data.cross_team.length ? (
                <TeamGraph teams={data.teams} edges={data.cross_team} />
              ) : (
                <EmptyState icon="🤝" title="No open requests between teams" line="When one team asks another for something, it shows up here." />
              )
            ) : (
              <Skeleton className="h-[280px] w-full" />
            )}
          </div>
        </Card>
        <Card className="lg:col-span-5 flex flex-col min-h-0 min-w-0">
          <CardHeader
            title="Live activity"
            sub="What stewards did, as it happens."
            right={
              <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] font-medium", stream.live ? "text-ok" : "text-faint")}>
                <span className={cn("size-1.5 rounded-full", stream.live ? "bg-ok live-dot" : "bg-faint")} style={{ color: "var(--ok)" }} />
                {stream.live ? "Live" : "Reconnecting"}
              </span>
            }
          />
          <div className="px-2.5 pb-3 overflow-y-auto max-h-[380px]">
            {data ? <ActivityFeed items={activity} teams={teams} limit={20} dense /> : <div className="px-2.5"><Skeleton className="h-60" /></div>}
          </div>
        </Card>
      </div>
    </div>
  );
}
