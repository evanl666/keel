import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sun, CalendarDays } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { qk, useApprovals, useBriefs } from "../../api/hooks";
import type { TeamDetail } from "../../api/types";
import { Badge, Button, buttonClass, Card, CardHeader, EmptyState, Skeleton } from "../../components/ui";
import { DUTY_META, HealthRing, LevelBadge, Markdown, StewardAvatar, useTeamMap } from "../../components/keel";
import { ActivityFeed } from "../../components/ActivityFeed";
import { mergeActivity, useStream } from "../../components/stream";
import { useToast } from "../../components/toast";
import { ago, fullDate } from "../../lib/time";
import { cn } from "../../lib/utils";

export function TodayTab({ t }: { t: TeamDetail }) {
  const { data: briefs } = useBriefs(t.slug);
  const { data: approvals } = useApprovals();
  const [sel, setSel] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const teams = useTeamMap();
  const stream = useStream();
  const gen = useMutation({
    mutationFn: (kind: "daily" | "weekly") => api.createBrief(t.slug, kind),
    onSuccess: (b) => {
      setSel(b.id);
      qc.invalidateQueries({ queryKey: qk.briefs(t.slug) });
      qc.invalidateQueries({ queryKey: qk.team(t.slug) });
      toast({ title: `${t.steward.name} wrote a new brief`, line: b.title, icon: "☀️" });
    },
    onError: (e) => toast({ title: "No new brief", line: errorLine(e), tone: "bad" }),
  });
  const list = briefs ?? (t.today ? [t.today] : []);
  const brief = list.find((b) => b.id === sel) ?? t.today ?? list[0];
  const mine = (approvals ?? []).filter((a) => a.team_slug === t.slug);
  const activity = mergeActivity(t.activity, stream.items, t.slug);

  return (
    <div className="space-y-5">
    <StewardSummary t={t} />
    {mine.length > 0 && (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
        <span className="size-2 rounded-full bg-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">
            {mine.length} {mine.length === 1 ? "draft waits" : "drafts wait"} for you
          </div>
          <div className="text-[12px] text-muted truncate">{mine.slice(0, 3).map((a) => a.title).join(" · ")}</div>
        </div>
        <Link to="/approvals" className={buttonClass("primary")}>
          Review
        </Link>
      </div>
    )}
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5">
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Sun className="size-4 text-muted" />
                {brief ? brief.title : "Today's brief"}
              </span>
            }
            sub={brief ? <span title={fullDate(brief.created_at)}>Written by {t.steward.name} {ago(brief.created_at)}</span> : undefined}
            right={
              <>
                <Button size="sm" variant="ghost" icon={<CalendarDays className="size-3.5" />} loading={gen.isPending && gen.variables === "weekly"} onClick={() => gen.mutate("weekly")}>
                  Weekly
                </Button>
                <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={gen.isPending && gen.variables === "daily"} onClick={() => gen.mutate("daily")}>
                  Generate daily brief
                </Button>
              </>
            }
          />
          <div className="px-5 pb-5 pt-1">
            {brief ? (
              <Markdown>{brief.markdown}</Markdown>
            ) : briefs ? (
              <EmptyState title="No brief yet today" line={`${t.steward.name} writes one each morning. You can ask for one now.`} action={<Button variant="primary" onClick={() => gen.mutate("daily")}>Generate daily brief</Button>} />
            ) : (
              <div className="space-y-2.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            )}
          </div>
        </Card>
        {list.length > 1 && (
          <Card className="p-2">
            <div className="px-3 pt-2 pb-1.5 text-[12px] text-muted">Earlier briefs</div>
            {list.map((b) => (
              <button
                key={b.id}
                onClick={() => setSel(b.id)}
                className={cn("w-full flex items-center gap-3 h-10 lg:h-9 px-3 rounded-lg text-left text-[14px] cursor-pointer transition-colors", b.id === brief?.id ? "bg-hover text-fg" : "text-soft hover:bg-hover")}
              >
                <span className="text-[14px]">{b.kind === "weekly" ? "🗓️" : b.kind === "checkup" ? "🩺" : "☀️"}</span>
                <span className="flex-1 truncate">{b.title}</span>
                <span className="shrink-0 text-[12px] text-muted">{ago(b.created_at)}</span>
              </button>
            ))}
          </Card>
        )}
      </div>
      <div className="min-w-0">
        <Card>
          <CardHeader title="Activity" sub={`What ${t.steward.name} did lately`} />
          <div className="px-2.5 pb-3">
            {activity.length ? <ActivityFeed items={activity} teams={teams} limit={12} dense /> : <EmptyState title="Quiet so far" line={`${t.steward.name} will log what it does here.`} />}
          </div>
        </Card>
      </div>
    </div>
    </div>
  );
}

/** The steward at a glance: status, duties, health and the team's numbers. */
function StewardSummary({ t }: { t: TeamDetail }) {
  const n = (v: number, label: ReactNode, tone?: string) => (
    <div className="min-w-0">
      <div className={cn("text-[20px] font-semibold tabular tracking-[-0.01em]", tone)}>{v}</div>
      <div className="text-[12px] text-muted truncate">{label}</div>
    </div>
  );
  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <StewardAvatar emoji={t.steward.emoji} color={t.color} paused={t.steward.paused} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[16px] font-semibold tracking-[-0.01em]">{t.steward.name}</span>
            <LevelBadge level={t.steward.level} name={t.steward.level_name} />
            {t.steward.paused && <Badge tone="warn">Paused</Badge>}
          </div>
          <div className="mt-1 flex items-start gap-2 text-[14px] text-soft">
            <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", t.steward.paused ? "bg-faint" : "bg-ok live-dot")} />
            {t.steward.status_line}
          </div>
          <div className="mt-2 text-[12px] text-muted">
            {t.steward.duties.map((d, i) => (
              <span key={d}>
                {i > 0 && " · "}
                {DUTY_META[d]?.icon} {DUTY_META[d]?.label ?? d}
              </span>
            ))}
          </div>
        </div>
        <div className="max-sm:hidden flex flex-col items-center gap-1 shrink-0">
          <HealthRing value={t.health} size={48} />
          <span className="text-[12px] text-muted">Health</span>
        </div>
      </div>
      <div className="mt-5 pt-4 border-t border-line grid grid-cols-3 sm:grid-cols-5 gap-4">
        {n(t.counts.open, "open")}
        {n(t.counts.at_risk, "at risk", t.counts.at_risk ? "text-warn" : undefined)}
        {n(t.counts.overdue, "overdue", t.counts.overdue ? "text-bad" : undefined)}
        {n(t.counts.requests_in, `asked of ${t.name}`)}
        {n(t.counts.requests_out, `asked by ${t.name}`)}
      </div>
      {(t.counts.pending_approvals > 0 || t.counts.incidents_open > 0) && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          {t.counts.pending_approvals > 0 && (
            <Link to="/approvals" className="text-accent hover:underline">
              {t.counts.pending_approvals} waiting for approval →
            </Link>
          )}
          {t.counts.incidents_open > 0 && (
            <Link to={`/teams/${t.slug}/services`} className="text-bad hover:underline">
              {t.counts.incidents_open} incident open →
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
