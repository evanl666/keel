import { Link, Navigate, useParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Pause } from "lucide-react";
import { errorLine } from "../../api/client";
import { usePatchSteward, useTeam } from "../../api/hooks";
import type { TeamDetail } from "../../api/types";
import { Card, Skeleton, Switch } from "../../components/ui";
import { DUTY_META, HealthRing, LevelBadge, StewardAvatar } from "../../components/keel";
import { useToast } from "../../components/toast";
import { alpha, cn } from "../../lib/utils";
import { TodayTab } from "./TodayTab";
import { LedgerTab, ServicesTab } from "./SimpleTabs";
import { FrontDeskTab } from "./FrontDeskTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { LevelTab } from "./LevelTab";
import { SettingsTab } from "./SettingsTab";

const TABS = [
  { id: "today", label: "Today" },
  { id: "ledger", label: "Ledger" },
  { id: "front-desk", label: "Front desk" },
  { id: "services", label: "Services" },
  { id: "knowledge", label: "Knowledge" },
  { id: "level", label: "Level" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function PauseControl({ t }: { t: TeamDetail }) {
  const patch = usePatchSteward(t.slug);
  const toast = useToast();
  const paused = patch.isPending && patch.variables?.paused !== undefined ? patch.variables.paused : t.steward.paused;
  const name = t.steward.name;
  return (
    <div className="w-[240px] rounded-xl border border-line bg-panel/60 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium flex items-center gap-1.5">
          <Pause className={cn("size-3.5", paused ? "text-warn" : "text-faint")} />
          Pause {name}
        </span>
        <Switch
          checked={paused}
          label={`Pause ${name}`}
          color="var(--warn)"
          onChange={(v) =>
            patch.mutate(
              { paused: v },
              {
                onSuccess: () => toast({ title: v ? `${name} is paused` : `${name} is back to work`, icon: v ? "⏸️" : "▶️" }),
                onError: (e) => toast({ title: `${name} didn't change`, line: errorLine(e), tone: "bad" }),
              },
            )
          }
        />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={String(paused)} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 3 }} transition={{ duration: 0.15 }} className="mt-1 text-[12.5px] text-muted">
          {paused ? `${name} is paused. It watches but sends nothing.` : `${name} is working.`}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Header({ t }: { t: TeamDetail }) {
  return (
    <Card className="overflow-hidden" glow={alpha(t.color, 0.16)}>
      <div className="px-7 pt-6 pb-5 flex items-start gap-5">
        <StewardAvatar emoji={t.steward.emoji} color={t.color} paused={t.steward.paused} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-[24px] font-semibold tracking-[-0.025em] leading-none">{t.steward.name}</h1>
            <LevelBadge level={t.steward.level} name={t.steward.level_name} />
            <span className="text-[13px] text-faint">
              steward of{" "}
              <span className="font-medium" style={{ color: t.color }}>
                {t.name}
              </span>
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[13.5px] text-muted">
            <span className={cn("size-1.5 rounded-full", t.steward.paused ? "bg-faint" : "bg-ok live-dot")} style={{ color: t.steward.paused ? undefined : "var(--ok)" }} />
            {t.steward.status_line}
          </div>
          <div className="mt-3.5 flex items-center gap-1.5 flex-wrap">
            {t.steward.duties.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-line bg-panel/60 text-[12px] text-muted">
                <span className="text-[12px]">{DUTY_META[d]?.icon}</span>
                {DUTY_META[d]?.label ?? d}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-start gap-6 shrink-0">
          <div className="flex flex-col items-center gap-1">
            <HealthRing value={t.health} size={56} />
            <span className="text-[11px] text-faint">Health</span>
          </div>
          <PauseControl t={t} />
        </div>
      </div>
      <div className="px-7 pb-4 flex items-center gap-5 text-[12.5px] text-muted">
        <span>
          <b className="text-fg tabular">{t.counts.open}</b> open
        </span>
        <span className={t.counts.at_risk ? "text-warn" : ""}>
          <b className="tabular">{t.counts.at_risk}</b> at risk
        </span>
        <span className={t.counts.overdue ? "text-bad" : ""}>
          <b className="tabular">{t.counts.overdue}</b> overdue
        </span>
        <span>
          <b className="text-fg tabular">{t.counts.requests_in}</b> asked of {t.name}
        </span>
        <span>
          <b className="text-fg tabular">{t.counts.requests_out}</b> asked by {t.name}
        </span>
        {t.counts.pending_approvals > 0 && (
          <Link to="/approvals" className="text-accent hover:underline">
            {t.counts.pending_approvals} waiting for approval
          </Link>
        )}
        {t.counts.incidents_open > 0 && (
          <Link to={`/teams/${t.slug}/services`} className="text-bad hover:underline">
            {t.counts.incidents_open} incident open
          </Link>
        )}
      </div>
    </Card>
  );
}

export function TeamHome() {
  const { slug = "", tab = "today" } = useParams();
  const { data: t, isLoading, error } = useTeam(slug);
  if (!TABS.some((x) => x.id === tab)) return <Navigate to={`/teams/${slug}`} replace />;
  if (error)
    return (
      <Card className="p-10 text-center">
        <div className="text-[15px] font-semibold">No team at /{slug}</div>
        <div className="text-[13px] text-muted mt-1">{errorLine(error)}</div>
      </Card>
    );
  if (isLoading || !t)
    return (
      <div className="space-y-4">
        <Skeleton className="h-[170px] rounded-xl" />
        <Skeleton className="h-9 w-[520px]" />
        <Skeleton className="h-[360px] rounded-xl" />
      </div>
    );
  const active = tab as TabId;
  return (
    <div>
      <Header t={t} />
      <nav className="mt-5 mb-5 flex items-center gap-1 border-b border-line">
        {TABS.map((x) => (
          <Link
            key={x.id}
            to={x.id === "today" ? `/teams/${slug}` : `/teams/${slug}/${x.id}`}
            className={cn("relative h-9 px-3 text-[13px] font-medium flex items-center transition-colors", active === x.id ? "text-fg" : "text-faint hover:text-muted")}
          >
            {x.label}
            {active === x.id && <motion.span layoutId="team-tab" className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: t.color }} transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          </Link>
        ))}
      </nav>
      <motion.div key={active} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        {active === "today" && <TodayTab t={t} />}
        {active === "ledger" && <LedgerTab t={t} />}
        {active === "front-desk" && <FrontDeskTab t={t} />}
        {active === "services" && <ServicesTab t={t} />}
        {active === "knowledge" && <KnowledgeTab t={t} />}
        {active === "level" && <LevelTab t={t} />}
        {active === "settings" && <SettingsTab t={t} />}
      </motion.div>
    </div>
  );
}
