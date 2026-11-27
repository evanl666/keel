import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Search, LayoutGrid, Inbox, ListChecks, Send, Activity, Stethoscope, Handshake, Gift, ScrollText, Settings, Sun, Sparkles, Play, CornerDownLeft, Pause } from "lucide-react";
import { api, errorLine } from "../api/client";
import { useCommitments, useMe, useTeams } from "../api/hooks";
import { toggleTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { Kbd } from "./ui";
import { StatusIcon } from "./keel";
import { useToast } from "./toast";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: teams = [] } = useTeams();
  const { data: commitments = [] } = useCommitments();
  const { data: me } = useMe();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => nav(to);
    const pages: Item[] = [
      { id: "p-o", group: "Pages", label: "Overview", hint: "G O", icon: <LayoutGrid />, run: go("/") },
      { id: "p-a", group: "Pages", label: "Approvals", hint: "G A", keywords: "inbox drafts", icon: <Inbox />, run: go("/approvals") },
      { id: "p-l", group: "Pages", label: "Ledger", hint: "G L", keywords: "commitments promises", icon: <ListChecks />, run: go("/ledger") },
      { id: "p-p", group: "Pages", label: "Outbox", hint: "G P", keywords: "operations needs review", icon: <Send />, run: go("/operations") },
      { id: "p-s", group: "Pages", label: "Services", hint: "G S", keywords: "health incidents runbooks", icon: <Activity />, run: go("/services") },
      { id: "p-c", group: "Pages", label: "Team checkup", hint: "G C", keywords: "repo grade report", icon: <Stethoscope />, run: go("/checkup") },
      { id: "p-pr", group: "Pages", label: "Promise check", keywords: "promises kept github repo comments badge archaeology", icon: <Handshake />, run: go("/promises") },
      { id: "p-u", group: "Pages", label: "Audit log", keywords: "history who", icon: <ScrollText />, run: go("/audit") },
      { id: "p-setup", group: "Pages", label: "Setup", keywords: "slack github model", icon: <Settings />, run: go("/setup") },
    ];
    const teamItems: Item[] = teams.map((t) => ({
      id: `t-${t.slug}`,
      group: "Teams",
      label: `${t.name}`,
      hint: `${t.steward.name} · L${t.steward.level}`,
      keywords: `${t.steward.name} team`,
      icon: <span className="text-[15px] leading-none">{t.steward.emoji}</span>,
      run: go(`/teams/${t.slug}`),
    }));
    const actions: Item[] = [
      ...teams.map((t) => ({
        id: `a-brief-${t.slug}`,
        group: "Actions",
        label: `Generate daily brief for ${t.name}`,
        keywords: `${t.steward.name} brief today`,
        icon: <Sparkles />,
        run: async () => {
          try {
            await api.createBrief(t.slug, "daily");
            qc.invalidateQueries();
            toast({ title: `${t.steward.name} wrote a fresh brief`, line: `${t.name} · Today tab`, icon: t.steward.emoji });
            nav(`/teams/${t.slug}`);
          } catch (e) {
            toast({ title: "The brief wasn't created", line: errorLine(e), tone: "bad" });
          }
        },
      })),
      ...teams.map((t) => ({
        id: `a-pause-${t.slug}`,
        group: "Actions",
        label: `${t.steward.paused ? "Resume" : "Pause"} ${t.steward.name}`,
        keywords: `${t.name} pause stop resume`,
        icon: t.steward.paused ? <Play /> : <Pause />,
        run: async () => {
          try {
            await api.patchSteward(t.slug, { paused: !t.steward.paused });
            qc.invalidateQueries();
            toast({ title: t.steward.paused ? `${t.steward.name} is working again` : `${t.steward.name} is paused`, line: t.steward.paused ? undefined : "It watches but sends nothing.", icon: t.steward.emoji });
          } catch (e) {
            toast({ title: "Nothing changed", line: errorLine(e), tone: "bad" });
          }
        },
      })),
      ...teams.map((t) => ({
        id: `a-wrapped-${t.slug}`,
        group: "Actions",
        label: `Open ${t.name} Wrapped`,
        keywords: `${t.steward.name} month recap year review share card`,
        icon: <Gift />,
        run: go(`/teams/${t.slug}?wrapped=1`),
      })),
      { id: "a-theme", group: "Actions", label: "Toggle light / dark", keywords: "theme dark light mode", icon: <Sun />, run: toggleTheme },
      ...(me?.demo
        ? [
            {
              id: "a-tick",
              group: "Actions",
              label: "Play next demo event",
              keywords: "demo tick",
              icon: <Play />,
              run: async () => {
                const r = await api.demoTick();
                qc.invalidateQueries();
                toast(r.event ? { title: r.event.text, icon: r.event.icon } : { title: "That was the last scripted event", tone: "info" });
              },
            },
          ]
        : []),
    ];
    const cms: Item[] = commitments.map((c) => ({
      id: `c-${c.key}`,
      group: "Commitments",
      label: c.title,
      hint: c.key,
      keywords: `${c.key} ${c.owner_team} ${c.owner_person ?? ""}`,
      icon: <StatusIcon status={c.status} />,
      run: go(`/commitments/${c.key}`),
    }));
    return [...pages, ...teamItems, ...actions, ...cms];
  }, [teams, commitments, me?.demo, nav, qc, toast]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.filter((i) => i.group !== "Commitments" || i.hint === "C-88" || i.hint === "C-85" || i.hint === "C-83").slice(0, 40);
    const terms = s.split(/\s+/);
    return items
      .map((i) => {
        const hay = `${i.label} ${i.hint ?? ""} ${i.keywords ?? ""} ${i.group}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return null;
        const score = (i.label.toLowerCase().startsWith(s) ? 3 : 0) + ((i.hint ?? "").toLowerCase() === s ? 5 : 0) + (i.group === "Pages" ? 1 : 0);
        return { i, score };
      })
      .filter((x): x is { i: Item; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.i)
      .slice(0, 40);
  }, [items, q]);

  const grouped = useMemo(() => {
    const order = ["Pages", "Teams", "Commitments", "Actions"];
    const g = new Map<string, Item[]>();
    for (const it of filtered) g.set(it.group, [...(g.get(it.group) ?? []), it]);
    const flat: Item[] = [];
    const out = order.filter((k) => g.has(k)).map((k) => {
      const list = g.get(k)!;
      flat.push(...list);
      return [k, list] as const;
    });
    return { out, flat };
  }, [filtered]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    void it.run();
  };

  let n = -1;
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[90] flex items-start justify-center pt-3 px-3 sm:pt-[12vh] sm:px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ type: "spring", stiffness: 500, damping: 36 }}
            className="relative w-full max-w-[620px] overflow-hidden rounded-2xl border border-line-strong bg-panel/95 backdrop-blur-2xl shadow-pop"
            role="dialog"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-3 px-4 h-[52px] border-b border-line">
              <Search className="size-4 text-faint" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Jump to a team, a commitment like C-88, or an action…"
                className="min-w-0 flex-1 bg-transparent outline-none text-[14.5px] max-sm:text-[16px] placeholder:text-faint"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setIdx((i) => Math.min(grouped.flat.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setIdx((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    run(grouped.flat[idx]);
                  } else if (e.key === "Escape") onClose();
                }}
              />
              <Kbd className="touch:hidden">esc</Kbd>
              <button onClick={onClose} className="hidden touch:block -mr-2 h-10 px-2 rounded-lg text-[13px] font-medium text-muted hover:text-fg cursor-pointer">
                Cancel
              </button>
            </div>
            <div ref={listRef} className="max-h-[min(60dvh,calc(100dvh-8rem))] sm:max-h-[52vh] overflow-y-auto overscroll-contain p-2">
              {grouped.flat.length === 0 && <div className="py-10 text-center text-[13px] text-faint">Nothing matches "{q}".</div>}
              {grouped.out.map(([g, list]) => (
                <div key={g} className="mb-1">
                  <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium uppercase tracking-[0.07em] text-faint">{g}</div>
                  {list.map((it) => {
                    n += 1;
                    const i = n;
                    const active = i === idx;
                    return (
                      <button
                        key={it.id}
                        data-idx={i}
                        onMouseMove={() => setIdx(i)}
                        onClick={() => run(it)}
                        className={cn("relative w-full flex items-center gap-3 h-10 px-2.5 rounded-lg text-left cursor-pointer", active ? "text-fg" : "text-muted")}
                      >
                        {active && <motion.span layoutId="cmdk-active" className="absolute inset-0 rounded-lg bg-hover border border-line" transition={{ type: "spring", stiffness: 700, damping: 45 }} />}
                        <span className="relative grid size-5 place-items-center text-faint [&>svg]:size-4">{it.icon}</span>
                        <span className="relative flex-1 truncate text-[13.5px]">{it.label}</span>
                        {it.hint && <span className="relative shrink-0 text-[12px] text-faint font-mono">{it.hint}</span>}
                        {active && <CornerDownLeft className="relative shrink-0 size-3.5 text-faint touch:hidden" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 px-4 h-9 border-t border-line text-[11.5px] text-faint touch:hidden">
              <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
              <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
              <span className="ml-auto flex items-center gap-1.5"><Kbd>?</Kbd> all shortcuts</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ["Command palette", ["⌘/Ctrl", "K"]],
  ["Go to Overview", ["G", "O"]],
  ["Go to Approvals", ["G", "A"]],
  ["Go to Ledger", ["G", "L"]],
  ["Go to Outbox", ["G", "P"]],
  ["Go to Services", ["G", "S"]],
  ["Go to Checkup", ["G", "C"]],
  ["Approve selected (Approvals)", ["A"]],
  ["Reject selected (Approvals)", ["R"]],
  ["Edit selected (Approvals)", ["E"]],
  ["Next / previous card", ["J", "K"]],
  ["Toggle theme", ["T"]],
  ["Show this help", ["?"]],
];

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[90] grid place-items-center px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            className="relative w-full max-w-[440px] max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-line-strong bg-panel shadow-pop p-5"
            role="dialog"
            aria-label="Keyboard shortcuts"
          >
            <button onClick={onClose} aria-label="Close" className="hidden touch:grid absolute top-2.5 right-2.5 place-items-center size-10 rounded-lg text-faint hover:text-fg hover:bg-hover cursor-pointer">
              <X className="size-4" />
            </button>
            <div className="text-[15px] font-semibold mb-1 touch:pr-10">Keyboard shortcuts</div>
            <div className="text-[12.5px] text-faint mb-4">Keel works without a mouse. Press G, then a letter, to jump.</div>
            <div className="divide-y divide-line">
              {SHORTCUTS.map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                  <span className="text-muted">{label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {keys.map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
