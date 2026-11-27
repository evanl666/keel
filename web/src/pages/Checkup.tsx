import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Download, ExternalLink, GitBranch, Loader2, Stethoscope } from "lucide-react";
import { api, errorLine } from "../api/client";
import { qk, useCheckup, useCheckupSvg, useCheckups } from "../api/hooks";
import type { CheckupFinding, CheckupReport } from "../api/types";
import { Button, Card, ErrorLine, Input, Skeleton } from "../components/ui";
import { Ring } from "../components/keel";
import { useToast } from "../components/toast";
import { copyText, downloadText, fileSlug, svgDataUrl } from "../lib/share";
import { ago } from "../lib/time";
import { cn } from "../lib/utils";

const SEV: Record<CheckupFinding["severity"], { label: string; color: string; line: string }> = {
  high: { label: "Fix first", color: "var(--t-red)", line: "These cost you the most right now." },
  medium: { label: "Worth a look", color: "var(--t-amber)", line: "Small changes, noticeable relief." },
  low: { label: "Tidy up", color: "var(--t-blue)", line: "When you have a quiet afternoon." },
};

const STEPS = ["Reading open issues", "Reading pull requests", "Finding promises in comments", "Checking branch rules and CI", "Scoring"];

function gradeColor(g: string | null) {
  if (!g) return "var(--faint)";
  if (g.startsWith("A")) return "var(--t-green2)";
  if (g.startsWith("B")) return "var(--t-indigo)";
  if (g.startsWith("C")) return "var(--t-amber)";
  return "var(--t-red)";
}

const STAT_LABELS: Record<string, string> = {
  open_prs: "Open PRs",
  stale_prs: "Stale PRs",
  awaiting_review: "Awaiting review",
  median_merge_hours: "Median merge",
  open_issues: "Open issues",
  unowned_old_issues: "Unowned old issues",
  ci: "CI on main",
  default_branch: "Default branch",
  stars: "Stars",
};

