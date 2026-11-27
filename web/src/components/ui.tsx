import { forwardRef, useId, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  kbd?: string;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg hover:brightness-110 shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_16px_-6px_var(--accent)] border border-transparent",
  secondary: "bg-panel text-fg border border-line hover:border-line-strong hover:bg-hover shadow-soft",
  ghost: "text-muted hover:text-fg hover:bg-hover border border-transparent",
  danger: "bg-panel text-bad border border-line hover:border-bad/40 hover:bg-bad/10",
  success: "bg-ok text-white dark:text-[#04130c] hover:brightness-110 border border-transparent shadow-[0_6px_16px_-8px_var(--ok)]",
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md max-sm:h-10 max-sm:px-3 max-sm:rounded-lg",
  md: "h-8 px-3 text-[13px] gap-2 rounded-lg max-sm:h-10",
  lg: "h-10 px-4 text-[14px] gap-2 rounded-lg max-sm:h-11",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, kbd, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none cursor-pointer",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
      {kbd && <Kbd className={cn("ml-0.5 touch:hidden", variant === "primary" || variant === "success" ? "opacity-70 !bg-none !bg-black/15 !border-black/10 !text-inherit !shadow-none" : "")}>{kbd}</Kbd>}
    </button>
  );
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-[5px] border border-line-strong px-1 font-sans text-[10.5px] font-medium text-muted shadow-[0_1px_0_var(--line-strong)]",
        className,
      )}
      style={{ background: "var(--kbd-bg)" }}
    >
      {children}
    </kbd>
  );
}

export function Card({ className, children, glow, style, ...rest }: { className?: string; children: ReactNode; glow?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("relative rounded-xl border border-line bg-panel shadow-card", className)}
      style={glow ? { backgroundImage: `radial-gradient(120% 80% at 0% 0%, ${glow}, transparent 55%)`, ...style } : style}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, sub, right, className }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold tracking-[-0.005em]">{title}</div>
        {sub && <div className="text-[12.5px] text-faint mt-0.5">{sub}</div>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{right}</div>}
    </div>
  );
}

export function Badge({ children, className, color, title }: { children: ReactNode; className?: string; color?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11px] font-medium border whitespace-nowrap leading-none",
        !color && "border-line bg-hover text-muted",
        className,
      )}
      style={color ? { color, borderColor: `color-mix(in srgb, ${color} 30%, transparent)`, background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, line, action, className }: { icon?: ReactNode; title: string; line?: string; action?: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex flex-col items-center justify-center text-center py-14 px-6", className)}
    >
      {icon && <div className="text-4xl mb-3 select-none">{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {line && <div className="text-[13px] text-muted mt-1 max-w-sm">{line}</div>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

export function ErrorLine({ error, className }: { error: string; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 text-[13px] text-bad rounded-lg border border-bad/25 bg-bad/8 px-3 py-2", className)}>
      <span className="mt-[5px] size-1.5 rounded-full bg-bad shrink-0" />
      <span>{error}</span>
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label, color }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; color?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-200 cursor-pointer disabled:opacity-50 touch:before:absolute touch:before:-inset-[9px]",
        checked ? "border-transparent" : "border-line-strong bg-sunken",
      )}
      style={checked ? { background: color ?? "var(--accent)" } : undefined}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 600, damping: 34 }}
        className={cn("block size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)]", checked ? "ml-[18px]" : "ml-[2px]")}
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
              "pointer-events-none absolute left-1/2 -translate-x-1/2 z-50 w-max max-w-[260px] rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-[12px] leading-snug text-fg shadow-pop",
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

export function PageHeader({ title, sub, right, icon }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 mb-5 md:flex-row md:items-end md:justify-between md:gap-6 md:mb-6">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-[22px] font-semibold tracking-[-0.02em]">
          {icon}
          {title}
        </h1>
        {sub && <p className="text-[13.5px] text-muted mt-1">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2 max-w-full md:shrink-0">{right}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: "sm" | "md" }) {
  const id = useId();
  return (
    <div className={cn("inline-flex max-w-full scroll-x items-center rounded-lg border border-line bg-sunken p-0.5 max-sm:h-10", size === "sm" ? "h-7" : "h-8")}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative h-full shrink-0 px-2.5 rounded-md text-[12.5px] font-medium whitespace-nowrap transition-colors cursor-pointer inline-flex items-center gap-1.5",
            value === o.value ? "text-fg" : "text-faint hover:text-muted",
          )}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-md bg-panel border border-line shadow-soft" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
          )}
          <span className="relative inline-flex items-center gap-1.5">
            {o.label}
            {o.count !== undefined && <span className="text-faint tabular">{o.count}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

// On phones inputs are 40px tall and 16px text, so iOS doesn't zoom on focus.
const field = "w-full rounded-lg border border-line bg-sunken px-3 text-[13.5px] max-sm:text-[16px] text-fg placeholder:text-faint outline-none transition-colors focus:border-accent focus:bg-panel focus:ring-4 focus:ring-accent-soft";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, "h-9 max-sm:h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, "py-2 leading-relaxed resize-y", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, "h-9 max-sm:h-10 pr-8 appearance-none bg-no-repeat cursor-pointer", className)} style={{ backgroundImage: "linear-gradient(45deg, transparent 50%, var(--faint) 50%), linear-gradient(135deg, var(--faint) 50%, transparent 50%)", backgroundPosition: "calc(100% - 15px) 55%, calc(100% - 10px) 55%", backgroundSize: "5px 5px" }} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-muted mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-faint mt-1.5">{hint}</span>}
    </label>
  );
}

export function Stat({ label, value, tone, icon }: { label: string; value: ReactNode; tone?: "bad" | "warn" | "ok" | "accent"; icon?: ReactNode }) {
  const toneCls = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint whitespace-nowrap">
        {icon}
        {label}
      </div>
      <div className={cn("text-[22px] font-semibold tracking-[-0.02em] tabular mt-1", toneCls)}>{value}</div>
    </div>
  );
}
