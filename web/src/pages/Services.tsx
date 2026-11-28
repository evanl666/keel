import { useMemo, useState } from "react";
import { Siren } from "lucide-react";
import { useAllServices, useTeams } from "../api/hooks";
import type { Service, TeamSummary } from "../api/types";
import { Card, EmptyState, PageHeader, Segmented, Skeleton } from "../components/ui";
import { ServiceCard } from "../components/ServiceCard";
import { plural } from "../lib/utils";

type F = "all" | "attention";

export function Services() {
  const { data: teams } = useTeams();
  const slugs = useMemo(() => (teams ?? []).map((t) => t.slug), [teams]);
  const results = useAllServices(slugs);
  const [f, setF] = useState<F>("all");
  const loading = !teams || results.some((r) => r.isLoading);

  const all: { s: Service; t: TeamSummary }[] = [];
  results.forEach((r, i) => r.data?.forEach((s) => all.push({ s, t: teams![i] })));
  const rank = { down: 0, degraded: 1, unknown: 2, up: 3 } as const;
  all.sort((a, b) => rank[a.s.state] - rank[b.s.state] || a.s.name.localeCompare(b.s.name));
  const attention = all.filter((x) => x.s.state !== "up");
  const shown = f === "all" ? all : attention;
  const incidents = all.filter((x) => x.s.open_incident);
  const up = all.filter((x) => x.s.state === "up").length;

  return (
    <div>
      <PageHeader
        title="Services"
        sub={
          loading
            ? "Loading…"
            : incidents.length
              ? `${up} of ${all.length} up. ${plural(incidents.length, "incident")} open.`
              : `All ${all.length} services are up.`
        }
        right={
          <Segmented
            value={f}
            onChange={setF}
            options={[
              { value: "all", label: "All", count: all.length },
              { value: "attention", label: "Needs attention", count: attention.length },
            ]}
          />
        }
      />

      {incidents.length > 0 && (
        <Card className="mb-5 px-4 sm:px-5 py-3.5 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1">
          <span className="grid shrink-0 place-items-center size-8 rounded-lg bg-bad-soft text-bad">
            <Siren className="size-4" />
          </span>
          <div className="text-[14px] min-w-0 flex-1 basis-[calc(100%-2.75rem)] sm:basis-auto">
            <span className="font-semibold">{incidents.map((x) => x.s.name).join(", ")}</span>
            <span className="text-muted"> · {incidents[0].s.open_incident!.summary}</span>
          </div>
          <span className="max-sm:pl-11 sm:ml-auto text-[12px] text-muted whitespace-nowrap">
            {incidents[0].t.steward.emoji} {incidents[0].t.steward.name} is on it
          </span>
        </Card>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[300px] rounded-xl" />
          ))}
        </div>
      ) : !shown.length ? (
        <Card>
          <EmptyState title={f === "attention" ? "Everything is up" : "No services yet"} line={f === "attention" ? "Stewards check each service every minute." : "Add one from a team's Services tab."} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {shown.map(({ s, t }, i) => (
            <ServiceCard key={s.id} s={s} team={t} i={i} />
          ))}
        </div>
      )}
    </div>
  );
}
