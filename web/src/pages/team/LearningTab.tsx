import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, MessageCircleQuestion, Sparkles } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { qk, useLearning } from "../../api/hooks";
import type { Gap, Label, LearningInfo, Lesson, LessonKind, TeamDetail } from "../../api/types";
import { Button, Card, CardHeader, EmptyState, ErrorLine, Input, Segmented, Select, Skeleton, Switch, Textarea } from "../../components/ui";
import { LabelBadge } from "../../components/keel";
import { useToast } from "../../components/toast";
import { ago } from "../../lib/time";
import { alpha, cn, plural } from "../../lib/utils";

const KIND_META: Record<LessonKind, { icon: string; label: string }> = {
  rule: { icon: "📏", label: "Rules" },
  reply: { icon: "✍️", label: "Replies" },
  triage: { icon: "🧭", label: "Triage" },
};

/** Where the lesson came from, in a few words. */
function origin(l: Lesson) {
  if (l.kind === "rule") return "Taught by";
  if (l.source.startsWith("commitment:")) return "Fixed in the ledger by";
  return l.after ? "Edited by" : "Rejected by";
}
const RULE_IDEAS = ["Keep replies to two sentences.", "Link the runbook instead of pasting it.", "Reply in the language the question was asked in."];
type KF = "all" | LessonKind;

const pct = (r: number | null) => (r == null ? "–" : `${Math.round(r * 100)}%`);

function Trend({ now, before }: { now: number | null; before: number | null }) {
  if (now == null || before == null) return <span className="text-faint">no earlier month to compare</span>;
  const d = Math.round((now - before) * 100);
  if (d === 0) return <span className="text-faint">same as the month before</span>;
  const Up = d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium", d > 0 ? "text-ok" : "text-warn")}>
      <Up className="size-3.5" />
      {Math.abs(d)} pts vs the month before
    </span>
  );
}

function Hero({ t, data }: { t: TeamDetail; data: LearningInfo }) {
  const s = data.stats;
  const cells = [
    { label: "Lessons in use", value: s.lessons_active, line: `${plural(s.rules, "rule")} you taught` },
    { label: "Used this week", value: s.used_this_week, line: "lessons that shaped a reply" },
    { label: "Open questions", value: s.open_questions, line: s.suggested_answers ? `${s.suggested_answers} with an answer to save` : s.open_questions ? "the notes didn't cover" : "none waiting", tone: s.suggested_answers ? "text-accent" : undefined },
    { label: "Sent without edits", value: pct(s.unedited_rate), line: <Trend now={s.unedited_rate} before={s.unedited_rate_before} /> },
  ];
  return (
    <Card className="relative overflow-hidden mb-4 lg:mb-5" glow={alpha(t.color, 0.12)}>
      <div className="flex flex-wrap items-center gap-3 px-4 sm:px-5 pt-4 sm:pt-5">
        <motion.span
          className="grid place-items-center size-9 rounded-xl text-[19px] border border-line"
          style={{ background: alpha(t.color, 0.14) }}
          animate={s.learned_this_week ? { rotate: [0, -8, 8, 0], scale: [1, 1.08, 1] } : undefined}
          transition={{ duration: 1.1, delay: 0.4 }}
        >
          🧠
        </motion.span>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-[-0.01em]">
            {s.learned_this_week ? `${t.steward.name} learned ${plural(s.learned_this_week, "thing")} this week` : `${t.steward.name} learns from your team`}
          </div>
          <div className="text-[12.5px] text-muted">Edits, rejections with a reason, fixes to the ledger and answers in threads all teach it. You can switch any lesson off.</div>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px mt-4 border-t border-line bg-line">
        {cells.map((c, i) => (
          <motion.div key={c.label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i }} className="bg-panel px-4 sm:px-5 py-3.5 min-w-0">
            <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint whitespace-nowrap">{c.label}</div>
            <div className={cn("text-[24px] font-semibold tracking-[-0.02em] tabular mt-0.5", c.tone)}>{c.value}</div>
            <div className="text-[12px] text-muted truncate">{c.line}</div>
          </motion.div>
        ))}
      </div>
    </Card>
  );
}

