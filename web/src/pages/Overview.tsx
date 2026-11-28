import { Link } from "react-router";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, ArrowUpRight, Inbox, ShieldCheck, Gift } from "lucide-react";
import { useState } from "react";
import { api, errorLine } from "../api/client";
import { useMe, useOverview } from "../api/hooks";
import type { TeamSummary } from "../api/types";
import { Button, buttonClass, Card, CardHeader, PageHeader, Skeleton, Stat, EmptyState } from "../components/ui";
import { HealthRing, LevelBadge, StewardAvatar, useTeamMap } from "../components/keel";
import { TeamGraph } from "../components/TeamGraph";
import { ActivityFeed } from "../components/ActivityFeed";
import { mergeActivity, useStream } from "../components/stream";
import { useToast } from "../components/toast";
import { cn, plural } from "../lib/utils";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function DemoBanner() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mb-6 flex items-center gap-3 rounded-xl border border-line bg-panel px-4 min-h-12 max-sm:py-2">
      <ShieldCheck className="size-4 text-muted shrink-0" />
      <span className="min-w-0 text-[14px] sm:truncate max-sm:leading-snug">
        <span className="font-medium">Demo workspace</span>
        <span className="text-muted max-sm:block"><span className="max-sm:hidden"> · </span>sample data, nothing leaves this machine</span>
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
    </div>
  );
}

function Counts({ t }: { t: TeamSummary }) {
  const c = t.counts;
  const parts: { n: number; label: string; cls?: string }[] = [
    { n: c.open, label: "open" },
    { n: c.at_risk, label: "at risk", cls: c.at_risk ? "text-warn" : undefined },
    { n: c.overdue, label: "overdue", cls: c.overdue ? "text-bad" : undefined },
  ];
  if (c.pending_approvals) parts.push({ n: c.pending_approvals, label: c.pending_approvals === 1 ? "approval" : "approvals" });
  if (c.incidents_open) parts.push({ n: c.incidents_open, label: c.incidents_open === 1 ? "incident" : "incidents", cls: "text-bad" });
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
      {parts.map((p) => (
        <span key={p.label} className={p.cls}>
          <span className="font-semibold tabular">{p.n}</span> {p.label}
        </span>
      ))}
    </div>
  );
}

function StewardCard({ t, i }: { t: TeamSummary; i: number }) {
  const s = t.steward;
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.15 }}>
      <Link to={`/teams/${t.slug}`} className="group block h-full">
        <Card className="h-full p-5 flex flex-col transition-colors duration-150 group-hover:border-line-strong">
          <div className="flex items-start gap-3">
            <StewardAvatar emoji={s.emoji} color={t.color} paused={s.paused} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold">{s.name}</span>
                <LevelBadge level={s.level} />
              </div>
              <div className="text-[12px] text-muted mt-0.5 flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ background: t.color }} />
                {t.name}
                {s.paused && <span>· paused</span>}
              </div>
            </div>
            <HealthRing value={t.health} size={40} />
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-soft flex-1">{s.status_line}</p>
          <div className="mt-4 pt-3 border-t border-line flex items-center gap-2">
            <Counts t={t} />
            <ArrowUpRight className="ml-auto size-4 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </Card>
      </Link>
    </motion.div>
  );
}

function YourMonth({ teams }: { teams: TeamSummary[] }) {
  return (
    <Card className="mt-4 px-4 py-3.5 sm:px-5 flex flex-col md:flex-row md:items-center gap-3 md:gap-5">
      <div className="flex items-center gap-3 min-w-0">
        <span className="grid place-items-center size-8 shrink-0 rounded-lg bg-hover text-soft">
          <Gift className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">Your month, wrapped</div>
          <div className="text-[12px] text-muted">The last 30 days of each team's promises, as a story you can share.</div>
        </div>
      </div>
      <div className="md:ml-auto flex flex-wrap gap-2">
        {teams.map((t) => (
          <Link
            key={t.slug}
            to={`/teams/${t.slug}?wrapped=1`}
            className={buttonClass("secondary", "sm")}
          >
            <span aria-hidden>{t.steward.emoji}</span>
            {t.name}
          </Link>
        ))}
      </div>
    </Card>
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
      <PageHeader
        title={`${greeting()}${name ? `, ${name}` : ""}`}
        sub={
          data
            ? `${plural(data.teams.length, "steward")} on duty for ${data.org.name} · ${t!.pending_approvals ? `${plural(t!.pending_approvals, "draft")} wait for you` : "nothing waits for you"}`
            : "Loading…"
        }
        right={
          !!t?.pending_approvals && (
            <Link to="/approvals" className={buttonClass("primary")} title="Shortcut: G then A">
              <Inbox className="size-3.5" />
              Review {t.pending_approvals}
            </Link>
          )
        }
      />
      {me?.demo && <DemoBanner />}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading || !data
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-[180px] rounded-xl" />)
          : data.teams.map((tm, i) => <StewardCard key={tm.slug} t={tm} i={i} />)}
      </div>

      <Card className="mt-4 px-4 py-4 sm:px-5">
        {t ? (
          <div className="grid grid-cols-2 gap-y-4 sm:grid-cols-4 lg:grid-cols-7 lg:gap-y-0 lg:divide-x lg:divide-line">
            {[
              <Stat key="o" label="Open" value={t.open} />,
              <Stat key="d" label="Done · 7d" value={t.done_7d} />,
              <Stat key="r" label="At risk" value={t.at_risk} tone={t.at_risk ? "warn" : undefined} />,
              <Stat key="v" label="Overdue" value={t.overdue} tone={t.overdue ? "bad" : undefined} />,
              <Stat key="a" label="Approvals" value={t.pending_approvals} />,
              <Stat key="i" label="Incidents" value={t.incidents_open} tone={t.incidents_open ? "bad" : undefined} />,
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

      {data && data.teams.length > 0 && <YourMonth teams={data.teams} />}

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-7 flex flex-col min-w-0">
          <CardHeader title="Between teams" sub="Open requests flow from the asking team to the owning team. Red means at risk." />
          <div className="px-2 sm:px-4 pb-4 flex-1 flex items-center">
            {data ? (
              data.cross_team.length ? (
                <TeamGraph teams={data.teams} edges={data.cross_team} />
              ) : (
                <EmptyState title="No open requests between teams" line="When one team asks another for something, it shows up here." />
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
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                <span className={cn("size-1.5 rounded-full", stream.live ? "bg-ok live-dot" : "bg-faint")} />
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
