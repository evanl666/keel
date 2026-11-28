import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Download, Search } from "lucide-react";
import { api } from "../api/client";
import { useAudit, useMe } from "../api/hooks";
import type { AuditEntry } from "../api/types";
import { buttonClass, Card, EmptyState, Input, PageHeader, Select, SkeletonRows } from "../components/ui";
import { TeamChip, useTeamMap } from "../components/keel";
import { ago, fullDate } from "../lib/time";
import { cn } from "../lib/utils";

function actionColor(a: string) {
  if (/failed|incident\.open/.test(a)) return "var(--bad)";
  if (/needs_review|unknown/.test(a)) return "var(--warn)";
  if (/approved|done|kept|resolved|sent|level/.test(a)) return "var(--ok)";
  return "var(--faint)";
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
  const { data: me } = useMe();
  const admin = me?.user?.role === "org_admin";
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
      <PageHeader
        title="Audit log"
        sub="Everything stewards and people did, in order. Kept for as long as your policy says."
        right={
          admin && (
            <a href={api.auditExportUrl} download className={buttonClass("secondary")}>
              <Download className="size-3.5" />
              Export CSV
            </a>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative w-full sm:w-[280px] shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actor, action, target…" className="pl-8!" aria-label="Search the audit log" />
        </div>
        <Select value={team} onChange={(e) => setTeam(e.target.value)} className="min-w-0 flex-1 basis-0 sm:flex-none sm:basis-auto sm:w-[150px]! sm:shrink-0">
          <option value="">All teams</option>
          {Object.values(teams).map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="min-w-0 max-sm:order-last max-sm:basis-full flex-1 basis-0 sm:flex-none sm:basis-auto sm:w-[160px]! sm:shrink-0">
          <option value="">All actions</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Select value={actorKind} onChange={(e) => setActorKind(e.target.value as typeof actorKind)} className="min-w-0 flex-1 basis-0 sm:flex-none sm:basis-auto sm:w-[150px]! sm:shrink-0">
          <option value="">Anyone</option>
          <option value="steward">Stewards</option>
          <option value="human">People</option>
        </Select>
        <span className="max-sm:order-last max-sm:w-full sm:ml-auto whitespace-nowrap text-[12px] text-muted tabular">{rows.length} entries</span>
      </div>
      <Card className="overflow-hidden">
        <div className="hidden xl:grid grid-cols-[110px_170px_190px_minmax(0,1fr)_110px] gap-4 px-5 h-9 items-center border-b border-line text-[12px] text-muted">
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
          <EmptyState title="No entries match" line="Try a wider filter." />
        ) : (
          rows.map((e) => {
            const link = targetLink(e);
            const c = actionColor(e.action);
            return (
              <div key={e.id} className="grid grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:'action_time'_'target_target'_'actor_team'] gap-x-3 gap-y-1 xl:grid-cols-[110px_170px_190px_minmax(0,1fr)_110px] xl:[grid-template-areas:none] xl:gap-4 px-4 sm:px-5 py-3 xl:py-2.5 items-center border-b border-line last:border-b-0 hover:bg-hover/60 transition-colors text-[14px]">
                <span className="[grid-area:time] xl:[grid-area:auto] text-right xl:text-left whitespace-nowrap text-muted text-[12px] tabular" title={fullDate(e.at)}>
                  {ago(e.at)}
                </span>
                <span className={cn("[grid-area:actor] xl:[grid-area:auto] min-w-0 truncate max-xl:text-[12px]", isSteward(e.actor) ? "text-fg" : "text-muted")}>{e.actor}</span>
                <span className="[grid-area:action] xl:[grid-area:auto] inline-flex items-center gap-2 min-w-0">
                  <span className="size-1.5 rounded-full shrink-0" style={{ background: c }} />
                  <code className="font-mono text-[12px] truncate text-soft">
                    {e.action}
                  </code>
                </span>
                <span className="[grid-area:target] xl:[grid-area:auto] min-w-0 max-xl:line-clamp-2 max-xl:break-words xl:truncate">
                  {link ? (
                    <Link to={link} className="font-mono text-[12px] text-fg hover:text-accent">
                      {e.target}
                    </Link>
                  ) : (
                    <span className="font-mono text-[12px]">{e.target}</span>
                  )}
                  <span className="text-muted"> · {e.detail}</span>
                </span>
                <span className="[grid-area:team] xl:[grid-area:auto] justify-self-end xl:justify-self-auto">{e.team_slug ? <TeamChip slug={e.team_slug} team={teams[e.team_slug]} size="xs" /> : <span className="text-muted text-[12px]">Org</span>}</span>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
