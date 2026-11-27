import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Copy, Download, ExternalLink, GitBranch, Handshake, Loader2 } from "lucide-react";
import { errorLine } from "../api/client";
import { useMe, usePromiseScan } from "../api/hooks";
import type { FoundPromise, PromiseReport, PromiseStatus } from "../api/types";
import { Button, Card, CardHeader, ErrorLine, Input, Segmented, Select } from "../components/ui";
import { useToast } from "../components/toast";
import { copyText, downloadText, fileSlug, svgDataUrl } from "../lib/share";
import { cn } from "../lib/utils";

export const PROMISE_STATUS: Record<PromiseStatus, { label: string; color: string; line: string }> = {
  overdue: { label: "overdue", color: "var(--t-red)", line: "Still open past the date they gave." },
  quiet: { label: "gone quiet", color: "var(--t-amber)", line: "No date, no close, two weeks on." },
  open: { label: "open", color: "var(--t-blue)", line: "Still open, not late yet." },
  follow_up: { label: "follow-up", color: "var(--t-violet)", line: "Pushed to a later PR. Not counted." },
  dropped: { label: "dropped", color: "var(--t-gray)", line: "Closed as not planned." },
  kept: { label: "kept", color: "var(--t-green2)", line: "Closed as done after the promise." },
};
const ORDER: PromiseStatus[] = ["overdue", "quiet", "open", "follow_up", "dropped", "kept"];
const DAYS = [7, 30, 90];
const EXAMPLES = ["langchain-ai/deepagents", "astral-sh/uv", "vercel/next.js"];
const STEPS = ["Reading issue and PR comments", "Picking out the promises", "Checking which threads closed", "Adding it up"];

export function rateColor(rate: number | null) {
  if (rate === null) return "var(--faint)";
  if (rate >= 0.9) return "var(--t-green2)";
  if (rate >= 0.75) return "var(--t-green)";
  if (rate >= 0.6) return "var(--t-amber)";
  if (rate >= 0.4) return "var(--t-orange)";
  return "var(--t-red)";
}

function verdict(rate: number | null) {
  if (rate === null) return "Too few promises to call it yet.";
  if (rate >= 0.9) return "They say it, they ship it.";
  if (rate >= 0.75) return "Most promises land. A few drift.";
  if (rate >= 0.6) return "Better than a coin flip, but things slip.";
  if (rate >= 0.4) return "About half the promises land.";
  return "Most promises quietly slip away.";
}

function daysAgo(d: number) {
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  return `${Math.round(d)} days ago`;
}

