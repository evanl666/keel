import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sun, CalendarDays } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { qk, useApprovals, useBriefs } from "../../api/hooks";
import type { TeamDetail } from "../../api/types";
import { Button, Card, CardHeader, EmptyState, Skeleton } from "../../components/ui";
import { Markdown, useTeamMap } from "../../components/keel";
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5">
      <div className="lg:col-span-8 min-w-0 space-y-5">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Sun className="size-4 text-warn" />
                {brief ? brief.title : "Today's brief"}
              </span>
            }
            sub={brief ? <span title={fullDate(brief.created_at)}>Written by {t.steward.name} {ago(brief.created_at)}</span> : undefined}
            right={
              <>
                <Button size="sm" variant="ghost" icon={<CalendarDays className="size-3.5" />} loading={gen.isPending && gen.variables === "weekly"} onClick={() => gen.mutate("weekly")}>
                  Weekly
                </Button>
                <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={gen.isPending && gen.variables === "daily"} onClick={() => gen.mutate("daily")}>
                  Generate daily brief
                </Button>
              </>
            }
          />
          <div className="px-4 pb-5 sm:px-6 sm:pb-6 pt-1">
            {brief ? (
              <Markdown>{brief.markdown}</Markdown>
            ) : briefs ? (
              <EmptyState icon="☀️" title="No brief yet today" line={`${t.steward.name} writes one each morning. You can ask for one now.`} action={<Button variant="primary" onClick={() => gen.mutate("daily")}>Generate daily brief</Button>} />
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
            <div className="px-3 pt-2 pb-1.5 text-[11px] uppercase tracking-[0.07em] text-faint">Earlier briefs</div>
            {list.map((b) => (
              <button
                key={b.id}
                onClick={() => setSel(b.id)}
                className={cn("w-full flex items-center gap-3 h-10 lg:h-9 px-3 rounded-lg text-left text-[13px] cursor-pointer transition-colors", b.id === brief?.id ? "bg-hover text-fg" : "text-muted hover:bg-hover/60")}
              >
                <span className="text-[13px]">{b.kind === "weekly" ? "🗓️" : b.kind === "checkup" ? "🩺" : "☀️"}</span>
                <span className="flex-1 truncate">{b.title}</span>
                <span className="shrink-0 text-[12px] text-faint">{ago(b.created_at)}</span>
              </button>
            ))}
          </Card>
        )}
      </div>
      <div className="contents lg:block lg:col-span-4 lg:space-y-5">
        {mine.length > 0 && (
          <Card className="p-4 border-accent/30 max-lg:order-first" glow="rgba(123,136,255,0.1)">
            <div className="text-[13px] font-semibold">
              {mine.length} {mine.length === 1 ? "draft waits" : "drafts wait"} for you
            </div>
            <ul className="mt-2 space-y-1.5">
              {mine.slice(0, 3).map((a) => (
                <li key={a.id} className="text-[12.5px] text-muted truncate">
                  · {a.title}
                </li>
              ))}
            </ul>
            <Link to="/approvals" className="mt-3 inline-block">
              <Button size="sm" variant="primary">
                Review
              </Button>
            </Link>
          </Card>
        )}
        <Card>
          <CardHeader title="Activity" sub={`What ${t.steward.name} did lately`} />
          <div className="px-2.5 pb-3">
            {activity.length ? <ActivityFeed items={activity} teams={teams} limit={12} dense /> : <EmptyState icon="🍃" title="Quiet so far" line={`${t.steward.name} will log what it does here.`} />}
          </div>
        </Card>
      </div>
    </div>
  );
}
