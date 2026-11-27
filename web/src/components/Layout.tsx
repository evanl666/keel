import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Inbox, ListChecks, Send, Activity, Stethoscope, ScrollText, Settings, Sun, Moon, Search, LogOut, Keyboard, ChevronsUpDown } from "lucide-react";
import { api } from "../api/client";
import { useApprovals, useMe, useOperations, useOverview, useTeams } from "../api/hooks";
import { toggleTheme, useTheme } from "../lib/theme";
import { cn, isTypingTarget, modKey } from "../lib/utils";
import { Kbd, Tooltip } from "./ui";
import { KeelMark, StewardAvatar } from "./keel";
import { CommandPalette, ShortcutsHelp } from "./CommandPalette";

function NavItem({ to, icon, label, count, tone, end }: { to: string; icon: ReactNode; label: string; count?: number; tone?: "warn" | "bad" | "accent"; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] font-medium transition-colors",
          isActive ? "text-fg" : "text-muted hover:text-fg hover:bg-hover",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-hover border border-line shadow-soft" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          <span className={cn("relative [&>svg]:size-[15px]", isActive ? "text-fg" : "text-faint group-hover:text-muted")}>{icon}</span>
          <span className="relative flex-1">{label}</span>
          {!!count && (
            <span
              className={cn(
                "relative min-w-[20px] h-[18px] px-1.5 rounded-full text-[11px] font-semibold grid place-items-center tabular",
                tone === "bad" ? "bg-bad/15 text-bad" : tone === "warn" ? "bg-(--t-orange)/15 text-(--t-orange)" : "bg-accent text-accent-fg",
              )}
            >
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function UserMenu({ onHelp }: { onHelp: () => void }) {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const u = me?.user;
  if (!u) return null;
  const initials = u.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2.5 h-11 px-2 rounded-lg hover:bg-hover transition-colors cursor-pointer text-left">
        {u.avatar_url ? (
          <img src={u.avatar_url} alt="" className="size-7 rounded-full" />
        ) : (
          <span className="grid size-7 place-items-center rounded-full bg-gradient-to-br from-[#8b9bff] to-[#5b6cff] text-[11px] font-semibold text-white">{initials}</span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium truncate">{u.name}</span>
          <span className="block text-[11.5px] text-faint truncate">{u.email}</span>
        </span>
        <ChevronsUpDown className="size-3.5 text-faint" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-full mb-2 left-0 right-0 rounded-xl border border-line-strong bg-panel shadow-pop p-1 z-50"
          >
            <div className="px-2.5 py-2 text-[12px] text-faint">
              {me?.org?.name} · {u.role.replace("_", " ")} · v{me?.version}
            </div>
            <button onClick={() => { setOpen(false); onHelp(); }} className="w-full flex items-center gap-2 h-8 px-2.5 rounded-lg text-[13px] text-muted hover:text-fg hover:bg-hover cursor-pointer">
              <Keyboard className="size-3.5" /> Keyboard shortcuts <Kbd className="ml-auto">?</Kbd>
            </button>
            <button
              onClick={async () => {
                await api.logout().catch(() => {});
                await qc.invalidateQueries({ queryKey: ["me"] });
                nav("/login");
              }}
              className="w-full flex items-center gap-2 h-8 px-2.5 rounded-lg text-[13px] text-muted hover:text-fg hover:bg-hover cursor-pointer"
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({ onSearch, onHelp }: { onSearch: () => void; onHelp: () => void }) {
  const { data: me } = useMe();
  const { data: teams } = useTeams();
  const { data: approvals } = useApprovals();
  const { data: ops } = useOperations();
  const { data: ov } = useOverview();
  const [theme] = useTheme();
  const needsReview = ops?.filter((o) => o.status === "needs_review").length ?? 0;
  return (
    <aside className="w-[244px] shrink-0 h-full flex flex-col border-r border-line bg-panel/60 backdrop-blur-xl">
      <div className="flex items-center gap-2.5 px-4 h-[60px]">
        <KeelMark size={28} />
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold tracking-[-0.01em] leading-tight">Keel</div>
          <div className="text-[11.5px] text-faint leading-tight truncate">{me?.org?.name ?? "—"}</div>
        </div>
        {me?.demo && <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.08em] text-accent bg-accent-soft rounded px-1.5 py-0.5">Demo</span>}
      </div>

      <div className="px-3">
        <button
          onClick={onSearch}
          className="w-full flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-sunken text-[13px] text-faint hover:text-muted hover:border-line-strong transition-colors cursor-pointer"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search or jump…</span>
          <Kbd>{modKey === "⌘" ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>

      <nav className="px-3 mt-4 space-y-0.5">
        <NavItem to="/" end icon={<LayoutGrid />} label="Overview" />
        <NavItem to="/approvals" icon={<Inbox />} label="Approvals" count={approvals?.length} tone="accent" />
        <NavItem to="/ledger" icon={<ListChecks />} label="Ledger" />
        <NavItem to="/operations" icon={<Send />} label="Outbox" count={needsReview} tone="warn" />
        <NavItem to="/services" icon={<Activity />} label="Services" count={ov?.totals.incidents_open} tone="bad" />
        <NavItem to="/checkup" icon={<Stethoscope />} label="Checkup" />
        <NavItem to="/audit" icon={<ScrollText />} label="Audit log" />
      </nav>

      <div className="px-5 mt-6 mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Teams</div>
      <nav className="px-3 space-y-0.5 overflow-y-auto">
        {teams?.map((t) => (
          <NavLink
            key={t.slug}
            to={`/teams/${t.slug}`}
            className={({ isActive }) =>
              cn("group flex items-center gap-2.5 h-9 px-2 rounded-lg text-[13px] transition-colors", isActive ? "bg-hover text-fg" : "text-muted hover:text-fg hover:bg-hover")
            }
          >
            <StewardAvatar emoji={t.steward.emoji} color={t.color} paused={t.steward.paused} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium leading-tight truncate">{t.name}</span>
              <span className="block text-[11px] text-faint leading-tight truncate">
                {t.steward.name}
                {t.steward.paused ? " · paused" : ` · L${t.steward.level}`}
              </span>
            </span>
            {t.counts.at_risk + t.counts.overdue > 0 && (
              <Tooltip content={`${t.counts.at_risk} at risk, ${t.counts.overdue} overdue`}>
                <span className="grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-semibold tabular text-warn bg-warn/12">{t.counts.at_risk + t.counts.overdue}</span>
              </Tooltip>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto px-3 pb-3 pt-3 space-y-0.5">
        <NavItem to="/setup" icon={<Settings />} label="Setup" />
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] font-medium text-muted hover:text-fg hover:bg-hover transition-colors cursor-pointer"
        >
          <span className="text-faint">{theme === "dark" ? <Moon className="size-[15px]" /> : <Sun className="size-[15px]" />}</span>
          <span className="flex-1 text-left">{theme === "dark" ? "Dark" : "Light"} theme</span>
          <Kbd>T</Kbd>
        </button>
        <div className="border-t border-line my-2" />
        <UserMenu onHelp={onHelp} />
      </div>
    </aside>
  );
}

let lastG = 0;
const gPending = () => Date.now() - lastG < 1200;

export function useHotkeys(handlers: Record<string, () => void>, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog]") || gPending()) return;
      const fn = ref.current[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [enabled]);
}

export function Layout() {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  const closePalette = useCallback(() => setPalette(false), []);
  const closeHelp = useCallback(() => setHelp(false), []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      const k = e.key.toLowerCase();
      if (gPending()) {
        lastG = 0;
        e.stopImmediatePropagation();
        const to = { o: "/", a: "/approvals", l: "/ledger", p: "/operations", s: "/services", c: "/checkup", d: "/audit" }[k];
        if (to) {
          e.preventDefault();
          nav(to);
        }
        return;
      }
      if (k === "g") lastG = Date.now();
      else if (e.key === "?") setHelp(true);
      else if (k === "t") toggleTheme();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [nav]);

  const pageKey = loc.pathname.split("/").slice(0, 3).join("/");

  return (
    <div className="app-bg h-full flex overflow-hidden">
      <Sidebar onSearch={() => setPalette(true)} onHelp={() => setHelp(true)} />
      <main className="flex-1 min-w-0 h-full overflow-y-auto" id="main">
        <motion.div
          key={pageKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto max-w-[1220px] px-8 py-7"
        >
          <Outlet />
        </motion.div>
      </main>
      <CommandPalette open={palette} onClose={closePalette} />
      <ShortcutsHelp open={help} onClose={closeHelp} />
    </div>
  );
}
