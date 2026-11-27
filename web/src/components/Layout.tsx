import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Inbox, ListChecks, Send, Activity, Stethoscope, ScrollText, Settings, Sun, Moon, Search, LogOut, Keyboard, ChevronsUpDown, Menu, X } from "lucide-react";
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
          "group relative flex items-center gap-2.5 h-10 lg:h-8 px-2.5 rounded-lg text-[13px] font-medium transition-colors",
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
            <button onClick={() => { setOpen(false); onHelp(); }} className="w-full flex items-center gap-2 h-10 lg:h-8 px-2.5 rounded-lg text-[13px] text-muted hover:text-fg hover:bg-hover cursor-pointer">
              <Keyboard className="size-3.5" /> Keyboard shortcuts <Kbd className="ml-auto touch:hidden">?</Kbd>
            </button>
            <button
              onClick={async () => {
                await api.logout().catch(() => {});
                await qc.invalidateQueries({ queryKey: ["me"] });
                nav("/login");
              }}
              className="w-full flex items-center gap-2 h-10 lg:h-8 px-2.5 rounded-lg text-[13px] text-muted hover:text-fg hover:bg-hover cursor-pointer"
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({ onSearch, onHelp, drawer, open, onClose }: { onSearch: () => void; onHelp: () => void; drawer: boolean; open: boolean; onClose: () => void }) {
  const { data: me } = useMe();
  const { data: teams } = useTeams();
  const { data: approvals } = useApprovals();
  const { data: ops } = useOperations();
  const { data: ov } = useOverview();
  const [theme] = useTheme();
  const ref = useRef<HTMLElement>(null);
  const needsReview = ops?.filter((o) => o.status === "needs_review").length ?? 0;

  // As a drawer (below lg): focus moves in on open, Tab stays inside, Escape closes.
  useEffect(() => {
    if (!drawer || !open) return;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []).filter((x) => x.offsetParent !== null);
    focusables()[0]?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el?.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !el?.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [drawer, open, onClose]);

  return (
    <aside
      ref={ref}
      id="sidebar"
      inert={drawer && !open}
      role={drawer && open ? "dialog" : undefined}
      aria-modal={drawer && open ? true : undefined}
      aria-label={drawer ? "Menu" : undefined}
      className={cn(
        "flex flex-col border-r border-line",
        "fixed inset-y-0 left-0 z-[80] w-[288px] max-w-[86vw] bg-panel shadow-pop overflow-y-auto overscroll-contain transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        open ? "translate-x-0" : "-translate-x-full",
        "lg:static lg:z-auto lg:w-[244px] lg:max-w-none lg:shrink-0 lg:h-full lg:translate-x-0 lg:overflow-visible lg:bg-panel/60 lg:backdrop-blur-xl lg:shadow-none lg:transition-none",
      )}
    >
      <div className="flex items-center gap-2.5 px-4 h-[60px] shrink-0">
        <KeelMark size={28} />
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold tracking-[-0.01em] leading-tight">Keel</div>
          <div className="text-[11.5px] text-faint leading-tight truncate">{me?.org?.name ?? "—"}</div>
        </div>
        {me?.demo && <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.08em] text-accent bg-accent-soft rounded px-1.5 py-0.5">Demo</span>}
        <button onClick={onClose} aria-label="Close menu" className={cn("lg:hidden grid place-items-center size-10 -mr-2 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer", !me?.demo && "ml-auto")}>
          <X className="size-[18px]" />
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={onSearch}
          className="w-full flex items-center gap-2 h-10 lg:h-8 px-2.5 rounded-lg border border-line bg-sunken text-[13px] text-faint hover:text-muted hover:border-line-strong transition-colors cursor-pointer"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search or jump…</span>
          <Kbd className="touch:hidden">{modKey === "⌘" ? "⌘" : "Ctrl"}</Kbd>
          <Kbd className="touch:hidden">K</Kbd>
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
      <nav className="px-3 space-y-0.5 lg:overflow-y-auto">
        {teams?.map((t) => (
          <NavLink
            key={t.slug}
            to={`/teams/${t.slug}`}
            className={({ isActive }) =>
              cn("group flex items-center gap-2.5 h-11 lg:h-9 px-2 rounded-lg text-[13px] transition-colors", isActive ? "bg-hover text-fg" : "text-muted hover:text-fg hover:bg-hover")
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
          className="w-full flex items-center gap-2.5 h-10 lg:h-8 px-2.5 rounded-lg text-[13px] font-medium text-muted hover:text-fg hover:bg-hover transition-colors cursor-pointer"
        >
          <span className="text-faint">{theme === "dark" ? <Moon className="size-[15px]" /> : <Sun className="size-[15px]" />}</span>
          <span className="flex-1 text-left">{theme === "dark" ? "Dark" : "Light"} theme</span>
          <Kbd className="touch:hidden">T</Kbd>
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

const DESKTOP = "(min-width: 1024px)";

function useIsDesktop() {
  const [m, setM] = useState(() => typeof window === "undefined" || window.matchMedia(DESKTOP).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const h = () => setM(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return m;
}

function TopBar({ onMenu, onSearch, menuOpen }: { onMenu: () => void; onSearch: () => void; menuOpen: boolean }) {
  const { data: me } = useMe();
  const { data: approvals } = useApprovals();
  const waiting = approvals?.length ?? 0;
  return (
    <header className="lg:hidden shrink-0 flex items-center gap-2 h-14 pl-2 pr-2 sm:pl-3 sm:pr-3 border-b border-line bg-panel/70 backdrop-blur-xl">
      <button
        onClick={onMenu}
        aria-label="Open menu"
        aria-controls="sidebar"
        aria-expanded={menuOpen}
        className="relative grid place-items-center size-10 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer"
      >
        <Menu className="size-5" />
        {waiting > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-accent ring-2 ring-panel" aria-label={`${waiting} waiting for approval`} />}
      </button>
      <NavLink to="/" className="flex items-center gap-2.5 min-w-0 rounded-lg pr-2">
        <KeelMark size={26} />
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold tracking-[-0.01em] leading-tight">Keel</span>
          <span className="block text-[11.5px] text-faint leading-tight truncate">{me?.org?.name ?? "—"}</span>
        </span>
      </NavLink>
      {me?.demo && <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent bg-accent-soft rounded px-1.5 py-0.5">Demo</span>}
      <button onClick={onSearch} aria-label="Search or jump" className="ml-auto grid place-items-center size-10 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer">
        <Search className="size-[18px]" />
      </button>
    </header>
  );
}

export function Layout() {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  const isDesktop = useIsDesktop();
  const drawer = !isDesktop;
  const nav = useNavigate();
  const loc = useLocation();
  const menuBtn = useRef<HTMLElement | null>(null);

  const closePalette = useCallback(() => setPalette(false), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  const closeMenu = useCallback(() => {
    setMenu(false);
    menuBtn.current?.focus();
    menuBtn.current = null;
  }, []);
  const openMenu = useCallback(() => {
    menuBtn.current = document.activeElement as HTMLElement | null;
    setMenu(true);
  }, []);
  const openPalette = useCallback(() => {
    setMenu(false);
    setPalette(true);
  }, []);
  const openHelp = useCallback(() => {
    setMenu(false);
    setHelp(true);
  }, []);

  useEffect(() => setMenu(false), [loc.pathname, loc.search]);
  useEffect(() => {
    if (isDesktop) setMenu(false);
  }, [isDesktop]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMenu(false);
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
    <div className="app-bg h-full flex flex-col lg:flex-row overflow-hidden">
      <TopBar onMenu={openMenu} onSearch={openPalette} menuOpen={menu} />
      <AnimatePresence>
        {drawer && menu && (
          <motion.div
            key="scrim"
            className="fixed inset-0 z-[79] bg-black/45 backdrop-blur-[2px] lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={closeMenu}
            aria-hidden
          />
        )}
      </AnimatePresence>
      <Sidebar onSearch={openPalette} onHelp={openHelp} drawer={drawer} open={menu} onClose={closeMenu} />
      <main className="flex-1 min-w-0 min-h-0 lg:h-full overflow-y-auto overflow-x-hidden" id="main">
        <motion.div
          key={pageKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto max-w-[1220px] px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-7"
        >
          <Outlet />
        </motion.div>
      </main>
      <CommandPalette open={palette} onClose={closePalette} />
      <ShortcutsHelp open={help} onClose={closeHelp} />
    </div>
  );
}
