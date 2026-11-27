import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, EyeOff, FileText, Search } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { qk, useChat } from "../../api/hooks";
import type { AskResult, AskSource, ChatMessage, TeamDetail } from "../../api/types";
import { Button, Card, CardHeader, ErrorLine, Input, Skeleton } from "../../components/ui";
import { LabelBadge, Markdown, StewardAvatar } from "../../components/keel";
import { clock } from "../../lib/time";
import { alpha, cn } from "../../lib/utils";

const SUGGEST: Record<string, string[]> = {
  payments: ["What's at risk this week?", "How do we rotate the webhook secret?", "What's our refund policy?"],
  platform: ["What's at risk?", "When is the PG16 upgrade?", "How do I get a new namespace?"],
  mobile: ["What's overdue?", "When does 5.2 ship?", "Who owns push notifications?"],
};

function Sources({ sources }: { sources: AskSource[] }) {
  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      {sources.map((s) => (
        <div key={s.title} className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-[12px]">
          <FileText className="size-3.5 text-faint shrink-0" />
          <span className="min-w-0 font-medium truncate">{s.title}</span>
          <span className="min-w-0 text-faint truncate max-sm:hidden">· {s.source}</span>
          <LabelBadge label={s.label} className="ml-auto shrink-0" />
        </div>
      ))}
    </div>
  );
}

function Withheld({ n }: { n: number }) {
  if (!n) return null;
  return (
    <div className="mt-2.5 flex items-center gap-2 text-[12px] text-faint">
      <EyeOff className="size-3.5" />
      {n} {n === 1 ? "source" : "sources"} hidden: this audience can't see them
    </div>
  );
}

function Bubble({ m, t }: { m: ChatMessage; t: TeamDetail }) {
  const mine = m.role === "user";
  return (
    <motion.div layout initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 32 }} className={cn("flex gap-2.5", mine && "justify-end")}>
      {!mine && <StewardAvatar emoji={t.steward.emoji} color={t.color} size="sm" active={false} className="mt-0.5" />}
      <div className={cn("max-w-[78%] min-w-0", mine && "flex flex-col items-end")}>
        <div
          className={cn("rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed", mine ? "rounded-br-md text-white" : "rounded-tl-md border border-line bg-panel-2")}
          style={mine ? { background: `linear-gradient(135deg, ${t.color}, ${alpha(t.color, 0.82)})` } : undefined}
        >
          {mine ? m.text : <Markdown compact>{m.text}</Markdown>}
          {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}
        </div>
        {m.actions && m.actions.length > 0 && (
          <div className="mt-1.5 flex gap-1.5 flex-wrap">
            {m.actions.map((a) =>
              a.link ? (
                <Link key={a.text} to={a.link}>
                  <Button size="sm">{a.text}</Button>
                </Link>
              ) : (
                <Button key={a.text} size="sm" disabled>
                  {a.text}
                </Button>
              ),
            )}
          </div>
        )}
        <div className="mt-1 px-1 text-[11px] text-faint">{clock(m.at)}</div>
      </div>
    </motion.div>
  );
}

function Typing({ t }: { t: TeamDetail }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex gap-2.5">
      <StewardAvatar emoji={t.steward.emoji} color={t.color} size="sm" active={false} />
      <div className="rounded-2xl rounded-tl-md border border-line bg-panel-2 px-3.5 py-3 flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span key={i} className="size-1.5 rounded-full bg-muted" animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }} transition={{ repeat: Infinity, duration: 1, delay: i * 0.15 }} />
        ))}
      </div>
    </motion.div>
  );
}

