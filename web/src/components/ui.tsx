import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, MoreHorizontal, X } from "lucide-react";
import { cn, scrollIntoStrip } from "../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success" | "outline";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  kbd?: string;
}

// primary: near-black fill. secondary: grey fill. ghost: a quiet text button.
const variants: Record<Variant, string> = {
  primary: "bg-ink text-ink-fg hover:opacity-90",
  success: "bg-ink text-ink-fg hover:opacity-90",
  secondary: "bg-hover text-fg hover:bg-line",
  outline: "bg-panel text-fg border border-line hover:bg-hover",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  danger: "bg-bad-soft text-bad hover:brightness-95 dark:hover:brightness-125",
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md max-sm:h-9 max-sm:px-3",
  md: "h-8 px-3 text-[13px] gap-1.5 rounded-lg max-sm:h-10",
  lg: "h-9 px-4 text-[14px] gap-2 rounded-lg max-sm:h-11",
};

const BTN = "inline-flex items-center justify-center font-medium whitespace-nowrap transition-[background-color,opacity,color] duration-150 select-none disabled:opacity-40 disabled:pointer-events-none cursor-pointer";

/** Button looks for links (<a>, <Link>), so they don't nest a <button>. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(BTN, variants[variant], sizes[size], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, kbd, className, children, disabled, type = "button", ...rest },
  ref,
) {
  // "button" by default so Cancel/Discard inside a form never submits it; submit buttons say type="submit".
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
      {kbd && <Kbd className={cn("ml-0.5 touch:hidden", (variant === "primary" || variant === "success") && "!bg-transparent !border-current/25 !text-inherit opacity-60")}>{kbd}</Kbd>}
    </button>
  );
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-[5px] border border-line bg-panel px-1 font-sans text-[11px] font-medium text-muted", className)}>
      {children}
    </kbd>
  );
}

export function Card({ className, children, glow: _glow, ...rest }: { className?: string; children: ReactNode; glow?: string } & HTMLAttributes<HTMLDivElement>) {
  void _glow;
  return (
    <div className={cn("relative rounded-xl border border-line bg-panel", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, sub, right, className }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold">{title}</div>
        {sub && <div className="text-[12px] text-muted mt-0.5">{sub}</div>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{right}</div>}
    </div>
  );
}

/** A small muted section heading, like the group headers in the sidebar. */
export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 mb-2 min-h-7", className)}>
      <h2 className="text-[14px] font-semibold">{children}</h2>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "bg-hover text-soft",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ children, className, tone, color, title }: { children: ReactNode; className?: string; tone?: Tone; color?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[12px] font-medium whitespace-nowrap leading-none", !color && TONES[tone ?? "neutral"], className)}
      style={color ? { color, background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ color, live, className }: { color: string; live?: boolean; className?: string }) {
  return <span className={cn("inline-block size-2 rounded-full shrink-0", live && "live-dot", className)} style={{ background: color }} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, line, action, className }: { icon?: ReactNode; title: string; line?: string; action?: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className={cn("flex flex-col items-center justify-center text-center py-12 px-6", className)}>
      {icon && <div className="text-[22px] mb-2 select-none opacity-80">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {line && <div className="text-[14px] text-muted mt-0.5 max-w-sm">{line}</div>}
      {action && <div className="mt-4">{action}</div>}
    </motion.div>
  );
}

export function ErrorLine({ error, className }: { error: string; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 text-[13px] text-bad rounded-lg bg-bad-soft px-3 py-2", className)}>
      <span className="mt-[6px] size-1.5 rounded-full bg-bad shrink-0" />
      <span>{error}</span>
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; color?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full transition-colors duration-150 cursor-pointer disabled:opacity-50 touch:before:absolute touch:before:-inset-[10px]",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <motion.span
        layout
        transition={{ duration: 0.15 }}
        className={cn("block size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)]", checked ? "ml-[16px]" : "ml-[2px]")}
      />
    </button>
  );
}

export function Tooltip({ content, children, side = "top", className }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom"; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      <AnimatePresence>
        {open && content && (
          <motion.span
            id={id}
            role="tooltip"
            initial={{ opacity: 0, y: side === "top" ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "pointer-events-none absolute left-1/2 -translate-x-1/2 z-50 w-max max-w-[260px] rounded-lg bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-ink-fg font-normal normal-case tracking-normal",
              side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            )}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/* The page header lives in the layout's top bar; pages fill it through a portal. */
export const HeaderSlot = createContext<HTMLElement | null>(null);

export function PageHeader({
  title,
  sub,
  right,
  icon,
  back,
  tabs,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  icon?: ReactNode;
  back?: { to: string; label: string };
  tabs?: ReactNode;
}) {
  const slot = useContext(HeaderSlot);
  const body = (
    <>
      <div className="flex items-center gap-3 sm:gap-4 min-h-16 px-4 sm:px-6 nav:px-8 py-2.5">
        {back && (
          <Link to={back.to} className="max-sm:hidden shrink-0 inline-flex items-center gap-1 text-[14px] text-muted hover:text-fg transition-colors">
            <span aria-hidden>←</span> {back.label}
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.01em] leading-tight">
            {icon && <span className="shrink-0 inline-flex">{icon}</span>}
            <span className="truncate">{title}</span>
          </h1>
          {sub && <div className="text-[12px] text-muted mt-0.5 leading-snug line-clamp-2 sm:truncate">{sub}</div>}
        </div>
        {right && <div className="flex items-center gap-2 shrink-0 max-sm:max-w-[55%] max-sm:flex-wrap max-sm:justify-end">{right}</div>}
      </div>
      {tabs && <div className="border-t border-line px-4 sm:px-6 nav:px-8">{tabs}</div>}
    </>
  );
  if (slot) return createPortal(body, slot);
  return <div className="-mx-4 sm:-mx-6 mb-6 border-b border-line">{body}</div>;
}

/** Text tabs; the active one sits on a grey pill. */
export function TabBar({ items, active, className }: { items: { id: string; label: ReactNode; to: string; count?: number }[]; active: string; className?: string }) {
  return (
    <nav className={cn("flex items-center gap-1 h-11 scroll-x", className)}>
      {items.map((x) => (
        <Link
          key={x.id}
          to={x.to}
          aria-current={active === x.id ? "page" : undefined}
          ref={active === x.id ? scrollIntoStrip : undefined}
          className={cn(
            "shrink-0 whitespace-nowrap h-8 px-3 rounded-lg text-[14px] font-medium inline-flex items-center gap-1.5 transition-colors",
            active === x.id ? "bg-hover text-fg" : "text-muted hover:text-fg",
          )}
        >
          {x.label}
          {!!x.count && <span className="text-[12px] text-muted tabular">{x.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: "sm" | "md"; className?: string }) {
  return (
    <div role="tablist" className={cn("inline-flex max-w-full scroll-x items-center gap-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 max-sm:h-9 shrink-0 px-2.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer inline-flex items-center gap-1.5",
            value === o.value ? "bg-hover text-fg" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="text-[12px] text-muted tabular font-normal">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// On phones inputs are 40px tall and 16px text, so iOS doesn't zoom on focus.
const field =
  "w-full rounded-lg border border-line bg-panel px-3 text-[14px] max-sm:text-[16px] text-fg placeholder:text-faint outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent-soft disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, "h-9 max-sm:h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, "py-2 leading-relaxed resize-y", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(field, "h-9 max-sm:h-10 pr-8 appearance-none bg-no-repeat cursor-pointer", className)}
      style={{
        backgroundImage: "linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%)",
        backgroundPosition: "calc(100% - 15px) 55%, calc(100% - 10px) 55%",
        backgroundSize: "5px 5px",
      }}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="block text-[12px] font-medium text-soft mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-muted mt-1.5">{hint}</span>}
    </label>
  );
}

export function Stat({ label, value, tone, icon }: { label: string; value: ReactNode; tone?: "bad" | "warn" | "ok" | "accent"; icon?: ReactNode }) {
  const toneCls = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[12px] text-muted whitespace-nowrap">
        {icon}
        {label}
      </div>
      <div className={cn("text-[20px] font-semibold tracking-[-0.01em] tabular mt-0.5", toneCls)}>{value}</div>
    </div>
  );
}

export function Avatar({ name, url, size = 28, className }: { name: string; url?: string | null; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  if (url) return <img src={url} alt="" className={cn("rounded-full shrink-0 object-cover", className)} style={{ width: size, height: size }} />;
  return (
    <span
      aria-hidden
      className={cn("grid place-items-center rounded-full shrink-0 bg-hover text-soft font-semibold", className)}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {initials || "?"}
    </span>
  );
}

/** Rows divided by 1px lines inside a card. */
export function List({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-line bg-panel divide-y divide-line overflow-hidden", className)}>{children}</div>;
}

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])") ?? []).filter((x) => x.offsetParent !== null);
    const t = setTimeout(() => {
      if (!el?.contains(document.activeElement)) (el?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables()[0] ?? el)?.focus();
    }, 30);
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", h, true);
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

/** A centered dialog. */
export function Dialog({ open, onClose, title, sub, children, footer, width = 480 }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useFocusTrap(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[90] grid place-items-center p-3 sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0 bg-black/30 dark:bg-black/55" onClick={onClose} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal
            tabIndex={-1}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-h-[calc(100dvh-1.5rem)] flex flex-col rounded-xl border border-line bg-panel shadow-pop outline-none"
            style={{ maxWidth: width }}
          >
            <div className="flex items-start gap-3 px-5 pt-4 pb-3">
              <div className="min-w-0 flex-1">
                <div className="text-[16px] font-semibold tracking-[-0.01em]">{title}</div>
                {sub && <div className="text-[13px] text-muted mt-0.5">{sub}</div>}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 grid place-items-center size-8 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer">
                <X className="size-4" />
              </button>
            </div>
            <div className="px-5 pb-5 overflow-y-auto overscroll-contain min-h-0">{children}</div>
            {footer && <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** A side panel that slides in from the right. */
export function Sheet({ open, onClose, title, sub, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useFocusTrap(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[90]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0 bg-black/20 dark:bg-black/50" onClick={onClose} />
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal
            tabIndex={-1}
            initial={{ x: 16, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 16, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-y-0 right-0 w-full flex flex-col bg-panel border-l border-line shadow-pop outline-none"
            style={{ maxWidth: width }}
          >
            <div className="flex items-start gap-3 px-5 sm:px-6 h-16 py-3 border-b border-line shrink-0">
              <div className="min-w-0 flex-1">
                <div className="text-[16px] font-semibold tracking-[-0.01em] truncate">{title}</div>
                {sub && <div className="text-[12px] text-muted mt-0.5 truncate">{sub}</div>}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 grid place-items-center size-8 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 sm:px-6 py-5">{children}</div>
            {footer && <div className="px-5 sm:px-6 py-3 border-t border-line flex flex-wrap items-center gap-2 shrink-0">{footer}</div>}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Ask before something that can't be undone. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  line,
  confirmLabel,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  line: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[14px] text-soft">{line}</div>
      {error && <ErrorLine error={error} className="mt-3" />}
    </Dialog>
  );
}

/** A "···" button with a small menu of row actions. */
export function RowMenu({ open, setOpen, label, children }: { open: boolean; setOpen: (v: boolean) => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid place-items-center size-8 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-40 min-w-[168px] rounded-xl border border-line bg-panel shadow-pop p-1" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, danger, disabled }: { onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn("w-full text-left h-8 px-2.5 rounded-lg text-[14px] cursor-pointer hover:bg-hover disabled:opacity-40 disabled:pointer-events-none", danger ? "text-bad" : "text-fg")}
    >
      {children}
    </button>
  );
}

