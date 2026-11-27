import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { useAudit } from "../api/hooks";
import type { AuditEntry } from "../api/types";
import { Card, EmptyState, Input, PageHeader, Select, SkeletonRows } from "../components/ui";
import { TeamChip, useTeamMap } from "../components/keel";
import { ago, fullDate } from "../lib/time";
import { cn } from "../lib/utils";

const ACTION_TONE: Record<string, string> = {
  approval: "var(--t-violet)",
  operation: "var(--t-sky)",
  commitment: "var(--t-indigo)",
  level: "var(--t-green)",
  incident: "var(--t-red)",
  setup: "var(--t-gray)",
  knowledge: "var(--t-blue)",
  ask: "var(--t-amber)",
  brief: "var(--t-yellow)",
  steward: "#10b981",
};

function actionColor(a: string) {
  if (/failed|needs_review|unknown|reject/.test(a)) return a.includes("reject") ? "var(--t-gray)" : a.includes("failed") ? "var(--t-red)" : "var(--t-orange)";
  return ACTION_TONE[a.split(".")[0]] ?? "var(--t-gray)";
}

function targetLink(e: AuditEntry): string | null {
  if (/^C-\d+$/.test(e.target)) return `/commitments/${e.target}`;
  if (/^ap_/.test(e.target)) return "/approvals";
  if (e.action.startsWith("operation.")) return "/operations";
  if (e.action.startsWith("incident.")) return "/services";
  return null;
}

export function Audit() {
  const [team, setTeam] = useState("");
  const [kind, setKind] = useState("");
  const [actorKind, setActorKind] = useState<"" | "steward" | "human">("");
  const [q, setQ] = useState("");
  const { data, isLoading } = useAudit(team || undefined);
  const teams = useTeamMap();
  const stewardNames = useMemo(() => new Set(Object.values(teams).map((t) => t.steward.name)), [teams]);
  const isSteward = (actor: string) => stewardNames.has(actor.split(" ")[0]) || actor === "system";

  const kinds = useMemo(() => Array.from(new Set((data ?? []).map((e) => e.action.split(".")[0]))).sort(), [data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter(
      (e) =>
        (!kind || e.action.startsWith(kind + ".")) &&
        (!actorKind || (actorKind === "steward") === isSteward(e.actor)) &&
        (!s || `${e.actor} ${e.action} ${e.target} ${e.detail}`.toLowerCase().includes(s)),
    );
  }, [data, kind, actorKind, q, stewardNames]);

  return (
    <div>
      <PageHeader title="Audit log" sub="Everything stewards and people did, in order. Kept for as long as your policy says." />
      <div className="flex items-center gap-2 mb-4">
        <div className="relative w-[280px] shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actor, action, target…" className="pl-8! h-8! text-[13px]" />
        </div>
        <Select value={team} onChange={(e) => setTeam(e.target.value)} className="h-8! w-[150px]! shrink-0 text-[13px]">
          <option value="">All teams</option>
          {Object.values(teams).map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="h-8! w-[160px]! shrink-0 text-[13px]">
          <option value="">All actions</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Select value={actorKind} onChange={(e) => setActorKind(e.target.value as typeof actorKind)} className="h-8! w-[150px]! shrink-0 text-[13px]">
          <option value="">Anyone</option>
          <option value="steward">Stewards</option>
          <option value="human">People</option>
        </Select>
        <span className="ml-auto whitespace-nowrap text-[12px] text-faint tabular">{rows.length} entries</span>
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[110px_170px_190px_minmax(0,1fr)_110px] gap-4 px-5 h-9 items-center border-b border-line text-[11px] uppercase tracking-[0.07em] text-faint bg-sunken/60">
          <span>When</span>
          <span>Actor</span>
          <span>Action</span>
          <span>Target · detail</span>
          <span>Team</span>
        </div>
        {isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={8} />
          </div>
        ) : !rows.length ? (
          <EmptyState icon="🔎" title="No entries match" line="Try a wider filter." />
        ) : (
          rows.map((e) => {
            const link = targetLink(e);
            const c = actionColor(e.action);
            return (
              <div key={e.id} className="grid grid-cols-[110px_170px_190px_minmax(0,1fr)_110px] gap-4 px-5 py-2.5 items-center border-b border-line last:border-b-0 hover:bg-hover/60 transition-colors text-[13px]">
                <span className="text-faint text-[12px] tabular" title={fullDate(e.at)}>
                  {ago(e.at)}
                </span>
                <span className={cn("truncate", isSteward(e.actor) ? "text-fg" : "text-muted")}>{e.actor}</span>
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span className="size-1.5 rounded-full shrink-0" style={{ background: c }} />
                  <code className="font-mono text-[12px] truncate" style={{ color: c }}>
                    {e.action}
                  </code>
                </span>
                <span className="min-w-0 truncate">
                  {link ? (
                    <Link to={link} className="font-mono text-[12px] text-fg hover:text-accent">
                      {e.target}
                    </Link>
                  ) : (
                    <span className="font-mono text-[12px]">{e.target}</span>
                  )}
                  <span className="text-muted"> · {e.detail}</span>
                </span>
                <span>{e.team_slug ? <TeamChip slug={e.team_slug} team={teams[e.team_slug]} size="xs" /> : <span className="text-faint text-[12px]">Org</span>}</span>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
