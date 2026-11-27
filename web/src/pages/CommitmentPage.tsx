import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, MessageSquare, GitBranch, Globe, Bot, Activity as ActivityIcon, Sparkles, CornerDownLeft } from "lucide-react";
import { api, errorLine } from "../api/client";
import { qk, useCommitment } from "../api/hooks";
import type { CommitmentDetail, CommitmentStatus, Operation, Priority } from "../api/types";
import { Button, Card, CardHeader, EmptyState, ErrorLine, Input, Select, Skeleton } from "../components/ui";
import { DueText, LabelBadge, OpStatusPill, PriorityIcon, RiskTag, STATUS_META, StatusIcon, TeamChip, useTeamMap } from "../components/keel";
import { useToast } from "../components/toast";
import { ago, fullDate } from "../lib/time";
import { cn } from "../lib/utils";

const SOURCE: Record<CommitmentDetail["source_kind"], { label: string; icon: ReactNode }> = {
  slack: { label: "Slack", icon: <MessageSquare className="size-3.5" /> },
  github: { label: "GitHub", icon: <GitBranch className="size-3.5" /> },
  web: { label: "Keel", icon: <Globe className="size-3.5" /> },
  steward: { label: "Steward", icon: <Bot className="size-3.5" /> },
  service: { label: "Service check", icon: <ActivityIcon className="size-3.5" /> },
  demo: { label: "Demo", icon: <Sparkles className="size-3.5" /> },
};

const EVENT_TONE: Record<string, string> = {
  risk: "var(--warn)",
  blocked: "var(--bad)",
  accepted: "var(--ok)",
  unblocked: "var(--ok)",
  status: "var(--accent)",
  request: "var(--t-violet)",
  draft: "var(--t-violet)",
  operation: "var(--t-orange)",
};

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-h-[34px]">
      <span className="w-[86px] shrink-0 text-[12.5px] text-faint">{label}</span>
      <span className="min-w-0 flex-1 flex items-center gap-2 text-[13px]">{children}</span>
    </div>
  );
}

export function OperationRow({ o, compact }: { o: Operation; compact?: boolean }) {
  return (
    <div className={cn("px-5 py-3 border-t border-line first:border-t-0", compact && "px-4")}>
      <div className="flex items-center gap-3">
        <OpStatusPill status={o.status} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{o.summary}</span>
        <span className="text-[12px] text-faint tabular whitespace-nowrap">{ago(o.updated_at)}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-faint flex-wrap">
        <code className="font-mono text-[11.5px] text-muted bg-hover border border-line rounded px-1.5 py-px">{o.op_id}</code>
        <span>{o.kind}</span>
        <span>→</span>
        <span className="font-mono text-[11.5px]">{o.target}</span>
        {o.attempts > 1 && <span>· {o.attempts} attempts</span>}
        {o.remote_ref && (
          <a href={o.remote_ref.startsWith("http") ? o.remote_ref : undefined} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            <ExternalLink className="size-3" />
            {o.remote_ref.startsWith("http") ? "Open" : o.remote_ref}
          </a>
        )}
      </div>
      {o.error_line && (
        <div className={cn("mt-2 text-[12.5px] leading-snug flex items-start gap-2", o.status === "failed" ? "text-bad" : "text-[#fb923c]")}>
          <span className="mt-[6px] size-1.5 rounded-full bg-current shrink-0" />
          {o.error_line}
        </div>
      )}
    </div>
  );
}

