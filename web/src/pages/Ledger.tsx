import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { List, Columns3, X } from "lucide-react";
import { useCommitments } from "../api/hooks";
import type { CommitmentStatus, Risk } from "../api/types";
import { Button, EmptyState, PageHeader, Segmented, Select, SkeletonRows } from "../components/ui";
import { STATUS_META, useTeamMap } from "../components/keel";
import { CommitmentBoard, CommitmentList, STATUS_ORDER } from "../components/Commitments";
import { alpha, cn } from "../lib/utils";

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
        <button
          onClick={() => set("team", "")}
          className={cn("h-7 px-3 rounded-full border text-[12.5px] font-medium transition-colors cursor-pointer", !team ? "border-line-strong bg-hover text-fg" : "border-line text-muted hover:text-fg")}
        >
          All teams
        </button>
        {Object.values(teams).map((t) => {
          const on = team === t.slug;
          return (
            <button
              key={t.slug}
              onClick={() => set("team", on ? "" : t.slug)}
              className="h-7 pl-2 pr-3 rounded-full border text-[12.5px] font-medium inline-flex items-center gap-1.5 transition-all cursor-pointer"
              style={on ? { color: t.color, borderColor: alpha(t.color, 0.45), background: alpha(t.color, 0.12) } : { borderColor: "var(--line)", color: "var(--muted)" }}
            >
              <span className="text-[13px] leading-none">{t.steward.emoji}</span>
              {t.name}
            </button>
          );
        })}
        <span className="w-px h-5 bg-line mx-1" />
        <Select value={status} onChange={(e) => set("status", e.target.value)} className="!h-7 !w-auto text-[12.5px] !rounded-full !px-3 !pr-8">
          <option value="">Any status</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s as CommitmentStatus].label}
            </option>
          ))}
        </Select>
        <Select value={risk} onChange={(e) => set("risk", e.target.value)} className="!h-7 !w-auto text-[12.5px] !rounded-full !px-3 !pr-8">
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
            icon="🗂️"
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
