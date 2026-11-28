import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { List, Columns3, X } from "lucide-react";
import { useCommitments } from "../api/hooks";
import type { CommitmentStatus, Risk } from "../api/types";
import { Button, EmptyState, PageHeader, Segmented, Select, SkeletonRows } from "../components/ui";
import { STATUS_META, useTeamMap } from "../components/keel";
import { CommitmentBoard, CommitmentList, STATUS_ORDER } from "../components/Commitments";
import { cn } from "../lib/utils";
import { useWidePage } from "../components/Layout";

const RISKS: { value: Risk | ""; label: string }[] = [
  { value: "", label: "Any risk" },
  { value: "overdue", label: "Overdue" },
  { value: "at_risk", label: "At risk" },
  { value: "on_track", label: "On track" },
];

export function Ledger() {
  const [sp, setSp] = useSearchParams();
  const team = sp.get("team") ?? "";
  const status = sp.get("status") ?? "";
  const risk = sp.get("risk") ?? "";
  const view = (sp.get("view") as "list" | "board") ?? "list";
  useWidePage(view === "board");
  const teams = useTeamMap();
  const { data, isLoading } = useCommitments();

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };

  const filtered = useMemo(
    () =>
      (data ?? []).filter(
        (c) => (!team || c.owner_team === team || c.requester_team === team) && (!status || c.status === status) && (!risk || c.risk === risk),
      ),
    [data, team, status, risk],
  );
  const openCount = filtered.filter((c) => !["done", "dropped", "declined"].includes(c.status)).length;
  const crossCount = filtered.filter((c) => c.requester_team && c.requester_team !== c.owner_team).length;
  const anyFilter = team || status || risk;

  return (
    <div>
      <PageHeader
        title="Ledger"
        sub={data ? `${openCount} open · ${crossCount} between teams. Who promised what to whom, by when.` : "Who promised what to whom, by when."}
        right={
          <Segmented
            value={view}
            onChange={(v) => set("view", v === "list" ? "" : v)}
            options={[
              { value: "list", label: <><List className="size-3.5" />List</> },
              { value: "board", label: <><Columns3 className="size-3.5" />Board</> },
            ]}
          />
        }
      />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2 max-sm:w-[calc(100%+2rem)] max-sm:scroll-x max-sm:-mx-4 max-sm:px-4 sm:contents">
        <button
          onClick={() => set("team", "")}
          className={cn("shrink-0 h-7 max-sm:h-10 px-2.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer", !team ? "bg-hover text-fg" : "text-muted hover:text-fg hover:bg-hover")}
        >
          All teams
        </button>
        {Object.values(teams).map((t) => {
          const on = team === t.slug;
          return (
            <button
              key={t.slug}
              onClick={() => set("team", on ? "" : t.slug)}
              className={cn("shrink-0 whitespace-nowrap h-7 max-sm:h-10 px-2.5 rounded-md text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer", on ? "bg-hover text-fg" : "text-muted hover:text-fg hover:bg-hover")}
            >
              <span className="size-2 rounded-full" style={{ background: t.color }} />
              {t.name}
            </button>
          );
        })}
        </div>
        <span className="max-sm:hidden w-px h-5 bg-line mx-1" />
        <Select value={status} onChange={(e) => set("status", e.target.value)} className="sm:h-7! !w-auto max-sm:min-w-0 max-sm:flex-1 text-[13px] !rounded-md !px-2.5 !pr-8">
          <option value="">Any status</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s as CommitmentStatus].label}
            </option>
          ))}
        </Select>
        <Select value={risk} onChange={(e) => set("risk", e.target.value)} className="sm:h-7! !w-auto max-sm:min-w-0 max-sm:flex-1 text-[13px] !rounded-md !px-2.5 !pr-8">
          {RISKS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        {anyFilter && (
          <Button size="sm" variant="ghost" icon={<X className="size-3" />} onClick={() => setSp(view === "board" ? { view } : {}, { replace: true })}>
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <SkeletonRows rows={8} />
      ) : !filtered.length ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            title={anyFilter ? "Nothing matches these filters" : "No commitments yet"}
            line={anyFilter ? "Try another team or status." : "When someone promises something in Slack or GitHub, the steward logs it here."}
            action={anyFilter ? <Button onClick={() => setSp({}, { replace: true })}>Clear filters</Button> : undefined}
          />
        </div>
      ) : view === "board" ? (
        <CommitmentBoard items={filtered} teams={teams} />
      ) : (
        <CommitmentList items={filtered} teams={teams} />
      )}
    </div>
  );
}