export function CommitmentPage() {
  const { key = "" } = useParams();
  const nav = useNavigate();
  const { data: c, isLoading, error } = useCommitment(key);
  const teams = useTeamMap();
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof api.patchCommitment>[1]) => api.patchCommitment(key, body),
    onSuccess: (d) => {
      qc.setQueryData(qk.commitment(key), d);
      qc.invalidateQueries({ predicate: (q) => ["commitments", "overview", "teams", "team"].includes(q.queryKey[0] as string) });
    },
    onError: (e) => toast({ title: "Nothing changed", line: errorLine(e), tone: "bad" }),
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-8 space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="col-span-4 h-80" />
      </div>
    );
  }
  if (!c) {
    return (
      <EmptyState
        icon="🔎"
        title={`Can't open ${key}`}
        line={error ? errorLine(error) : undefined}
        action={<Button onClick={() => nav("/ledger")}>Back to ledger</Button>}
      />
    );
  }
  const src = SOURCE[c.source_kind];
  const closed = ["done", "dropped", "declined"].includes(c.status);

  return (
    <div>
      <Link to="/ledger" className="inline-flex items-center gap-1.5 text-[12.5px] text-faint hover:text-fg mb-4 transition-colors">
        <ArrowLeft className="size-3.5" /> Ledger
      </Link>
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-8 min-w-0">
          <div className="flex items-center gap-2 text-[12.5px] text-faint">
            <span className="font-mono">{c.key}</span>
            <span>·</span>
            <StatusIcon status={c.status} size={13} />
            <span>{STATUS_META[c.status].label}</span>
            <RiskTag risk={c.risk} />
          </div>
          <h1 className="mt-2 text-[24px] font-semibold tracking-[-0.025em] leading-tight">{c.title}</h1>
          {c.detail && <p className="mt-3 text-[14px] leading-relaxed text-fg/80 max-w-[680px]">{c.detail}</p>}

          <Card className="mt-6">
            <CardHeader title="Timeline" sub={`${c.events.length} events`} />
            <ol className="relative px-5 pb-4">
              <span className="absolute left-[27px] top-2 bottom-6 w-px bg-line" />
              {c.events.map((e, i) => (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="relative flex gap-3.5 py-2"
                >
                  <span className="relative z-10 mt-[5px] grid size-[15px] shrink-0 place-items-center rounded-full bg-panel">
                    <span className="size-[7px] rounded-full" style={{ background: EVENT_TONE[e.kind] ?? "var(--faint)" }} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug">
                      <span className="font-medium">{e.actor}</span> <span className="text-fg/80">{e.text}</span>
                    </div>
                    <div className="text-[11.5px] text-faint mt-0.5" title={new Date(e.at).toLocaleString()}>
                      {e.kind} · {ago(e.at)}
                    </div>
                  </div>
                </motion.li>
              ))}
            </ol>
            <form
              className="flex items-center gap-2 px-5 py-3 border-t border-line"
              onSubmit={(e) => {
                e.preventDefault();
                if (!note.trim()) return;
                patch.mutate({ note: note.trim() }, { onSuccess: () => setNote("") });
              }}
            >
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the timeline…" className="flex-1" />
              <Button type="submit" loading={patch.isPending && !!note} disabled={!note.trim()} icon={<CornerDownLeft className="size-3.5" />}>
                Add
              </Button>
            </form>
          </Card>

          <Card className="mt-4">
            <CardHeader title="Operations" sub="Everything Keel sent, or tried to send, for this commitment." />
            {c.operations.length ? (
              <div className="border-t border-line">
                {c.operations.map((o) => (
                  <OperationRow key={o.id} o={o} />
                ))}
              </div>
            ) : (
              <div className="px-5 pb-5 text-[13px] text-faint">Nothing sent yet.</div>
            )}
          </Card>
        </div>

        <aside className="col-span-4">
          <Card className="p-5 sticky top-6">
            <div className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-faint mb-2">Properties</div>
            <Prop label="Status">
              <Select
                value={c.status}
                onChange={(e) => patch.mutate({ status: e.target.value as CommitmentStatus })}
                className="!h-8 text-[13px]"
              >
                {(Object.keys(STATUS_META) as CommitmentStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </Select>
            </Prop>
            <Prop label="Priority">
              <PriorityIcon priority={c.priority} />
              <Select value={c.priority} onChange={(e) => patch.mutate({ priority: e.target.value as Priority })} className="!h-8 text-[13px]">
                {["urgent", "high", "normal", "low"].map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </Select>
            </Prop>
            <Prop label="Due">{closed ? <span className="text-faint">—</span> : <><DueText iso={c.due_at} />{c.due_at && <span className="text-faint text-[12px]">{fullDate(c.due_at)}</span>}</>}</Prop>
            <div className="my-2 border-t border-line" />
            <Prop label="Owner">
              <TeamChip slug={c.owner_team} team={teams[c.owner_team]} link />
              <span className="truncate text-muted">{c.owner_person ?? "No one yet"}</span>
            </Prop>
            <Prop label="Asked by">
              {c.requester_team ? (
                <>
                  <TeamChip slug={c.requester_team} team={teams[c.requester_team]} link />
                  <span className="truncate text-muted">{c.requester_person}</span>
                </>
              ) : (
                <span className="text-faint">Own team</span>
              )}
            </Prop>
            <div className="my-2 border-t border-line" />
            <Prop label="Label">
              <LabelBadge label={c.label} />
            </Prop>
            <Prop label="Source">
              <span className="inline-flex items-center gap-1.5 text-muted">
                {src.icon}
                {src.label}
              </span>
              {c.source_url && (
                <a href={c.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent text-[12.5px] hover:underline">
                  Open <ExternalLink className="size-3" />
                </a>
              )}
            </Prop>
            <Prop label="Created">
              <span className="text-muted">{ago(c.created_at)}</span>
            </Prop>
            <Prop label="Updated">
              <span className="text-muted">{ago(c.updated_at)}</span>
            </Prop>
            {patch.isError && <ErrorLine className="mt-3" error={errorLine(patch.error)} />}
          </Card>
        </aside>
      </div>
    </div>
  );
}
