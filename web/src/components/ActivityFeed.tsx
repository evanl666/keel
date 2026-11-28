import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import type { ActivityItem, TeamSummary } from "../api/types";
import { ago } from "../lib/time";
import { cn } from "../lib/utils";

function useNow(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function ActivityFeed({ items, teams, limit = 14, dense }: { items: ActivityItem[]; teams: Record<string, TeamSummary>; limit?: number; dense?: boolean }) {
  useNow();
  return (
    <ul className="relative">
      <AnimatePresence initial={false}>
        {items.slice(0, limit).map((a) => {
          const t = a.team_slug ? teams[a.team_slug] : undefined;
          const color = t?.color ?? "var(--faint)";
          const body = (
            <div className={cn("group flex items-start gap-3 rounded-lg px-2.5 transition-colors", dense ? "py-2" : "py-2.5", a.link && "hover:bg-hover")}>
              <span className="mt-px grid size-7 shrink-0 place-items-center rounded-lg bg-hover text-[14px]">
                {a.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] leading-snug text-fg">{a.text}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                  {t && (
                    <>
                      <span className="size-1.5 rounded-full" style={{ background: color }} />
                      <span>{t.name}</span>
                      <span>·</span>
                    </>
                  )}
                  <span className="tabular">{ago(a.at)}</span>
                </div>
              </div>
            </div>
          );
          return (
            <motion.li
              key={a.id}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="rounded-lg"
            >
              {a.link ? <Link to={a.link}>{body}</Link> : body}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
