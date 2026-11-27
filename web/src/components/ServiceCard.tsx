import { useState } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Play, Siren, Lock } from "lucide-react";
import { api, errorLine } from "../api/client";
import type { Service, TeamSummary } from "../api/types";
import { Button, Card, Tooltip } from "./ui";
import { LevelBadge, Sparkline, StewardAvatar, UptimeBar } from "./keel";
import { useToast } from "./toast";
import { ago } from "../lib/time";
import { alpha, cn } from "../lib/utils";

export const SERVICE_STATE: Record<Service["state"], { label: string; color: string }> = {
  up: { label: "Up", color: "var(--ok)" },
  degraded: { label: "Degraded", color: "var(--warn)" },
  down: { label: "Down", color: "var(--bad)" },
  unknown: { label: "Unknown", color: "var(--faint)" },
};

export function ServiceCard({ s, team, showTeam = true, i = 0 }: { s: Service; team?: TeamSummary; showTeam?: boolean; i?: number }) {
  const st = SERVICE_STATE[s.state];
  const qc = useQueryClient();
  const toast = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (rb: { id: string; name: string }) => api.runRunbook(s.id, rb.id),
    onMutate: (rb) => setRunning(rb.id),
    onSuccess: (op, rb) =>
      toast({
        title: op.status === "awaiting_approval" ? `${rb.name} waits for approval` : `Running ${rb.name}`,
        line: `${team?.steward.name ?? "The steward"} logged it as ${op.op_id}.`,
        icon: "🛠️",
      }),
    onError: (e, rb) => toast({ title: `${rb.name} didn't run`, line: errorLine(e), tone: "bad" }),
    onSettled: () => {
      setRunning(null);
      qc.invalidateQueries({ predicate: (q) => ["operations", "services", "approvals", "audit", "overview", "teams"].includes(q.queryKey[0] as string) });
    },
  });
  const lineColor = s.state === "down" ? "var(--bad)" : s.state === "degraded" ? "var(--warn)" : team?.color ?? "var(--accent)";
  const uptime = s.uptime_24h == null ? null : s.uptime_24h * 100;
  const lastBad = [...s.checks].reverse().find((c) => !c.ok);
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.3 }}>
      <Card className={cn("overflow-hidden h-full flex flex-col", s.state === "down" && "border-bad/35")} glow={s.state === "down" ? "rgba(248,113,113,0.08)" : undefined}>
        <div className="px-5 pt-4 flex items-start gap-3">
          <span className="relative mt-1.5 grid place-items-center size-2.5 shrink-0">
            {s.state !== "up" && s.state !== "unknown" && <span className="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: st.color }} />}
            <span className="relative size-2.5 rounded-full" style={{ background: st.color, boxShadow: `0 0 10px ${st.color}` }} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[14.5px] truncate">{s.name}</span>
              <span className="text-[12px] font-medium" style={{ color: st.color }}>
                {st.label}
              </span>
            </div>
            <div className="text-[12px] text-faint font-mono truncate mt-0.5">{s.url.replace(/^https?:\/\//, "")}</div>
          </div>
          {showTeam && team && (
            <Link to={`/teams/${team.slug}/services`} className="shrink-0 flex items-center gap-1.5 text-[12px] text-muted hover:text-fg">
              <StewardAvatar emoji={team.steward.emoji} color={team.color} size="xs" active={false} />
              {team.name}
            </Link>
          )}
        </div>

        {s.open_incident && (
          <div className="mx-5 mt-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-bad">
              <Siren className="size-3.5" />
              Incident · open {ago(s.open_incident.opened_at).replace(" ago", "")}
              {s.open_incident.commitment_key && (
                <Link to={`/commitments/${s.open_incident.commitment_key}`} className="ml-auto inline-flex items-center gap-0.5 font-mono text-[11.5px] hover:underline">
                  {s.open_incident.commitment_key}
                  <ArrowUpRight className="size-3" />
                </Link>
              )}
            </div>
            <div className="text-[12.5px] text-fg/85 mt-1 leading-snug">{s.open_incident.summary}</div>
          </div>
        )}

        <div className="px-5 mt-3 grid grid-cols-3 gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-faint">Uptime 24h</div>
            <div className={cn("text-[17px] font-semibold tabular mt-0.5", uptime == null ? "" : uptime < 95 ? "text-bad" : uptime < 99.5 ? "text-warn" : "")}>
              {uptime == null ? "—" : `${uptime >= 99.995 ? "100" : uptime.toFixed(uptime >= 99.9 ? 2 : 1)}%`}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-faint">p50</div>
            <div className="text-[17px] font-semibold tabular mt-0.5">
              {s.latency_p50_ms == null ? "—" : s.latency_p50_ms}
              <span className="text-[12px] text-faint font-normal ml-0.5">ms</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-faint">Owner</div>
            <div className="text-[13px] mt-1.5 truncate text-muted">{s.owner ?? "—"}</div>
          </div>
        </div>

        <div className="px-5 mt-3">
          <Sparkline checks={s.checks} color={lineColor} height={46} />
          <div className="mt-2">
            <UptimeBar checks={s.checks} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-faint">
            <span>{s.checks.length} checks</span>
            <span>{lastBad ? `last failure ${ago(lastBad.at)}` : "no failures"}</span>
          </div>
        </div>

        <div className="mt-auto px-5 py-3.5 mt-4 border-t border-line flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-[0.06em] text-faint mr-1">Runbooks</span>
          {s.runbooks.length === 0 && <span className="text-[12.5px] text-faint">None yet</span>}
          {s.runbooks.map((rb) => {
            const level = team?.steward.level ?? 0;
            const tooLow = level < rb.min_level;
            const paused = !!team?.steward.paused;
            const why = tooLow
              ? `${team?.steward.name ?? "The steward"} is L${level}. This runbook needs L${rb.min_level}.`
              : paused
                ? `${team?.steward.name ?? "The steward"} is paused. Resume it to run this.`
                : `Runs as ${team?.steward.name ?? "the steward"}. Needs L${rb.min_level}.`;
            return (
              <Tooltip key={rb.id} content={why} className={cn((tooLow || paused) && "cursor-not-allowed")}>
                <Button
                  size="sm"
                  variant={s.state === "down" && !tooLow ? "primary" : "secondary"}
                  disabled={tooLow || paused}
                  loading={running === rb.id}
                  icon={tooLow ? <Lock className="size-3" /> : <Play className="size-3" />}
                  onClick={() => run.mutate(rb)}
                >
                  {rb.name}
                  <span className="opacity-60 text-[11px] font-normal">L{rb.min_level}</span>
                </Button>
              </Tooltip>
            );
          })}
        </div>
      </Card>
    </motion.div>
  );
}

export function TeamServicesHeader({ team }: { team: TeamSummary }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted">
      <StewardAvatar emoji={team.steward.emoji} color={team.color} size="xs" active={false} />
      <span className="font-medium text-fg">{team.steward.name}</span>
      <LevelBadge level={team.steward.level} />
      <span style={{ color: alpha(team.color, 1) }}>{team.name}</span>
    </div>
  );
}
