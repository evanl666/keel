import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeStream } from "../api/client";
import type { ActivityItem } from "../api/types";

interface StreamState {
  items: ActivityItem[];
  live: boolean;
}
const StreamCtx = createContext<StreamState>({ items: [], live: false });
export const useStream = () => useContext(StreamCtx);

export function StreamProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [state, setState] = useState<StreamState>({ items: [], live: false });
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const unsub = subscribeStream(
      (item) => {
        setState((s) => (s.items.some((x) => x.id === item.id) ? s : { ...s, items: [item, ...s.items].slice(0, 60) }));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          qc.invalidateQueries({ predicate: (q) => ["overview", "teams", "team", "approvals", "operations"].includes(q.queryKey[0] as string) });
        }, 400);
      },
      (live) => setState((s) => ({ ...s, live })),
    );
    return () => {
      unsub();
      clearTimeout(timer.current);
    };
  }, [enabled, qc]);
  return <StreamCtx.Provider value={state}>{children}</StreamCtx.Provider>;
}

/** Merge server activity with live stream items (newest first, de-duplicated). */
export function mergeActivity(server: ActivityItem[] | undefined, live: ActivityItem[], team?: string) {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const a of [...live, ...(server ?? [])]) {
    if (seen.has(a.id) || (team && a.team_slug !== team)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
