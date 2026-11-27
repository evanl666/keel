import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, XCircle, X } from "lucide-react";
import { cn } from "../lib/utils";

type Tone = "ok" | "bad" | "info";
interface Toast {
  id: number;
  title: string;
  line?: string;
  tone: Tone;
  icon?: string;
}
interface Ctx {
  toast: (t: Omit<Toast, "id" | "tone"> & { tone?: Tone }) => void;
}

const ToastCtx = createContext<Ctx>({ toast: () => {} });
export const useToast = () => useContext(ToastCtx).toast;

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback<Ctx["toast"]>(
    (t) => {
      const id = ++seq;
      setItems((xs) => [...xs.slice(-3), { tone: "ok", ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === "bad" ? 7000 : 4200);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 w-[360px] pointer-events-none" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className="pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong bg-panel/95 backdrop-blur-xl px-3.5 py-3 shadow-pop"
            >
              <span className="mt-px">
                {t.icon ? (
                  <span className="text-[15px] leading-none">{t.icon}</span>
                ) : t.tone === "ok" ? (
                  <CheckCircle2 className="size-4 text-ok" />
                ) : t.tone === "bad" ? (
                  <XCircle className="size-4 text-bad" />
                ) : (
                  <Info className="size-4 text-info" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium leading-snug">{t.title}</div>
                {t.line && <div className={cn("text-[12.5px] mt-0.5 leading-snug", t.tone === "bad" ? "text-bad" : "text-muted")}>{t.line}</div>}
              </div>
              <button onClick={() => dismiss(t.id)} className="text-faint hover:text-fg cursor-pointer" aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
