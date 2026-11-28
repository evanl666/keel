import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Pencil, Users, Info, ArrowUpRight } from "lucide-react";
import { api, errorLine } from "../api/client";
import { useApprovals } from "../api/hooks";
import type { Approval } from "../api/types";
import { Badge, Button, buttonClass, Card, EmptyState, Input, Kbd, PageHeader, SkeletonRows, Textarea } from "../components/ui";
import { LabelBadge, Markdown, StewardAvatar, useTeamMap } from "../components/keel";
import { useHotkeys } from "../components/Layout";
import { useToast } from "../components/toast";
import { ago } from "../lib/time";
import { cn } from "../lib/utils";

const KIND_LABEL: Record<string, string> = {
  "slack.post": "Slack post",
  "github.create_issue": "GitHub issue",
  "github.comment": "GitHub comment",
  "runbook.run": "Runbook",
};

type Decision = { id: string; dir: 1 | -1 };

const REJECT_REASONS = ["Not needed", "Wrong team", "Too long", "Wrong tone", "Not work"];

const exitVariants = {
  exit: (dir: number) => ({ opacity: 0, x: dir * 24, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as const } }),
};

export function Approvals() {
  const { data, isLoading } = useApprovals();
  const teams = useTeamMap();
  const qc = useQueryClient();
  const toast = useToast();
  const [teamFilter, setTeamFilter] = useState<string>("");
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [gone, setGone] = useState<Decision[]>([]);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const visible = useMemo(
    () => (data ?? []).filter((a) => !gone.some((g) => g.id === a.id) && (!teamFilter || a.team_slug === teamFilter)),
    [data, gone, teamFilter],
  );
  const current = visible[Math.min(sel, visible.length - 1)];

  useEffect(() => {
    if (current) cardRefs.current[current.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current]);

  const decide = useMutation({
    mutationFn: async ({ a, approve, reason }: { a: Approval; approve: boolean; reason?: string }) => {
      const edited = drafts[a.id];
      return approve ? api.approve(a.id, edited !== undefined && edited !== a.preview ? edited : undefined) : api.reject(a.id, reason?.trim() || undefined);
    },
    onMutate: ({ a, approve }) => {
      setGone((g) => [...g, { id: a.id, dir: approve ? 1 : -1 }]);
      setEditing(null);
      setRejecting(null);
    },
    onSuccess: (res, { a, approve, reason }) => {
      const name = teams[a.team_slug]?.steward.name ?? "The steward";
      const edited = drafts[a.id] !== undefined && drafts[a.id] !== a.preview;
      toast({
        title: approve ? `Approved: ${a.title}` : `Rejected: ${a.title}`,
        line: approve
          ? edited
            ? `${name} is sending your version and will write it that way next time.`
            : `${name} is sending it now.`
          : reason?.trim()
            ? `${name} won't send it, and learned why: ${reason.trim()}.`
            : `${name} won't send it.`,
        icon: approve ? "👍" : "✋",
      });
      void res;
    },
    onError: (e, { a }) => {
      setGone((g) => g.filter((x) => x.id !== a.id));
      toast({ title: `"${a.title}" is still waiting`, line: errorLine(e), tone: "bad" });
    },
    onSettled: () => {
      qc.invalidateQueries({ predicate: (q) => ["approvals", "overview", "teams", "team", "operations", "audit"].includes(q.queryKey[0] as string) });
    },
  });

  useEffect(() => {
    if (data) setGone((g) => g.filter((x) => data.some((a) => a.id === x.id)));
  }, [data]);

  useHotkeys(
    {
      a: () => current && decide.mutate({ a: current, approve: true }),
      r: () => current && setRejecting(current.id),
      e: () => current && setEditing(current.id),
      j: () => setSel((s) => Math.min(visible.length - 1, s + 1)),
      k: () => setSel((s) => Math.max(0, s - 1)),
      arrowdown: () => setSel((s) => Math.min(visible.length - 1, s + 1)),
      arrowup: () => setSel((s) => Math.max(0, s - 1)),
    },
    !!current,
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of data ?? []) if (!gone.some((g) => g.id === a.id)) m[a.team_slug] = (m[a.team_slug] ?? 0) + 1;
    return m;
  }, [data, gone]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader
        title="Approvals"
        sub={data ? (total ? `${total} ${total === 1 ? "thing waits" : "things wait"} for a human. Nothing goes out until you say so.` : "Nothing waits for you.") : "Loading…"}
        right={
          <div className="flex items-center gap-3 text-[12px] text-muted touch:hidden max-lg:hidden">
            <span className="flex items-center gap-1.5"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
            <span className="flex items-center gap-1.5"><Kbd>E</Kbd> edit</span>
            <span className="flex items-center gap-1.5"><Kbd>R</Kbd> reject</span>
            <span className="flex items-center gap-1.5"><Kbd>A</Kbd> approve</span>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6">
        <div className="lg:col-span-8 min-w-0">
          {isLoading ? (
            <SkeletonRows rows={3} className="[&>*]:h-56" />
          ) : !visible.length ? (
            <Card>
              <EmptyState
                title={teamFilter ? "Nothing from this team" : "Inbox zero"}
                line={teamFilter ? "Its steward doesn't need anything from you." : "Your stewards don't need anything from you right now. They'll ask here when they do."}
                action={
                  <Link to="/ledger" className={buttonClass()}>
                    Open the ledger
                  </Link>
                }
              />
            </Card>
          ) : (
            <div className="space-y-4">
              <AnimatePresence mode="popLayout" initial={false} custom={gone.length ? gone[gone.length - 1].dir : 1}>
                {visible.map((a, i) => {
                  const t = teams[a.team_slug];
                  const color = t?.color ?? "#888";
                  const active = current?.id === a.id;
                  const isEditing = editing === a.id;
                  const preview = drafts[a.id] ?? a.preview;
                  const isCode = a.kind === "runbook.run";
                  return (
                    <motion.div
                      key={a.id}
                      layout
                      ref={(el) => {
                        cardRefs.current[a.id] = el;
                      }}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0, x: 0 }}
                      variants={exitVariants}
                      exit="exit"
                      transition={{ duration: 0.18 }}
                      onClick={() => setSel(i)}
                    >
                      <Card
                        className={cn("overflow-hidden transition-colors duration-150", active ? "border-fg/35" : "")}
                      >
                        <div className="flex items-center gap-2.5 px-4 sm:px-5 pt-4">
                          {t && <StewardAvatar emoji={t.steward.emoji} color={color} size="sm" paused={t.steward.paused} />}
                          <div className="min-w-0 truncate text-[12px]">
                            <span className="font-medium">{t?.steward.name}</span>
                            <span className="text-muted"><span className="max-sm:hidden"> · {t?.name}</span> · {ago(a.created_at)}</span>
                          </div>
                          <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            <Badge className="max-sm:hidden">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                            <LabelBadge label={a.label} />
                          </div>
                        </div>
                        <div className="px-4 sm:px-5 pt-3">
                          <div className="text-[16px] font-semibold tracking-[-0.01em] max-sm:leading-snug">{a.title}</div>
                          <div className="mt-1.5 flex items-start gap-1.5 text-[14px] text-muted">
                            <Info className="size-3.5 mt-[3px] shrink-0 text-muted" />
                            {a.reason}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[14px] text-muted">
                            <Users className="size-3.5 shrink-0 text-muted" />
                            <span>
                              Goes to <span className="text-fg font-medium">{a.audience}</span>
                            </span>
                            {a.commitment_key && (
                              <Link to={`/commitments/${a.commitment_key}`} className="ml-1 inline-flex items-center gap-0.5 font-mono text-[12px] text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                                {a.commitment_key}
                                <ArrowUpRight className="size-3" />
                              </Link>
                            )}
                          </div>
                        </div>
                        <div className="mx-4 sm:mx-5 mt-4 min-w-0 rounded-lg border border-line bg-sunken transition-colors focus-within:border-fg/40">
                          <div className="flex items-center justify-between gap-3 px-3.5 h-8 border-b border-line text-[12px] text-muted">
                            <span className="truncate">{isEditing ? "Editing. Your version is what gets sent." : "Exactly what will be sent"}</span>
                            {drafts[a.id] !== undefined && drafts[a.id] !== a.preview && !isEditing && <span className="shrink-0 text-accent">Edited</span>}
                          </div>
                          {isEditing ? (
                            <Textarea
                              autoFocus
                              value={preview}
                              onChange={(e) => setDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") setEditing(null);
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) decide.mutate({ a, approve: true });
                              }}
                              rows={Math.min(14, preview.split("\n").length + 2)}
                              className="border-0! rounded-none! rounded-b-lg! bg-transparent! ring-0! focus:ring-0! focus:bg-transparent! px-4! font-mono text-[12px]"
                            />
                          ) : isCode ? (
                            <pre className="px-3.5 py-3 font-mono text-[12px] leading-relaxed text-fg/90 whitespace-pre-wrap break-words">{preview}</pre>
                          ) : (
                            <div className="px-3.5 py-3">
                              <Markdown compact>{preview}</Markdown>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-4">
                          {isEditing ? (
                            <>
                              <Button size="md" variant="ghost" onClick={(e) => { e.stopPropagation(); setDrafts((d) => { const n = { ...d }; delete n[a.id]; return n; }); setEditing(null); }}>
                                Discard edits
                              </Button>
                              <Button size="md" variant="secondary" onClick={(e) => { e.stopPropagation(); setEditing(null); }}>
                                Done editing
                              </Button>
                            </>
                          ) : (
                            <Button size="md" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={(e) => { e.stopPropagation(); setSel(i); setEditing(a.id); }} kbd={active ? "E" : undefined}>
                              Edit
                            </Button>
                          )}
                          <div className="ml-auto flex flex-wrap justify-end items-center gap-2">
                            <Button variant="danger" icon={<X className="size-3.5" />} kbd={active ? "R" : undefined} onClick={(e) => { e.stopPropagation(); setSel(i); setRejecting(rejecting === a.id ? null : a.id); }}>
                              Reject
                            </Button>
                            <Button variant="success" icon={<Check className="size-3.5" />} kbd={active ? "A" : undefined} onClick={(e) => { e.stopPropagation(); decide.mutate({ a, approve: true }); }}>
                              {drafts[a.id] !== undefined && drafts[a.id] !== a.preview ? "Approve edited" : "Approve"}
                            </Button>
                          </div>
                        </div>
                        <AnimatePresence initial={false}>
                          {rejecting === a.id && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden" onClick={(e) => e.stopPropagation()}>
                              <form
                                className="border-t border-line px-4 sm:px-5 py-3.5"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  decide.mutate({ a, approve: false, reason: reasons[a.id] });
                                }}
                              >
                                <div className="text-[12px] text-muted">
                                  Why not? <span className="text-muted">{t?.steward.name ?? "The steward"} learns from the reason. Leave it empty to just reject.</span>
                                </div>
                                <div className="mt-2 flex gap-2">
                                  <Input
                                    autoFocus
                                    value={reasons[a.id] ?? ""}
                                    onChange={(e) => setReasons((r) => ({ ...r, [a.id]: e.target.value }))}
                                    onKeyDown={(e) => e.key === "Escape" && setRejecting(null)}
                                    placeholder="Payments doesn't own refunds, Billing does."
                                    aria-label="Why reject"
                                    className="flex-1"
                                  />
                                  <Button type="submit" variant="danger" icon={<X className="size-3.5" />}>
                                    Reject
                                  </Button>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {REJECT_REASONS.map((r) => (
                                    <button key={r} type="button" onClick={() => setReasons((x) => ({ ...x, [a.id]: r }))} className="h-7 max-sm:h-9 px-2.5 rounded-md bg-hover text-[12px] text-soft hover:text-fg transition-colors cursor-pointer">
                                      {r}
                                    </button>
                                  ))}
                                </div>
                              </form>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </Card>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>

        <aside className="contents lg:block lg:col-span-4 lg:space-y-4">
          <Card className="p-2 max-lg:order-first max-lg:flex max-lg:gap-1 max-lg:scroll-x">
            <button
              onClick={() => setTeamFilter("")}
              className={cn("w-full max-lg:w-auto max-lg:shrink-0 whitespace-nowrap flex items-center gap-2.5 h-10 lg:h-9 px-2.5 max-lg:px-3 rounded-lg text-[14px] cursor-pointer transition-colors", !teamFilter ? "bg-hover text-fg" : "text-muted hover:bg-hover")}
            >
              <span className="flex-1 text-left font-medium">All teams</span>
              <span className="tabular text-muted">{total}</span>
            </button>
            {Object.values(teams).map((t) => (
              <button
                key={t.slug}
                onClick={() => {
                  setTeamFilter(t.slug === teamFilter ? "" : t.slug);
                  setSel(0);
                }}
                className={cn("w-full max-lg:w-auto max-lg:shrink-0 whitespace-nowrap flex items-center gap-2.5 h-10 lg:h-9 px-2.5 max-lg:px-3 rounded-lg text-[14px] cursor-pointer transition-colors", teamFilter === t.slug ? "bg-hover text-fg" : "text-muted hover:bg-hover")}
              >
                <span className="text-[16px] leading-none">{t.steward.emoji}</span>
                <span className="flex-1 text-left">
                  {t.steward.name} <span className="text-muted max-sm:hidden">· {t.name}</span>
                </span>
                <span className="tabular text-muted">{counts[t.slug] ?? 0}</span>
              </button>
            ))}
          </Card>
          <Card className="p-4 sm:p-5">
            <div className="text-[14px] font-semibold">Why stewards ask</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              Each steward works at a level. Anything above it, or anything labeled confidential going somewhere new, waits here. Approving drafts unchanged helps a steward earn the next level.
            </p>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">
              Edits are sent exactly as you write them. Rejected drafts are never sent.
            </p>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">
              Your edits and reasons teach the steward. See what it learned on each team's Learning tab.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
