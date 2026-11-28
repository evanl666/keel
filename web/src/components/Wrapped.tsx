import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Download, Pause, Play, RotateCcw, X } from "lucide-react";
import { errorLine } from "../api/client";
import { useWrapped, useWrappedCard } from "../api/hooks";
import type { WrappedFacts } from "../api/types";
import { downloadText, fileSlug, svgDataUrl } from "../lib/share";
import { cn } from "../lib/utils";

const SLIDE_MS = 6500; // Long enough to read a slide twice; Spotify's run 5–8 s.
const DAYS = 30;

const PERSONA_EMOJI: Record<string, string> = {
  "The Closers": "🎯",
  "The Good Neighbours": "🤝",
  "The Optimists": "🌈",
  "The Speedrunners": "⚡",
  "The Steady Hands": "🧭",
  "The Calm Before": "🌙",
};

export interface WrappedTeam {
  slug: string;
  name: string;
  color: string;
  steward: { name: string; emoji: string };
}

interface Slide {
  id: string;
  colors: [string, string];
  body: ReactNode;
}

function hours(h: number) {
  return h < 1 ? { n: Math.round(h * 60), unit: "min" } : { n: h, unit: h === 1 ? "hour" : "hours" };
}

function CountUp({ to, decimals = 0, delay = 0.25 }: { to: number; decimals?: number; delay?: number }) {
  const reduce = useReducedMotion();
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (reduce) {
      setV(to);
      return;
    }
    const c = animate(0, to, { duration: 1.1, delay, ease: [0.22, 1, 0.36, 1], onUpdate: setV });
    return () => c.stop();
  }, [to, delay, reduce]);
  return <>{v.toFixed(decimals)}</>;
}

/** Fades and lifts its children in, one after another, by `i`. */
function Rise({ i = 0, className, children }: { i?: number; className?: string; children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 + i * 0.16, duration: 0.55, ease: [0.22, 1, 0.36, 1] }} className={className}>
      {children}
    </motion.div>
  );
}

const eyebrow = "text-[12px] font-semibold text-white/65";
const big = "font-black tracking-[-0.055em] leading-[0.85] tabular";

function ShareSlide({ team, f }: { team: WrappedTeam; f: WrappedFacts }) {
  const card = useWrappedCard(team.slug, DAYS);
  return (
    <div className="flex flex-col h-full justify-center gap-5">
      <Rise>
        <div className={eyebrow}>That's a wrap</div>
        <div className="mt-2 text-[26px] sm:text-[28px] font-bold leading-tight tracking-[-0.015em]">Pass it around.</div>
      </Rise>
      <Rise i={1}>
        <div className="rounded-xl overflow-hidden border border-white/15 aspect-[1200/630] bg-white/5">
          {card.data ? (
            <img src={svgDataUrl(card.data)} alt={`${team.name} Wrapped share card`} className="w-full h-full" />
          ) : card.error ? (
            <div className="h-full grid place-items-center px-4 text-center text-[14px] text-white/70">{errorLine(card.error)}</div>
          ) : (
            <div className="h-full grid place-items-center text-[14px] text-white/60">Drawing the card…</div>
          )}
        </div>
      </Rise>
      <Rise i={2} className="flex flex-col gap-2">
        <button
          type="button"
          disabled={!card.data}
          onClick={() => card.data && downloadText(`${fileSlug(team.name)}-wrapped-${f.to.replace(/\s+/g, "-").toLowerCase()}.svg`, card.data)}
          className="inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-white text-[#1c1c1e] text-[14px] font-semibold cursor-pointer hover:bg-white/90 transition disabled:opacity-50"
        >
          <Download className="size-4" /> Download card
        </button>
      </Rise>
      {f.oldest_open && (
        <Rise i={3} className="text-[14px] text-white/65 leading-snug">
          Next month: <span className="text-white/90">{f.oldest_open.title}</span> has waited {f.oldest_open.days} days.
        </Rise>
      )}
    </div>
  );
}