function TeachCard({ t }: { t: TeamDetail }) {
  const [rule, setRule] = useState("");
  const qc = useQueryClient();
  const toast = useToast();
  const teach = useMutation({
    mutationFn: (r: string) => api.teach(t.slug, r),
    onSuccess: (l) => {
      setRule("");
      qc.invalidateQueries({ queryKey: qk.learning(t.slug) });
      toast({ title: `${t.steward.name} will follow that from now on`, line: l.headline, icon: "🧠" });
    },
  });
  const submit = (r: string) => r.trim() && teach.mutate(r.trim());
  return (
    <Card className="p-4 sm:p-5 mb-4">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold">
        <Sparkles className="size-4" style={{ color: t.color }} />
        Teach {t.steward.name} a rule
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(rule);
        }}
      >
        <Input value={rule} onChange={(e) => setRule(e.target.value)} placeholder={`Tag @${t.slug}-oncall on anything urgent.`} aria-label="New rule" className="flex-1" />
        <Button type="submit" variant="primary" loading={teach.isPending} disabled={!rule.trim()}>
          Teach
        </Button>
      </form>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {RULE_IDEAS.map((r) => (
          <button key={r} type="button" onClick={() => setRule(r)} className="h-7 max-sm:h-9 px-2.5 rounded-full border border-line text-[12px] text-muted hover:text-fg hover:border-line-strong hover:bg-hover transition-colors cursor-pointer">
            {r}
          </button>
        ))}
      </div>
      <div className="mt-2.5 text-[12px] text-faint">Same as typing <code className="font-mono">/keel teach …</code> in Slack. Rules shape replies when a model is connected.</div>
      {teach.error && <ErrorLine error={errorLine(teach.error)} className="mt-3" />}
    </Card>
  );
}

function Diff({ l }: { l: Lesson }) {
  return (
    <div className="mt-2.5 space-y-2 text-[12.5px]">
      {l.situation && (
        <div className="text-muted">
          <span className="text-faint">When: </span>“{l.situation}”
        </div>
      )}
      {(l.before || l.after) && (
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 items-stretch">
          <div className="rounded-lg border border-bad/20 bg-bad/6 px-3 py-2 text-fg/80 whitespace-pre-wrap break-words">
            <div className="text-[10.5px] uppercase tracking-[0.07em] text-bad/80 mb-1">{l.kind === "reply" ? "It wrote" : "It did"}</div>
            {l.before || "–"}
          </div>
          <ArrowRight className="size-4 self-center justify-self-center text-faint max-sm:rotate-90" />
          <div className="rounded-lg border border-ok/25 bg-ok/8 px-3 py-2 whitespace-pre-wrap break-words">
            <div className="text-[10.5px] uppercase tracking-[0.07em] text-ok mb-1">{l.after ? "Should be" : "Rejected"}</div>
            {l.after || "Not sent."}
          </div>
        </div>
      )}
      {l.note && l.kind !== "rule" && (
        <div className="text-muted">
          <span className="text-faint">Why: </span>
          {l.note}
        </div>
      )}
    </div>
  );
}