function statLabel(key: string) {
  return STAT_LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function statValue(key: string, v: unknown) {
  if (key === "median_merge_hours" && typeof v === "number") return v >= 48 ? `${(v / 24).toFixed(1)}d` : `${v}h`;
  return String(v);
}

function verdict(score: number) {
  if (score >= 90) return "In great shape. A steward will mostly keep it that way.";
  if (score >= 75) return "Healthy, with a few promises slipping through the cracks.";
  if (score >= 60) return "Workable, but promises and reviews are getting lost.";
  return "Things are slipping. A steward would help right away.";
}

function Running({ r }: { r: CheckupReport }) {
  const [t, setT] = useState(() => Date.now() - new Date(r.created_at).getTime());
  useEffect(() => {
    const iv = setInterval(() => setT(Date.now() - new Date(r.created_at).getTime()), 250);
    return () => clearInterval(iv);
  }, [r.created_at]);
  const step = Math.min(STEPS.length - 1, Math.floor(t / 1100));
  return (
    <Card className="p-5 sm:p-8 overflow-hidden" glow="rgba(123,136,255,0.12)">
      <div className="flex flex-col sm:flex-row items-center sm:items-center gap-6 sm:gap-8">
        <div className="relative size-[132px] grid place-items-center shrink-0">
          <motion.div className="absolute inset-0 rounded-full border-2 border-accent/25 border-t-accent" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.4, ease: "linear" }} />
          <motion.div className="absolute inset-3 rounded-full border border-accent/15 border-b-accent/60" animate={{ rotate: -360 }} transition={{ repeat: Infinity, duration: 2.6, ease: "linear" }} />
          <Stethoscope className="size-9 text-accent" />
        </div>
        <div className="min-w-0 flex-1 max-sm:w-full">
          <div className="text-[13px] text-faint font-mono flex items-center gap-1.5">
            <GitBranch className="size-3.5 shrink-0" />
            {r.repo}
          </div>
          <div className="text-[20px] font-semibold tracking-[-0.02em] mt-1">Taking a look…</div>
          <div className="mt-4 space-y-2">
            {STEPS.map((s, i) => (
              <motion.div key={s} initial={{ opacity: 0, x: -6 }} animate={{ opacity: i <= step ? 1 : 0.35, x: 0 }} transition={{ delay: i * 0.05 }} className="flex items-center gap-2.5 text-[13.5px]">
                <span className={cn("grid place-items-center size-[18px] rounded-full border", i < step ? "bg-ok/15 border-ok/40 text-ok" : i === step ? "border-accent/50 text-accent" : "border-line text-faint")}>
                  {i < step ? <Check className="size-3" /> : i === step ? <Loader2 className="size-3 animate-spin" /> : null}
                </span>
                <span className={i <= step ? "text-fg" : "text-faint"}>{s}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

// Next to the promise badge from examples/workflows/promise-check.yml.
const CHECKUP_BADGE_PATH = ".github/badges/checkup.svg";

function ShareRow({ r }: { r: CheckupReport }) {
  const toast = useToast();
  const badge = useCheckupSvg(r.id, "badge");
  const [busy, setBusy] = useState<"badge" | "card" | null>(null);
  const base = `${fileSlug(r.repo)}-checkup`;
  const download = async (kind: "badge" | "card") => {
    setBusy(kind);
    try {
      const svg = kind === "badge" ? (badge.data ?? (await api.checkupBadge(r.id))) : await api.checkupCard(r.id);
      downloadText(kind === "badge" ? "checkup.svg" : `${base}-card.svg`, svg);
    } catch (e) {
      toast({ title: "The download didn't start", line: errorLine(e), tone: "bad" });
    } finally {
      setBusy(null);
    }
  };
  const copyBadge = async () => {
    // A path inside the repo, not a link to this Keel: the API needs a sign-in and a README is public.
    const md = `![keel checkup](${CHECKUP_BADGE_PATH})`;
    try {
      await copyText(md);
      toast({ title: "Badge Markdown copied", line: `Save the downloaded badge as ${CHECKUP_BADGE_PATH} in the repo.`, icon: "📋" });
    } catch (e) {
      toast({ title: "Nothing was copied", line: errorLine(e), tone: "bad" });
    }
  };
  return (
    <div className="px-4 sm:px-6 py-4 border-t border-line flex flex-col md:flex-row md:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[13px] font-semibold">Share it</span>
        {badge.data ? <img src={svgDataUrl(badge.data)} alt={`keel checkup ${r.grade} · ${r.score}`} className="h-5 w-auto" /> : <Skeleton className="h-5 w-[120px]" />}
      </div>
      <div className="md:ml-auto flex flex-wrap gap-2">
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copyBadge}>
          Copy badge Markdown
        </Button>
        <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === "badge"} onClick={() => download("badge")}>
          Download badge
        </Button>
        <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === "card"} onClick={() => download("card")}>
          Download share card
        </Button>
      </div>
    </div>
  );
}

function Report({ r }: { r: CheckupReport }) {
  const score = r.score ?? 0;
  const color = gradeColor(r.grade);
  const groups = (["high", "medium", "low"] as const).map((s) => ({ s, items: r.findings.filter((f) => f.severity === s) })).filter((g) => g.items.length);
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card className="overflow-hidden">
        <div className="relative px-5 py-6 sm:px-8 sm:py-7 flex flex-col sm:flex-row items-start sm:items-center gap-5 sm:gap-8 border-b border-line" style={{ backgroundImage: `radial-gradient(70% 140% at 0% 0%, color-mix(in srgb, ${color} 16%, transparent), transparent 60%)` }}>
          <Ring value={score} size={136} stroke={8} color={color}>
            <div className="text-center">
              <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.25 }} className="text-[52px] leading-none font-bold tracking-[-0.04em]" style={{ color }}>
                {r.grade}
              </motion.div>
              <div className="text-[12px] text-faint tabular mt-1">{score} / 100</div>
            </div>
          </Ring>
          <div className="min-w-0 flex-1">
            <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className="text-[13px] text-faint font-mono inline-flex items-center gap-1.5 hover:text-fg">
              <GitBranch className="size-3.5" />
              {r.repo}
              <ExternalLink className="size-3" />
            </a>
            <div className="text-[20px] sm:text-[22px] font-semibold tracking-[-0.02em] mt-1 leading-tight">{verdict(score)}</div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {groups.map((g) => (
                <span key={g.s} className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[12px] font-medium border" style={{ color: SEV[g.s].color, borderColor: `color-mix(in srgb, ${SEV[g.s].color} 30%, transparent)`, background: `color-mix(in srgb, ${SEV[g.s].color} 10%, transparent)` }}>
                  <span className="size-1.5 rounded-full" style={{ background: SEV[g.s].color }} />
                  {g.items.length} {SEV[g.s].label.toLowerCase()}
                </span>
              ))}
              <span className="text-[12px] text-faint ml-1">Checked {ago(r.created_at)}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 border-b border-line">
          {Object.entries(r.stats).filter(([k]) => k !== "not_checked").map(([k, v], i) => (
            <motion.div key={k} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.05 }} className="min-w-0 px-4 sm:px-5 py-4 border-r border-t border-line -mt-px">
              <div className="text-[11px] uppercase tracking-[0.06em] text-faint whitespace-nowrap truncate">{statLabel(k)}</div>
              <div className="text-[20px] font-semibold tabular tracking-[-0.02em] mt-1">{statValue(k, v)}</div>
            </motion.div>
          ))}
        </div>
        {r.stats.not_checked ? (
          <div className="px-4 sm:px-6 pt-4 text-[12.5px] text-faint">Not checked: {String(r.stats.not_checked)}</div>
        ) : null}
        <div className="p-4 sm:p-6 space-y-6">
          {groups.map((g, gi) => (
            <div key={g.s}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2.5">
                <span className="text-[13px] font-semibold" style={{ color: SEV[g.s].color }}>
                  {SEV[g.s].label}
                </span>
                <span className="text-[12.5px] text-faint">{SEV[g.s].line}</span>
              </div>
              <div className="rounded-xl border border-line overflow-hidden">
                {g.items.map((f, i) => (
                  <motion.div key={f.title} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + gi * 0.12 + i * 0.05 }} className="group flex items-start gap-3 px-4 py-3 border-t border-line first:border-t-0 hover:bg-hover/60 transition-colors">
                    <span className="mt-[7px] size-2 rounded-full shrink-0" style={{ background: SEV[g.s].color, boxShadow: `0 0 8px ${SEV[g.s].color}` }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium">{f.title}</div>
                      <div className="text-[12.5px] text-muted mt-0.5 leading-snug">{f.detail}</div>
                    </div>
                    {f.url && (
                      <a href={f.url} target="_blank" rel="noreferrer" className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[12px] text-faint group-hover:text-accent">
                        Open <ExternalLink className="size-3" />
                      </a>
                    )}
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <ShareRow r={r} />
        <div className="px-4 sm:px-6 py-4 border-t border-line bg-sunken/50 flex items-center gap-3">
          <span className="text-[20px]">🦉</span>
          <div className="text-[13px] text-muted flex-1">A steward would turn the untracked promises into ledger entries and nudge owners before they slip.</div>
        </div>
      </Card>
    </motion.div>
  );
}

export function Checkup() {
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const [repo, setRepo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data: list } = useCheckups();
  const { data: current, isLoading } = useCheckup(id);
  const start = useMutation({
    mutationFn: (r: string) => api.startCheckup(r),
    onSuccess: (r) => {
      setErr(null);
      qc.setQueryData(qk.checkup(r.id), r);
      qc.invalidateQueries({ queryKey: qk.checkups });
      setParams({ id: r.id });
    },
    onError: (e) => setErr(errorLine(e)),
  });
  useEffect(() => {
    if (current?.status !== "running") qc.invalidateQueries({ queryKey: qk.checkups });
  }, [current?.status, qc]);

  const submit = () => {
    const v = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(v)) {
      setErr("Use the owner/repo form, like acme/payments-api.");
      return;
    }
    start.mutate(v);
  };

  return (
    <div>
      <Card className="overflow-hidden mb-6" glow="rgba(123,136,255,0.14)">
        <div className="px-5 pt-6 pb-6 sm:px-8 sm:pt-8 sm:pb-7">
          <div className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full border border-accent/30 bg-accent-soft text-accent text-[11.5px] font-medium">
            <Stethoscope className="size-3.5" /> Team checkup
          </div>
          <h1 className="mt-3 text-[24px] sm:text-[28px] font-semibold tracking-[-0.03em] leading-tight">How is your team really doing?</h1>
          <p className="mt-1.5 text-[14px] text-muted max-w-xl">Point Keel at a GitHub repo. In under a minute you'll see the promises nobody tracks, the reviews that wait, and what a steward would fix first. Read-only.</p>
          <form
            className="mt-5 flex flex-col sm:flex-row sm:items-center gap-2 max-w-xl"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="relative flex-1">
              <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-faint" />
              <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" className="h-11 pl-9 text-[14.5px] font-mono" aria-label="GitHub repository" />
            </div>
            <Button type="submit" variant="primary" size="lg" className="h-11" loading={start.isPending} icon={!start.isPending ? <ArrowRight className="size-4" /> : undefined}>
              Run checkup
            </Button>
          </form>
          {err && <ErrorLine error={err} className="mt-3 max-w-xl" />}
          {list && list.length > 0 && (
            <div className="mt-5 flex items-center gap-2 flex-wrap text-[12.5px]">
              <span className="text-faint">Recent</span>
              {list.filter((c, i) => list.findIndex((x) => x.repo === c.repo) === i).slice(0, 6).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setParams({ id: c.id })}
                  className={cn("inline-flex items-center gap-1.5 h-7 max-sm:h-10 max-sm:px-3 px-2.5 rounded-lg border font-mono text-[12px] cursor-pointer transition-colors", c.id === id ? "border-accent/50 bg-accent-soft text-fg" : "border-line bg-panel text-muted hover:text-fg hover:border-line-strong")}
                >
                  {c.status === "running" ? <Loader2 className="size-3 animate-spin text-accent" /> : c.status === "failed" ? <span className="size-1.5 rounded-full bg-bad" /> : <span className="font-sans font-bold text-[12px]" style={{ color: gradeColor(c.grade) }}>{c.grade}</span>}
                  {c.repo}
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>

      <AnimatePresence mode="wait">
        {id && isLoading ? (
          <Skeleton key="sk" className="h-[420px] rounded-xl" />
        ) : current ? (
          <motion.div key={current.id + current.status} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {current.status === "running" ? (
              <Running r={current} />
            ) : current.status === "failed" ? (
              <Card className="p-6">
                <div className="text-[13px] text-faint font-mono flex items-center gap-1.5 mb-2">
                  <GitBranch className="size-3.5" />
                  {current.repo}
                </div>
                <ErrorLine error={current.error_line ?? "Keel couldn't read that repo."} />
              </Card>
            ) : (
              <Report r={current} />
            )}
          </motion.div>
        ) : (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            {[
              { e: "🤝", t: "Untracked promises", l: "\"I'll take this\" in issues and PRs, with no date or owner." },
              { e: "⏳", t: "Waiting work", l: "Reviews and questions that sit for days." },
              { e: "🛡️", t: "Guard rails", l: "Branch rules, CI health, and who owns what." },
            ].map((x) => (
              <Card key={x.t} className="p-5">
                <div className="text-[22px]">{x.e}</div>
                <div className="text-[14px] font-semibold mt-2">{x.t}</div>
                <div className="text-[13px] text-muted mt-1">{x.l}</div>
              </Card>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
