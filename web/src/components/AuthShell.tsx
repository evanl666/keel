import type { ReactNode } from "react";
import { motion } from "motion/react";
import { useMe } from "../api/hooks";
import { KeelMark } from "./keel";

const CREW = ["🦉", "🦫", "🐙", "🦊"];

/** The centered card used by sign-in and invite pages (no sidebar). */
export function AuthShell({ title, sub, children, footer }: { title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const { data: me } = useMe();
  return (
    <div className="app-bg min-h-full flex flex-col items-center px-4 pt-[12vh] pb-16 sm:px-6">
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="w-full max-w-[380px]">
        <div className="flex items-center gap-2.5 mb-6">
          <KeelMark size={24} />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">Keel</span>
          <span className="ml-auto flex gap-1 text-[14px] select-none" aria-hidden>
            {CREW.map((e, i) => (
              <motion.span key={e} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.06, duration: 0.15 }}>
                {e}
              </motion.span>
            ))}
          </span>
        </div>
        <div className="rounded-xl border border-line bg-panel p-6">
          <h1 className="text-[20px] font-semibold tracking-[-0.015em]">{title}</h1>
          {sub && <div className="text-[14px] text-muted mt-1">{sub}</div>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-[12px] text-muted text-center">{footer}</div>}
      </motion.div>
      <div className="mt-auto pt-10 text-center text-[12px] text-muted">Keel {me?.version ?? ""} · self-hosted · your data stays on your servers</div>
    </div>
  );
}

export function OrDivider() {
  return (
    <div className="my-4 flex items-center gap-3 text-[12px] text-muted">
      <span className="h-px flex-1 bg-line" />
      or
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