function LessonRow({ l, t, i }: { l: Lesson; t: TeamDetail; i: number }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: (active: boolean) => api.setLessonActive(l.id, active),
    onSuccess: (r) => {
      qc.setQueryData<LearningInfo>(qk.learning(t.slug), (d) => d && { ...d, lessons: d.lessons.map((x) => (x.id === r.id ? r : x)) });
      qc.invalidateQueries({ queryKey: qk.learning(t.slug) });
    },
    onError: (e) => toast({ title: "Lesson not changed", line: errorLine(e), tone: "bad" }),
  });
  const active = toggle.isPending ? !!toggle.variables : l.active;
  const meta = KIND_META[l.kind];
  const expandable = l.kind !== "rule";
  return (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }} className={cn("px-4 sm:px-5 py-3.5 border-b border-line last:border-b-0 transition-opacity", !active && "opacity-55")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid place-items-center size-8 rounded-lg bg-sunken border border-line shrink-0 text-[15px]" aria-hidden>
          {meta.icon}
        </span>
        <button type="button" disabled={!expandable} onClick={() => setOpen((o) => !o)} className={cn("min-w-0 flex-1 text-left", expandable && "cursor-pointer")} aria-expanded={expandable ? open : undefined}>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium">{l.headline}</span>
            {l.label !== "public" && l.label !== "internal" && <LabelBadge label={l.label} className="shrink-0" />}
          </div>
          <div className="text-[11.5px] text-faint mt-1 flex flex-wrap items-center gap-x-1.5">
            <span>
              {origin(l)} {l.author || "someone"} · {ago(l.created_at)}
            </span>
            <span>· {l.uses ? `used ${l.uses}×${l.last_used_at ? `, last ${ago(l.last_used_at)}` : ""}` : "not used yet"}</span>
            {expandable && <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />}
          </div>
        </button>
        <Switch checked={active} onChange={(v) => toggle.mutate(v)} label={active ? "Switch this lesson off" : "Switch this lesson on"} color={t.color} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pl-11">
            <Diff l={l} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Lessons({ t, lessons }: { t: TeamDetail; lessons: Lesson[] }) {
  const [kf, setKf] = useState<KF>("all");
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: lessons.length };
    for (const l of lessons) m[l.kind] = (m[l.kind] ?? 0) + 1;
    return m;
  }, [lessons]);
  const shown = lessons.filter((l) => kf === "all" || l.kind === kf);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="What it learned"
        sub="The closest few are added to each reply and triage. Off means ignored."
        right={<Segmented size="sm" value={kf} onChange={setKf} options={(["all", "rule", "reply", "triage"] as KF[]).map((v) => ({ value: v, label: v === "all" ? "All" : KIND_META[v].label, count: counts[v] ?? 0 }))} />}
      />
      {!shown.length ? (
        <EmptyState icon="🌱" title={lessons.length ? "Nothing of this kind" : "Nothing learned yet"} line={lessons.length ? "Try another filter." : `Edit a draft, reject one with a reason or teach a rule, and ${t.steward.name} keeps it here.`} />
      ) : (
        <div className="border-t border-line">
          {shown.map((l, i) => (
            <LessonRow key={l.id} l={l} t={t} i={i} />
          ))}
        </div>
      )}
    </Card>
  );
}