function buildSlides(team: WrappedTeam, f: WrappedFacts): Slide[] {
  const rate = f.on_time_rate;
  const slides: Slide[] = [
    {
      id: "on-time",
      colors: [team.color, "#22c55e"],
      body: (
        <div className="flex flex-col h-full">
          <Rise className="flex items-center gap-3">
            <span className="text-[34px] leading-none">{team.steward.emoji}</span>
            <div>
              <div className={eyebrow}>{team.name} Wrapped</div>
              <div className="text-[14px] text-white/60 mt-0.5">
                {f.from} → {f.to}
              </div>
            </div>
          </Rise>
          <div className="my-auto">
            <Rise i={1} className="text-[24px] sm:text-[26px] font-bold leading-tight tracking-[-0.015em]">
              {rate === null ? "Nothing closed this month. Yet." : "Of everything you finished,"}
            </Rise>
            <Rise i={2} className={cn(big, "text-[112px] sm:text-[128px] mt-4")}>
              {rate === null ? "—" : (
                <>
                  <CountUp to={Math.round(rate * 100)} />%
                </>
              )}
            </Rise>
            <Rise i={3} className="text-[22px] font-semibold mt-3 text-white/90">
              {rate === null ? "Promises will show up here as they land." : "landed on time."}
            </Rise>
            {f.longest_on_time_streak >= 2 && (
              <Rise i={4} className="mt-6 inline-flex items-center gap-2 rounded-full bg-white/10 ring-1 ring-white/15 px-3 h-8 text-[13px]">
                🔥 {f.longest_on_time_streak} on time in a row
              </Rise>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "kept",
      colors: ["#1d5bd0", "#1d5bd0"],
      body: (
        <div className="flex flex-col h-full justify-center">
          <Rise className={eyebrow}>Promises</Rise>
          <Rise i={1} className="mt-3 text-[24px] sm:text-[26px] font-bold leading-tight tracking-[-0.015em]">
            {f.made} new {f.made === 1 ? "promise" : "promises"} came in.
            <span className="block text-white/70">You kept</span>
          </Rise>
          <Rise i={2} className={cn(big, "text-[128px] sm:text-[144px] mt-4")}>
            <CountUp to={f.kept} delay={0.45} />
          </Rise>
          <Rise i={3} className="text-[20px] font-semibold text-white/90 mt-3">
            {f.on_time} of them on time.
          </Rise>
          <div className="mt-7 space-y-2 text-[14px] text-white/80">
            {f.busiest_day && <Rise i={4}>{f.busiest_day} was your busiest day.</Rise>}
            {f.helped_other_teams > 0 && (
              <Rise i={5}>
                {f.helped_other_teams} {f.helped_other_teams === 1 ? "was another team's ask" : "were other teams' asks"}.
              </Rise>
            )}
          </div>
        </div>
      ),
    },
  ];
  if (f.fastest) {
    const h = hours(f.fastest.hours);
    slides.push({
      id: "fastest",
      colors: ["#f59e0b", "#ef4444"],
      body: (
        <div className="flex flex-col h-full justify-center">
          <Rise className={eyebrow}>Fastest close</Rise>
          <Rise i={1} className="mt-3 text-[24px] sm:text-[26px] font-bold leading-tight tracking-[-0.015em]">
            From ask to done in
          </Rise>
          <Rise i={2} className="mt-4 flex items-baseline gap-3">
            <span className={cn(big, "text-[112px] sm:text-[128px]")}>
              <CountUp to={h.n} decimals={h.n % 1 ? 1 : 0} />
            </span>
            <span className="text-[28px] font-bold text-white/85">{h.unit}</span>
          </Rise>
          <Rise i={3} className="mt-6 rounded-xl bg-white/10 ring-1 ring-white/15 px-4 py-3">
            <div className="text-[12px] font-mono text-white/60">{f.fastest.key}</div>
            <div className="text-[16px] font-semibold leading-snug mt-0.5">{f.fastest.title}</div>
          </Rise>
        </div>
      ),
    });
  }
  if (f.top_closers.length || f.best_partner) {
    const max = Math.max(1, ...f.top_closers.map((c) => c.kept));
    slides.push({
      id: "people",
      colors: ["#38bdf8", team.color],
      body: (
        <div className="flex flex-col h-full justify-center">
          <Rise className={eyebrow}>Your people</Rise>
          {f.top_closers.length > 0 && (
            <>
              <Rise i={1} className="mt-3 text-[24px] sm:text-[26px] font-bold leading-tight tracking-[-0.015em]">
                The ones who closed the most.
              </Rise>
              <div className="mt-5 space-y-3">
                {f.top_closers.map((c, i) => (
                  <Rise key={c.who} i={2 + i} className="flex items-center gap-3">
                    <span className={cn("w-7 text-[30px] font-black tabular text-center", i === 0 ? "text-white" : "text-white/55")}>{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[16px] font-semibold truncate">{c.who}</span>
                        <span className="ml-auto text-[14px] text-white/70 tabular whitespace-nowrap">{c.kept} kept</span>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <motion.div className="h-full rounded-full bg-white/85" initial={{ width: 0 }} animate={{ width: `${(c.kept / max) * 100}%` }} transition={{ delay: 0.5 + i * 0.16, duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
                      </div>
                    </div>
                  </Rise>
                ))}
              </div>
            </>
          )}
          {f.best_partner && (
            <Rise i={2 + f.top_closers.length} className="mt-8 rounded-xl bg-white/10 ring-1 ring-white/15 px-4 py-3.5">
              <div className="text-[12px] text-white/60 font-semibold">Best partner</div>
              <div className="text-[22px] font-bold mt-1">{f.best_partner.team}</div>
              <div className="text-[14px] text-white/75">
                {f.best_partner.count} {f.best_partner.count === 1 ? "promise" : "promises"} kept between you.
              </div>
            </Rise>
          )}
        </div>
      ),
    });
  }
  slides.push({
    id: "persona",
    colors: [team.color, "#a855f7"],
    body: (
      <div className="flex flex-col h-full justify-center">
        <Rise className={eyebrow}>This month you were</Rise>
        <motion.div initial={{ scale: 0.4, opacity: 0, rotate: -12 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 220, damping: 13, delay: 0.3 }} className="mt-6 text-[72px] leading-none">
          {PERSONA_EMOJI[f.persona.name] ?? "✨"}
        </motion.div>
        <Rise i={2} className="mt-5 text-[44px] sm:text-[52px] font-black tracking-[-0.04em] leading-[0.95]">
          {f.persona.name}
        </Rise>
        <Rise i={3} className="mt-4 text-[18px] text-white/85 leading-snug text-pretty">
          {f.persona.line}
        </Rise>
        {f.headline && f.headline !== f.persona.line && (
          <Rise i={4} className="mt-6 border-l-2 border-white/40 pl-3 text-[16px] italic text-white/80 leading-snug">
            {f.headline}
          </Rise>
        )}
      </div>
    ),
  });
  slides.push({ id: "share", colors: ["#46464b", "#46464b"], body: <ShareSlide team={team} f={f} /> });
  return slides;
}

export function WrappedStory({ team, onClose }: { team: WrappedTeam; onClose: () => void }) {
  const { data: f, error, isLoading } = useWrapped(team.slug, DAYS);
  const slides = useMemo(() => (f ? buildSlides(team, f) : []), [f, team]);
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1);
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; t: number } | null>(null);
  const last = slides.length - 1;

  const go = useCallback(
    (to: number) => {
      if (!slides.length) return;
      const n = Math.max(0, Math.min(slides.length - 1, to));
      setDir(n >= idx ? 1 : -1);
      setIdx(n);
    },
    [idx, slides.length],
  );
  const next = useCallback(() => go(idx + 1), [go, idx]);
  const prev = useCallback(() => go(idx - 1), [go, idx]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === " " && !(e.target as HTMLElement)?.closest?.("button")) {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [next, prev, onClose]);
  useEffect(() => {
    const h = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);

  // Auto-advance follows the progress bar's CSS animation; with reduced motion the reader steps by hand.
  const auto = !reduce && idx < last;
  const running = auto && !held && !paused && !hidden;
  const slide = slides[idx];

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[120] grid place-items-center bg-[rgba(12,12,14,0.78)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex items-center gap-5">
        <button type="button" onClick={prev} disabled={idx === 0 || !slides.length} aria-label="Previous slide" className="max-sm:hidden grid place-items-center size-11 rounded-full bg-white/10 text-white hover:bg-white/20 cursor-pointer disabled:opacity-0 transition">
          <ChevronLeft className="size-5" />
        </button>
        <motion.div
          ref={ref}
          role="dialog"
          aria-modal
          aria-label={`${team.name} Wrapped`}
          tabIndex={-1}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="dark relative overflow-hidden text-white bg-[#141416] outline-none select-none w-screen h-dvh sm:w-auto sm:h-[min(780px,92dvh)] sm:aspect-[9/16] sm:rounded-2xl shadow-pop"
          style={{ touchAction: "pan-y" }}
        >
          <AnimatePresence initial={false}>
            <motion.div key={slide?.id ?? "loading"} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <div className="absolute inset-0" style={{ background: `color-mix(in srgb, ${slide?.colors[0] ?? team.color} 16%, #141416)` }} />
            </motion.div>
          </AnimatePresence>

          <div className="absolute inset-x-0 top-0 z-10 px-3 pt-[max(12px,env(safe-area-inset-top))]">
            <div className="flex gap-1" aria-hidden>
              {(slides.length ? slides : [null]).map((s, i) => (
                <div key={s?.id ?? i} className="h-[3px] flex-1 rounded-full bg-white/25 overflow-hidden">
                  {i < idx || (i === idx && (!auto || i === last)) ? (
                    <div className="h-full w-full bg-white rounded-full" />
                  ) : i === idx ? (
                    <div
                      key={`fill-${idx}`}
                      className="h-full w-full bg-white rounded-full origin-left"
                      style={{ animation: `wrapped-fill ${SLIDE_MS}ms linear forwards`, animationPlayState: running ? "running" : "paused" }}
                      onAnimationEnd={next}
                    />
                  ) : null}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1">
              <span className="text-[12px] font-semibold text-white/85 pl-1">
                {team.steward.emoji} {team.name} · last {DAYS} days
              </span>
              <span className="sr-only" aria-live="polite">
                Slide {idx + 1} of {slides.length || 1}
              </span>
              {auto && (
                <button type="button" onClick={() => setPaused((p) => !p)} aria-label={paused ? "Play" : "Pause"} className="ml-auto grid place-items-center size-10 rounded-full text-white/80 hover:text-white hover:bg-white/10 cursor-pointer">
                  {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                </button>
              )}
              <button type="button" onClick={onClose} aria-label="Close" className={cn("grid place-items-center size-10 rounded-full text-white/80 hover:text-white hover:bg-white/10 cursor-pointer", !auto && "ml-auto")}>
                <X className="size-5" />
              </button>
            </div>
          </div>

          <div
            className="absolute inset-0 z-[5] px-6 sm:px-8 pt-[88px] pb-10"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button,a")) return;
              press.current = { x: e.clientX, y: e.clientY, t: Date.now() };
              setHeld(true);
            }}
            onPointerCancel={() => {
              press.current = null;
              setHeld(false);
            }}
            onPointerUp={(e) => {
              const p = press.current;
              press.current = null;
              setHeld(false);
              if (!p) return;
              const dx = e.clientX - p.x;
              const dy = e.clientY - p.y;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? next() : prev();
              if (Date.now() - p.t > 400 || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
              const r = e.currentTarget.getBoundingClientRect();
              if (e.clientX < r.left + r.width * 0.3) prev();
              else next();
            }}
          >
            {isLoading ? (
              <div className="h-full grid place-items-center text-center">
                <div>
                  <motion.div className="text-[56px]" animate={reduce ? undefined : { scale: [1, 1.12, 1] }} transition={{ repeat: Infinity, duration: 1.4 }}>
                    {team.steward.emoji}
                  </motion.div>
                  <div className="mt-3 text-[16px] text-white/80">Wrapping up {team.name}'s month…</div>
                </div>
              </div>
            ) : error || !slide ? (
              <div className="h-full grid place-items-center text-center">
                <div>
                  <div className="text-[40px]">🌧️</div>
                  <div className="mt-3 text-[16px] font-semibold">The recap didn't load</div>
                  <div className="mt-1 text-[14px] text-white/70">{error ? errorLine(error) : "There was nothing to show."}</div>
                </div>
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false} custom={dir}>
                <motion.div
                  key={slide.id}
                  className="h-full"
                  custom={dir}
                  initial={{ opacity: 0, x: dir * 36 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: dir * -36 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  {slide.body}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {slides.length > 0 && (
            <div className="absolute inset-x-0 bottom-0 z-10 pb-[max(12px,env(safe-area-inset-bottom))] text-center text-[12px] text-white/50 pointer-events-none">
              {idx === 0 ? (
                <>
                  <span className="touch:hidden">Click, or press → to continue</span>
                  <span className="hidden touch:inline">Tap to continue · hold to pause</span>
                </>
              ) : idx === last ? (
                <button type="button" onClick={() => go(0)} className="pointer-events-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-white/70 hover:text-white hover:bg-white/10 cursor-pointer">
                  <RotateCcw className="size-3.5" /> Watch again
                </button>
              ) : (
                `${idx + 1} / ${slides.length}`
              )}
            </div>
          )}
        </motion.div>
        <button type="button" onClick={next} disabled={idx >= last || !slides.length} aria-label="Next slide" className="max-sm:hidden grid place-items-center size-11 rounded-full bg-white/10 text-white hover:bg-white/20 cursor-pointer disabled:opacity-0 transition">
          <ChevronRight className="size-5" />
        </button>
      </div>
    </motion.div>,
    document.body,
  );
}
