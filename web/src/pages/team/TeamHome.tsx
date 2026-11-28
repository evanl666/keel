import { useEffect, useRef } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Gift, Pause, Play } from "lucide-react";
import { errorLine } from "../../api/client";
import { usePatchSteward, useTeam } from "../../api/hooks";
import type { TeamDetail } from "../../api/types";
import { Button, buttonClass, EmptyState, PageHeader, Skeleton, TabBar, Tooltip } from "../../components/ui";
import { useToast } from "../../components/toast";
import { WrappedStory } from "../../components/Wrapped";
import { TodayTab } from "./TodayTab";
import { LedgerTab, ServicesTab } from "./SimpleTabs";
import { FrontDeskTab } from "./FrontDeskTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { LearningTab } from "./LearningTab";
import { LevelTab } from "./LevelTab";
import { SettingsTab } from "./SettingsTab";

const TABS = [
  { id: "today", label: "Today" },
  { id: "ledger", label: "Ledger" },
  { id: "front-desk", label: "Front desk" },
  { id: "services", label: "Services" },
  { id: "knowledge", label: "Knowledge" },
  { id: "learning", label: "Learning" },
  { id: "level", label: "Level" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function PauseButton({ t }: { t: TeamDetail }) {
  const patch = usePatchSteward(t.slug);
  const toast = useToast();
  const paused = patch.isPending && patch.variables?.paused !== undefined ? patch.variables.paused : t.steward.paused;
  const name = t.steward.name;
  return (
    <Tooltip content={paused ? `${name} is paused. It watches but sends nothing.` : `${name} is working. Pausing stops everything it sends.`} side="bottom">
      <Button
        variant="secondary"
        aria-pressed={paused}
        icon={paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        loading={patch.isPending}
        onClick={() =>
          patch.mutate(
            { paused: !paused },
            {
              onSuccess: () => toast({ title: !paused ? `${name} is paused` : `${name} is back to work`, icon: !paused ? "⏸️" : "▶️" }),
              onError: (e) => toast({ title: `${name} didn't change`, line: errorLine(e), tone: "bad" }),
            },
          )
        }
      >
        {paused ? `Resume ${name}` : `Pause ${name}`}
      </Button>
    </Tooltip>
  );
}

export function TeamHome() {
  const { slug = "", tab = "today" } = useParams();
  const { data: t, isLoading, error } = useTeam(slug);
  const [params, setParams] = useSearchParams();
  const wrapped = params.get("wrapped") === "1";
  const navigate = useNavigate();
  const openedHere = useRef(false);
  // Opening pushes a history entry so Back closes the story; a deep link closes in place.
  const setWrapped = (open: boolean) => {
    if (!open && openedHere.current) {
      openedHere.current = false;
      navigate(-1);
      return;
    }
    openedHere.current = open;
    setParams(
      (p) => {
        if (open) p.set("wrapped", "1");
        else p.delete("wrapped");
        return p;
      },
      { replace: !open },
    );
  };
  useEffect(() => {
    if (!wrapped) openedHere.current = false;
  }, [wrapped]);
  if (!TABS.some((x) => x.id === tab)) return <Navigate to={`/teams/${slug}`} replace />;
  if (error)
    return (
      <>
        <PageHeader title="Team not found" />
        <EmptyState title={`No team at /${slug}`} line={errorLine(error)} action={<Link to="/" className={buttonClass()}>Back to overview</Link>} />
      </>
    );
  if (isLoading || !t)
    return (
      <>
        <PageHeader title={<Skeleton className="h-4 w-40" />} />
        <div className="space-y-4">
          <Skeleton className="h-[150px] rounded-xl" />
          <Skeleton className="h-[360px] rounded-xl" />
        </div>
      </>
    );
  const active = tab as TabId;
  return (
    <div>
      <PageHeader
        icon={<span className="size-2.5 rounded-full" style={{ background: t.color }} />}
        title={t.name}
        sub={
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden>{t.steward.emoji}</span>
            {t.steward.name} · L{t.steward.level} {t.steward.level_name}
            {t.steward.paused ? " · paused" : ` · ${t.counts.open} open${t.counts.at_risk + t.counts.overdue ? ` · ${t.counts.at_risk + t.counts.overdue} need attention` : ""}`}
          </span>
        }
        right={
          <>
            <Button variant="ghost" icon={<Gift className="size-4" />} onClick={() => setWrapped(true)} aria-label={`${t.name} Wrapped, last 30 days`} title="Your last 30 days, as a story">
              <span className="max-md:hidden">Wrapped</span>
            </Button>
            <PauseButton t={t} />
          </>
        }
        tabs={<TabBar active={active} items={TABS.map((x) => ({ id: x.id, label: x.label, to: x.id === "today" ? `/teams/${slug}` : `/teams/${slug}/${x.id}` }))} />}
      />
      <AnimatePresence>{wrapped && <WrappedStory key="wrapped" team={t} onClose={() => setWrapped(false)} />}</AnimatePresence>
      <motion.div key={active} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
        {active === "today" && <TodayTab t={t} />}
        {active === "ledger" && <LedgerTab t={t} />}
        {active === "front-desk" && <FrontDeskTab t={t} />}
        {active === "services" && <ServicesTab t={t} />}
        {active === "knowledge" && <KnowledgeTab t={t} />}
        {active === "learning" && <LearningTab t={t} />}
        {active === "level" && <LevelTab t={t} />}
        {active === "settings" && <SettingsTab t={t} />}
      </motion.div>
    </div>
  );
}