function Chat({ t }: { t: TeamDetail }) {
  const { data, isLoading } = useChat(t.slug);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: (message: string) => api.sendChat(t.slug, message),
    onMutate: (message) => {
      qc.setQueryData<ChatMessage[]>(qk.chat(t.slug), (old) => [...(old ?? []), { role: "user", text: message, at: new Date().toISOString() }]);
      setText("");
    },
    onSuccess: (replies) => qc.setQueryData<ChatMessage[]>(qk.chat(t.slug), (old) => [...(old ?? []), ...replies]),
  });
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [data?.length, send.isPending]);
  const submit = (m: string) => m.trim() && !send.isPending && send.mutate(m.trim());

  return (
    <Card className="flex flex-col h-[min(600px,calc(100dvh-7rem))] min-h-[440px] sm:h-[600px] overflow-hidden">
      <CardHeader title={`Chat with ${t.steward.name}`} sub="Ask about the team's work. It answers from the ledger and team knowledge." className="border-b border-line pb-3" />
      <div ref={scroller} className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4 space-y-4">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-1/2 ml-auto" />
            <Skeleton className="h-24 w-3/4" />
          </div>
        ) : (
          <>
            {!data?.length && (
              <div className="h-full grid place-items-center text-center py-10">
                <div>
                  <StewardAvatar emoji={t.steward.emoji} color={t.color} size="lg" className="mx-auto" />
                  <div className="mt-3 text-[14px] font-semibold">Hi, I'm {t.steward.name}.</div>
                  <div className="text-[13px] text-muted">Ask me what's at risk, or anything about {t.name}.</div>
                </div>
              </div>
            )}
            {data?.map((m, i) => <Bubble key={i + m.at} m={m} t={t} />)}
            <AnimatePresence>{send.isPending && <Typing t={t} />}</AnimatePresence>
          </>
        )}
      </div>
      {send.error && <ErrorLine error={errorLine(send.error)} className="mx-4 mb-2" />}
      <div className="border-t border-line p-3">
        <div className="flex gap-1.5 mb-2 flex-wrap max-sm:flex-nowrap max-sm:scroll-x max-sm:-mx-3 max-sm:px-3">
          {(SUGGEST[t.slug] ?? SUGGEST.payments).map((s) => (
            <button key={s} onClick={() => submit(s)} className="shrink-0 whitespace-nowrap h-6 px-2 max-sm:h-9 max-sm:px-3 max-sm:text-[12.5px] rounded-full border border-line text-[11.5px] text-muted hover:text-fg hover:border-line-strong cursor-pointer transition-colors">
              {s}
            </button>
          ))}
        </div>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${t.steward.name}…`} className="h-10 max-sm:h-11 pr-12 rounded-xl" />
          <button
            type="submit"
            disabled={!text.trim() || send.isPending}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 size-7 max-sm:size-8 rounded-lg grid place-items-center text-white disabled:opacity-30 cursor-pointer transition-opacity"
            style={{ background: t.color }}
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
      </div>
    </Card>
  );
}

function Ask({ t }: { t: TeamDetail }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ q: string; r: AskResult } | null>(null);
  const ask = useMutation({
    mutationFn: (question: string) => api.ask(t.slug, question),
    onSuccess: (r, question) => setRes({ q: question, r }),
  });
  const examples = t.slug === "payments" ? ["3DS fallback", "PCI scope", "refunds over $5,000"] : t.slug === "platform" ? ["new namespace", "PG16 upgrade", "on-call"] : ["release train", "push notifications", "crash rate"];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Front desk" sub={`What another team sees when they ask ${t.steward.name}. Labels decide what it may quote.`} />
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) ask.mutate(q.trim());
          }}
        >
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask as another team…" className="pl-9 pr-20 max-sm:h-11" />
          <Button type="submit" size="sm" variant="primary" className="absolute right-1 top-1/2 -translate-y-1/2 max-sm:h-9" loading={ask.isPending} disabled={!q.trim()}>
            Ask
          </Button>
        </form>
        <div className="mt-2 flex items-center gap-x-1.5 gap-y-0 flex-wrap text-[11.5px] max-sm:text-[12.5px]">
          <span className="text-faint">Try</span>
          {examples.map((e) => (
            <button
              key={e}
              onClick={() => {
                setQ(e);
                ask.mutate(e);
              }}
              className="max-sm:py-2.5 text-muted hover:text-accent underline decoration-dotted underline-offset-2 cursor-pointer"
            >
              {e}
            </button>
          ))}
        </div>
        {ask.error && <ErrorLine error={errorLine(ask.error)} className="mt-3" />}
        <AnimatePresence mode="wait">
          {res && (
            <motion.div key={res.q} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 rounded-xl border border-line bg-sunken p-4">
              <div className="flex items-center gap-2 mb-2">
                <StewardAvatar emoji={t.steward.emoji} color={t.color} size="xs" active={false} />
                <span className="text-[12.5px] font-medium">{t.steward.name} answers</span>
                <LabelBadge label={res.r.label} className="ml-auto" />
              </div>
              <div className="text-[13.5px] leading-relaxed whitespace-pre-line">{res.r.answer}</div>
              {res.r.sources.length > 0 && <Sources sources={res.r.sources} />}
              <Withheld n={res.r.withheld} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}

export function FrontDeskTab({ t }: { t: TeamDetail }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5">
      <div className="lg:col-span-7 min-w-0">
        <Chat t={t} />
      </div>
      <div className="lg:col-span-5 min-w-0 space-y-5">
        <Ask t={t} />
        <Card className="p-4 sm:p-5">
          <div className="text-[13px] font-semibold">How labels work</div>
          <div className="mt-3 space-y-2 text-[12.5px] text-muted">
            {(
              [
                ["public", "Anyone, including other teams' stewards."],
                ["internal", "Anyone at the company."],
                ["confidential", "This team and named people only."],
                ["restricted", "Never quoted. Only counted as hidden."],
              ] as const
            ).map(([l, d]) => (
              <div key={l} className="flex items-center gap-3">
                <LabelBadge label={l} withTip={false} className="w-[98px] shrink-0 justify-center" />
                <span>{d}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