function GapRow({ g, t }: { g: Gap; t: TeamDetail }) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState(g.suggested_answer ?? "");
  const [label, setLabel] = useState<Label>("internal");
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ["learning", "knowledge", "audit"].includes(q.queryKey[0] as string) });
  const fill = useMutation({
    mutationFn: () => api.fillGap(g.id, { content: text.trim() || undefined, label }),
    onSuccess: ({ doc }) => {
      refresh();
      toast({ title: `${t.steward.name} learned it`, line: `Saved to knowledge as “${doc.title}”.`, icon: "📚" });
    },
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissGap(g.id),
    onSuccess: () => {
      refresh();
      toast({ title: "Question closed", line: "It won't show up here again.", icon: "🗑️" });
    },
  });
  const suggested = g.status === "suggested" && !!g.suggested_answer;
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} className="px-4 sm:px-5 py-4 border-b border-line last:border-b-0">
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion className={cn("size-4 mt-0.5 shrink-0", suggested ? "text-accent" : "text-faint")} />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{g.question}</div>
          <div className="text-[11.5px] text-faint mt-0.5">
            {g.count > 1 ? <b className="text-warn font-semibold">Asked {g.count}×</b> : "Asked once"}
            {g.asked_by && ` · first by ${g.asked_by}`} · {ago(g.last_asked_at)}
          </div>
        </div>
      </div>
      {suggested && !answering && (
        <div className="mt-2.5 ml-6.5 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2 text-[12.5px]">
          <div className="text-[10.5px] uppercase tracking-[0.07em] text-accent mb-1">{g.suggested_by ?? "Someone"} answered in the thread</div>
          <div className="whitespace-pre-wrap break-words">{g.suggested_answer}</div>
        </div>
      )}
      <AnimatePresence initial={false}>
        {answering && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-2.5 ml-6.5 space-y-2">
              <Textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="The answer, as you'd tell a new teammate." aria-label="Answer" />
              <div className="flex items-center gap-2">
                <Select value={label} onChange={(e) => setLabel(e.target.value as Label)} aria-label="Label" className="h-8 w-[150px] text-[12.5px]">
                  <option value="public">Public</option>
                  <option value="internal">Internal</option>
                  <option value="confidential">Confidential</option>
                  <option value="restricted">Restricted</option>
                </Select>
                <span className="text-[11.5px] text-faint">Who may hear it</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-3 ml-6.5 flex flex-wrap items-center gap-2">
        {answering ? (
          <>
            <Button size="sm" variant="primary" icon={<BookOpen className="size-3.5" />} loading={fill.isPending} disabled={!text.trim()} onClick={() => fill.mutate()}>
              Save to knowledge
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAnswering(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {suggested ? (
              <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={fill.isPending} onClick={() => fill.mutate()}>
                Save to knowledge
              </Button>
            ) : null}
            <Button size="sm" variant={suggested ? "ghost" : "secondary"} onClick={() => setAnswering(true)}>
              {suggested ? "Edit first" : "Answer it"}
            </Button>
            <Button size="sm" variant="ghost" loading={dismiss.isPending} onClick={() => dismiss.mutate()} className="ml-auto">
              Dismiss
            </Button>
          </>
        )}
      </div>
      {(fill.error || dismiss.error) && <ErrorLine error={errorLine(fill.error ?? dismiss.error)} className="mt-2.5 ml-6.5" />}
    </motion.div>
  );
}

function Questions({ t, data }: { t: TeamDetail; data: LearningInfo }) {
  const open = data.gaps.filter((g) => g.status === "open" || g.status === "suggested");
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Open questions" sub={`Asked of ${t.steward.name}, not in the notes yet. Answer once and it knows.`} />
      {!open.length ? (
        <EmptyState icon="✨" title="No open questions" line={data.stats.filled_total ? `${plural(data.stats.filled_total, "answer")} saved to knowledge so far.` : `When ${t.steward.name} can't answer from the notes, the question lands here.`} />
      ) : (
        <div className="border-t border-line">
          <AnimatePresence initial={false}>
            {open.map((g) => (
              <GapRow key={g.id} g={g} t={t} />
            ))}
          </AnimatePresence>
          {data.stats.filled_total > 0 && <div className="px-4 sm:px-5 py-2.5 text-[12px] text-faint border-t border-line">{plural(data.stats.filled_total, "answer")} saved to knowledge so far.</div>}
        </div>
      )}
    </Card>
  );
}

export function LearningTab({ t }: { t: TeamDetail }) {
  const { data, error } = useLearning(t.slug);
  if (error) return <ErrorLine error={errorLine(error)} />;
  if (!data)
    return (
      <div className="space-y-4">
        <Skeleton className="h-[150px] rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5">
          <Skeleton className="lg:col-span-7 h-[420px] rounded-xl" />
          <Skeleton className="lg:col-span-5 h-[420px] rounded-xl" />
        </div>
      </div>
    );
  return (
    <div>
      <Hero t={t} data={data} />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5 items-start">
        <div className="lg:col-span-7 min-w-0">
          <TeachCard t={t} />
          <Lessons t={t} lessons={data.lessons} />
        </div>
        <div className="lg:col-span-5 min-w-0 max-lg:order-first">
          <Questions t={t} data={data} />
        </div>
      </div>
    </div>
  );
}