export function took(days: number) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} h`;
  const n = Math.round(days * 10) / 10;
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function dueText(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function normalize(v: string) {
  return v.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
}

export function StatusPill({ status, className }: { status: PromiseStatus; className?: string }) {
  const m = PROMISE_STATUS[status];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[12px] font-medium border whitespace-nowrap", className)}
      style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 30%, transparent)`, background: `color-mix(in srgb, ${m.color} 10%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

function Running({ repo, startedAt }: { repo: string; startedAt: number }) {
  const [t, setT] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const iv = setInterval(() => setT(Date.now() - startedAt), 250);
    return () => clearInterval(iv);
  }, [startedAt]);
  const step = Math.min(STEPS.length - 1, Math.floor(t / 4500));
  const secs = Math.floor(t / 1000);
  return (
    <Card className="p-5 sm:p-7 overflow-hidden" glow="rgba(123,136,255,0.10)">
      <div className="text-[13px] text-faint font-mono flex items-center gap-1.5 min-w-0">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate">{repo}</span>
      </div>
      <div className="mt-2 flex items-center gap-2.5 text-[15px] sm:text-[16px] font-medium min-h-7" role="status" aria-live="polite">
        <Loader2 className="size-4 animate-spin text-accent shrink-0" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={step} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }}>
            {STEPS[step]}…
          </motion.span>
        </AnimatePresence>
        <span className="ml-auto text-[12.5px] text-faint tabular font-normal">{secs}s</span>
      </div>
      <div className="mt-4 h-1 rounded-full bg-sunken overflow-hidden">
        <motion.div className="h-full rounded-full bg-accent/70" initial={{ width: "4%" }} animate={{ width: "92%" }} transition={{ duration: 35, ease: [0.1, 0.6, 0.3, 1] }} />
      </div>
      <div className="mt-3 text-[12.5px] text-faint">This can take half a minute when a model reads the comments. Nothing is written to the repo.</div>
    </Card>
  );
}

function PromiseRow({ p, i }: { p: FoundPromise; i: number }) {
  const meta = [
    `@${p.who}`,
    `said ${daysAgo(p.age_days)}`,
    p.due && p.status !== "kept" ? `due ${dueText(p.due)}` : null,
    p.status === "kept" && p.days_to_keep !== null ? `kept in ${took(p.days_to_keep)}` : null,
  ].filter(Boolean);
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.035 }}
      className="group flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-3 px-4 py-3 border-t border-line first:border-t-0 hover:bg-hover/60 transition-colors"
    >
      <div className="sm:w-[104px] shrink-0 sm:pt-px">
        <StatusPill status={p.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[13.5px] font-medium min-w-0 break-words">{p.what}</span>
          <span className="text-[12px] text-faint font-mono shrink-0">
            {p.is_pr ? "PR #" : "#"}
            {p.number}
          </span>
        </div>
        <div className="text-[13px] text-muted italic mt-0.5 leading-snug break-words">“{p.quote}”</div>
        <div className="text-[12px] text-faint mt-1">{meta.join(" · ")}</div>
      </div>
      <a href={p.url} target="_blank" rel="noreferrer" className="shrink-0 sm:mt-0.5 inline-flex items-center gap-1 text-[12px] text-faint hover:text-accent group-hover:text-accent max-sm:h-8 self-start">
        Comment <ExternalLink className="size-3" />
      </a>
    </motion.div>
  );
}

function Highlights({ r }: { r: PromiseReport }) {
  const { oldest_unkept: old, fastest_kept: fast, top_promisers: top } = r.stats;
  if (!old && !fast && !top.length) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 border-b border-line">
      {old && (
        <div className="min-w-0 px-4 sm:px-6 py-4 border-line max-md:border-b md:border-r">
          <div className="text-[11px] uppercase tracking-[0.06em] text-faint">Oldest unkept</div>
          <a href={old.url} target="_blank" rel="noreferrer" className="block mt-1.5 text-[14px] italic leading-snug hover:text-accent break-words">“{old.quote}”</a>
          <div className="text-[12px] text-faint mt-1">@{old.who} · {Math.round(old.age_days)} days, no update</div>
        </div>
      )}
      {fast && (
        <div className="min-w-0 px-4 sm:px-6 py-4 border-line max-md:border-b md:border-r">
          <div className="text-[11px] uppercase tracking-[0.06em] text-faint">Fastest kept</div>
          <a href={fast.url} target="_blank" rel="noreferrer" className="block mt-1.5 text-[14px] font-medium leading-snug hover:text-accent break-words">{fast.what}</a>
          <div className="text-[12px] text-faint mt-1">@{fast.who} · done in {took(fast.days_to_keep ?? 0)}</div>
        </div>
      )}
      {top.length > 0 && (
        <div className="min-w-0 px-4 sm:px-6 py-4">
          <div className="text-[11px] uppercase tracking-[0.06em] text-faint">Most promises</div>
          <div className="mt-1.5 space-y-1">
            {top.map((x) => (
              <div key={x.who} className="flex items-center gap-2 text-[13px]">
                <span className="font-medium truncate">@{x.who}</span>
                <span className="ml-auto text-faint tabular whitespace-nowrap">
                  {x.kept} of {x.made} kept
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Report({ r }: { r: PromiseReport }) {
  const st = r.stats;
  const rate = st.kept_rate;
  const color = rateColor(rate);
  const [filter, setFilter] = useState<PromiseStatus | "all">("all");
  const sorted = useMemo(() => [...r.promises].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.age_days - a.age_days), [r.promises]);
  const shown = filter === "all" ? sorted : sorted.filter((p) => p.status === filter);
  const stats: [string, string, string?][] = [
    ["Kept", String(st.kept), st.kept ? PROMISE_STATUS.kept.color : undefined],
    ["Overdue", String(st.overdue), st.overdue ? PROMISE_STATUS.overdue.color : undefined],
    ["Gone quiet", String(st.quiet), st.quiet ? PROMISE_STATUS.quiet.color : undefined],
    ["Dropped", String(st.dropped)],
    ["Still open", String(st.open + st.follow_up)],
    ["Median to keep", st.median_days_to_keep === null ? "n/a" : took(st.median_days_to_keep)],
  ];
  return (
    <Card className="overflow-hidden">
      <div
        className="relative px-5 py-6 sm:px-8 sm:py-7 flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8 border-b border-line"
        style={{ backgroundImage: `radial-gradient(70% 140% at 0% 0%, color-mix(in srgb, ${color} 16%, transparent), transparent 60%)` }}
      >
        <div className="shrink-0 sm:min-w-[168px]">
          <motion.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 240, damping: 16, delay: 0.1 }}
            className="text-[64px] sm:text-[76px] leading-[0.9] font-bold tracking-[-0.05em] tabular origin-left"
            style={{ color }}
          >
            {rate === null ? "n/a" : `${Math.round(rate * 100)}%`}
          </motion.div>
          <div className="text-[13px] text-muted mt-2">{rate === null ? `${st.judged} judged so far` : "of promises kept"}</div>
        </div>
        <div className="min-w-0 flex-1">
          <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className="text-[13px] text-faint font-mono inline-flex items-center gap-1.5 hover:text-fg max-w-full">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate">{r.repo}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
          <div className="text-[20px] sm:text-[22px] font-semibold tracking-[-0.02em] mt-1 leading-tight">{verdict(rate)}</div>
          <div className="mt-2 text-[13px] text-muted">
            {st.promises} {st.promises === 1 ? "promise" : "promises"} in {r.scanned_comments} comments · last {r.days} days · {r.used_model ? "read by your model" : "matched by phrasing rules"}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 border-b border-line">
        {stats.map(([k, v, c], i) => (
          <motion.div key={k} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.05 }} className="min-w-0 px-4 sm:px-5 py-4 border-r border-t border-line -mt-px">
            <div className="text-[11px] uppercase tracking-[0.06em] text-faint whitespace-nowrap truncate">{k}</div>
            <div className="text-[20px] font-semibold tabular tracking-[-0.02em] mt-1" style={c ? { color: c } : undefined}>
              {v}
            </div>
          </motion.div>
        ))}
      </div>
      <Highlights r={r} />
      <div className="p-4 sm:p-6">
        {r.promises.length ? (
          <>
            <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <span className="text-[13px] font-semibold">Every promise</span>
              <div className="sm:ml-auto min-w-0">
                <Segmented
                  size="sm"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all" as const, label: "All", count: r.promises.length },
                    ...ORDER.filter((s) => st[s] > 0).map((s) => ({
                      value: s,
                      count: st[s],
                      label: (
                        <>
                          <span className="size-1.5 rounded-full" style={{ background: PROMISE_STATUS[s].color }} />
                          {PROMISE_STATUS[s].label.replace(/^\w/, (c) => c.toUpperCase())}
                        </>
                      ),
                    })),
                  ]}
                />
              </div>
            </div>
            {filter !== "all" && <div className="text-[12.5px] text-faint mb-2.5">{PROMISE_STATUS[filter].line}</div>}
            <div className="rounded-xl border border-line overflow-hidden">
              {shown.map((p, i) => (
                <PromiseRow key={p.url + p.said_at} p={p} i={i} />
              ))}
            </div>
          </>
        ) : (
          <div className="py-8 text-center">
            <div className="text-[28px]">🔍</div>
            <div className="text-[14px] font-semibold mt-2">No promises found</div>
            <div className="text-[13px] text-muted mt-1">Nobody said “I'll fix it” in the last {r.days} days. Try a longer window.</div>
          </div>
        )}
        <div className="mt-4 text-[12px] text-faint">
          Kept means the issue or PR closed as done after the promise. Follow-ups aren't counted.
          {r.not_checked.length > 0 && <> Not checked: {r.not_checked.join("; ")}.</>}
        </div>
      </div>
    </Card>
  );
}

function Share({ r }: { r: PromiseReport }) {
  const toast = useToast();
  const base = fileSlug(r.repo);
  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      toast({ title: `${what} copied`, icon: "📋" });
    } catch (e) {
      toast({ title: "Nothing was copied", line: errorLine(e), tone: "bad" });
    }
  };
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader title="Share it" sub="A badge for the README, a card for Slack or a post, and a summary for an issue." />
      <div className="px-4 sm:px-5 pb-5 grid grid-cols-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
        <img src={svgDataUrl(r.card_svg)} alt={`Share card: ${r.repo} kept ${r.stats.kept_rate === null ? "n/a" : `${Math.round(r.stats.kept_rate * 100)}%`} of promises`} className="w-full h-auto rounded-lg border border-line shadow-soft" />
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.06em] text-faint">README badge</div>
          <img src={svgDataUrl(r.badge_svg)} alt="promises kept badge" className="mt-2 h-5 w-auto" />
          <div className="mt-4 flex flex-col gap-2">
            <Button variant="primary" icon={<Download className="size-3.5" />} onClick={() => downloadText(`${base}-promises-card.svg`, r.card_svg)}>
              Download share card
            </Button>
            <Button icon={<Download className="size-3.5" />} onClick={() => downloadText(`${base}-promises-badge.svg`, r.badge_svg)}>
              Download badge.svg
            </Button>
            <Button icon={<Copy className="size-3.5" />} onClick={() => copy(`![promises kept](${base}-promises-badge.svg)`, "Badge Markdown")}>
              Copy badge Markdown
            </Button>
            <Button icon={<Copy className="size-3.5" />} onClick={() => copy(r.markdown, "Markdown summary")}>
              Copy Markdown summary
            </Button>
          </div>
          <div className="mt-3 text-[12px] text-faint leading-snug">Commit the badge next to your README, then paste the badge Markdown. The summary fits an issue or a PR comment.</div>
        </div>
      </div>
    </Card>
  );
}

export function Promises() {
  const [params, setParams] = useSearchParams();
  const { data: me } = useMe();
  const repoParam = params.get("repo");
  const daysParam = DAYS.includes(Number(params.get("days"))) ? Number(params.get("days")) : 30;
  const [repo, setRepo] = useState(repoParam ?? "");
  const [days, setDays] = useState(daysParam);
  const [err, setErr] = useState<string | null>(null);
  const scan = usePromiseScan(repoParam, daysParam);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  useEffect(() => {
    if (scan.isFetching) setStartedAt(Date.now());
  }, [scan.isFetching]);
  useEffect(() => {
    setRepo(repoParam ?? "");
    setDays(daysParam);
  }, [repoParam, daysParam]);

  const run = (value: string, d = days) => {
    const v = normalize(value);
    if (!/^[\w.-]+\/[\w.-]+$/.test(v)) {
      setErr("Use the owner/name form, like vercel/next.js.");
      return;
    }
    setErr(null);
    setRepo(v);
    setDays(d);
    if (v === repoParam && d === daysParam) void scan.refetch();
    else setParams({ repo: v, days: String(d) });
  };

  const examples = me?.demo ? ["acme/payments", ...EXAMPLES] : EXAMPLES;
  const error = err ?? (scan.error && !scan.isFetching ? errorLine(scan.error) : null);

  return (
    <div>
      <Card className="overflow-hidden mb-6" glow="rgba(123,136,255,0.14)">
        <div className="px-5 pt-6 pb-6 sm:px-8 sm:pt-8 sm:pb-7">
          <div className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full border border-accent/30 bg-accent-soft text-accent text-[11.5px] font-medium">
            <Handshake className="size-3.5" /> Promise check
          </div>
          <h1 className="mt-3 text-[24px] sm:text-[28px] font-semibold tracking-[-0.03em] leading-tight">“I'll send a PR by Friday.” Did they?</h1>
          <p className="mt-1.5 text-[14px] text-muted max-w-xl">Keel reads a repo's issue and PR comments, finds the promises people made, and checks which ones landed. Public repos need no token. Read-only.</p>
          <form
            className="mt-5 flex flex-col sm:flex-row sm:items-center gap-2 max-w-2xl"
            onSubmit={(e) => {
              e.preventDefault();
              run(repo);
            }}
          >
            <div className="relative flex-1 min-w-0">
              <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-faint" />
              <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" className="h-11 max-sm:h-11 pl-9 text-[14.5px] font-mono" aria-label="GitHub repository" />
            </div>
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How far back" className="h-11 max-sm:h-11 sm:w-[140px]">
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </Select>
            <Button type="submit" variant="primary" size="lg" className="h-11" loading={scan.isFetching} icon={!scan.isFetching ? <ArrowRight className="size-4" /> : undefined}>
              Check promises
            </Button>
          </form>
          {error && <ErrorLine error={error} className="mt-3 max-w-2xl" />}
          <div className="mt-5 flex items-center gap-2 flex-wrap text-[12.5px]">
            <span className="text-faint">Try</span>
            {examples.map((x) => (
              <button
                key={x}
                type="button"
                disabled={scan.isFetching}
                onClick={() => run(x)}
                className={cn(
                  "inline-flex items-center gap-1.5 h-7 max-sm:h-10 max-sm:px-3 px-2.5 rounded-lg border font-mono text-[12px] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default",
                  x === repoParam ? "border-accent/50 bg-accent-soft text-fg" : "border-line bg-panel text-muted hover:text-fg hover:border-line-strong",
                )}
              >
                {x}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <AnimatePresence mode="wait">
        {scan.isFetching && repoParam ? (
          <motion.div key="running" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Running repo={repoParam} startedAt={startedAt} />
          </motion.div>
        ) : scan.data ? (
          <motion.div key={`r-${scan.data.repo}-${scan.dataUpdatedAt}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>
            <Report r={scan.data} />
            <Share r={scan.data} />
          </motion.div>
        ) : (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            {[
              { e: "✅", t: "Kept", l: "The issue or PR closed as done after someone said they'd do it." },
              { e: "⏰", t: "Overdue", l: "They named a day. The day came and went." },
              { e: "🦗", t: "Gone quiet", l: "No date, no close, and two weeks of silence." },
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
