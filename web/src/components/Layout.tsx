import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Inbox, ListChecks, Send, Activity, Stethoscope, Handshake, ScrollText, Settings, Sun, Moon, Search, LogOut, Keyboard, ChevronsUpDown, Menu, X, Users } from "lucide-react";
import { api } from "../api/client";
import { useApprovals, useMe, useOperations, useOverview, useTeams } from "../api/hooks";
import { toggleTheme, useTheme } from "../lib/theme";
import { cn, isTypingTarget, modKey } from "../lib/utils";
import { Avatar, HeaderSlot, Kbd, Tooltip } from "./ui";
import { KeelMark } from "./keel";
import { CommandPalette, ShortcutsHelp } from "./CommandPalette";

function NavItem({ to, icon, label, count, tone, end }: { to: string; icon: ReactNode; label: string; count?: number; tone?: "warn" | "bad" | "accent"; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2.5 h-10 nav:h-8 px-2.5 rounded-lg text-[14px] transition-colors",
          isActive ? "bg-hover text-fg font-medium" : "text-soft hover:text-fg hover:bg-hover",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn("[&>svg]:size-4 shrink-0", isActive ? "text-fg" : "text-muted group-hover:text-soft")}>{icon}</span>
          <span className="flex-1 truncate">{label}</span>
          {!!count && (
            <span className={cn("text-[12px] tabular", tone === "bad" ? "text-bad font-medium" : tone === "warn" ? "text-warn font-medium" : "text-muted")}>
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="px-2.5 mb-1 text-[12px] text-muted">{title}</div>
      <nav className="space-y-px" aria-label={title}>
        {children}
      </nav>
    </div>
  );
}

function UserMenu({ onHelp }: { onHelp: () => void }) {
  const { data: me } = useMe();
  const [theme] = useTheme();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
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
  }, [open]);
  const u = me?.user;
  if (!u) return null;
  const item = "w-full flex items-center gap-2.5 h-10 nav:h-8 px-2.5 rounded-lg text-[14px] text-soft hover:text-fg hover:bg-hover cursor-pointer";
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-2.5 h-11 px-2 rounded-lg hover:bg-hover transition-colors cursor-pointer text-left">
        <Avatar name={u.name} url={u.avatar_url} size={28} className="bg-panel border border-line" />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium leading-tight truncate">{u.name}</span>
          <span className="block text-[12px] text-muted leading-tight truncate">{u.email}</span>
        </span>
        <ChevronsUpDown className="size-3.5 text-muted" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full mb-2 left-0 right-0 rounded-xl border border-line bg-panel shadow-pop p-1 z-50"
          >
            <div className="px-2.5 py-2 text-[12px] text-muted">
              {me?.org?.name} · {u.role === "org_admin" ? "Admin" : u.role === "team_admin" ? "Team admin" : "Member"} · v{me?.version}
            </div>
            <button onClick={toggleTheme} className={item}>
              {theme === "dark" ? <Moon className="size-4 text-muted" /> : <Sun className="size-4 text-muted" />}
              <span className="flex-1 text-left">{theme === "dark" ? "Dark" : "Light"} theme</span>
              <Kbd className="touch:hidden">T</Kbd>
            </button>
            <button onClick={() => { setOpen(false); onHelp(); }} className={item}>
              <Keyboard className="size-4 text-muted" /> <span className="flex-1 text-left">Keyboard shortcuts</span> <Kbd className="touch:hidden">?</Kbd>
            </button>
            <div className="my-1 border-t border-line" />
            <button
              onClick={async () => {
                await api.logout().catch(() => {});
                await qc.invalidateQueries({ queryKey: ["me"] });
                nav("/login");
              }}
              className={item}
            >
              <LogOut className="size-4 text-muted" /> Sign out
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
  const ref = useRef<HTMLElement>(null);
  const needsReview = ops?.filter((o) => o.status === "needs_review").length ?? 0;
  const admin = me?.user?.role === "org_admin";

  // As a drawer (narrow screens): focus moves in on open, Tab stays inside, Escape closes.
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
        "flex flex-col bg-side border-r border-line",
        "fixed inset-y-0 left-0 z-[80] w-[280px] max-w-[86vw] shadow-pop transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        open ? "translate-x-0" : "-translate-x-full",
        "nav:static nav:z-auto nav:w-[252px] nav:max-w-none nav:shrink-0 nav:h-full nav:translate-x-0 nav:shadow-none nav:transition-none",
      )}
    >
      <div className="flex items-center gap-2.5 px-4 h-16 shrink-0">
        <NavLink to="/" className="flex items-center gap-2.5 min-w-0 flex-1 rounded-lg">
          <KeelMark size={24} />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold tracking-[-0.01em] leading-tight">Keel</span>
            <span className="block text-[12px] text-muted leading-tight truncate">{me?.org?.name ?? "—"}</span>
          </span>
        </NavLink>
        <button onClick={onClose} aria-label="Close menu" className="nav:hidden grid place-items-center size-10 -mr-2 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer">
          <X className="size-[18px]" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-3">
        <button
          onClick={onSearch}
          className="w-full flex items-center gap-2.5 h-10 nav:h-8 px-2.5 rounded-lg text-[14px] text-muted hover:text-fg hover:bg-hover transition-colors cursor-pointer"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <span className="text-[12px] text-muted touch:hidden">{modKey === "⌘" ? "⌘K" : "Ctrl K"}</span>
        </button>

        <Group title="Workspace">
          <NavItem to="/" end icon={<LayoutGrid />} label="Overview" />
          <NavItem to="/approvals" icon={<Inbox />} label="Approvals" count={approvals?.length} />
          <NavItem to="/ledger" icon={<ListChecks />} label="Ledger" />
          <NavItem to="/operations" icon={<Send />} label="Outbox" count={needsReview} tone="warn" />
          <NavItem to="/services" icon={<Activity />} label="Services" count={ov?.totals.incidents_open} tone="bad" />
          <NavItem to="/checkup" icon={<Stethoscope />} label="Checkup" />
          <NavItem to="/promises" icon={<Handshake />} label="Promises" />
        </Group>

        <Group title="Teams">
          {teams?.map((t) => {
            const flagged = t.counts.at_risk + t.counts.overdue;
            return (
              <NavLink
                key={t.slug}
                to={`/teams/${t.slug}`}
                title={`${t.steward.name}${t.steward.paused ? " · paused" : ` · L${t.steward.level}`}`}
                className={({ isActive }) =>
                  cn("group flex items-center gap-2.5 h-10 nav:h-8 px-2.5 rounded-lg text-[14px] transition-colors", isActive ? "bg-hover text-fg font-medium" : "text-soft hover:text-fg hover:bg-hover")
                }
              >
                <span className="size-2 rounded-full shrink-0" style={{ background: t.color }} />
                <span className="flex-1 truncate">{t.name}</span>
                <span className={cn("text-[14px] leading-none", t.steward.paused && "grayscale opacity-50")} aria-hidden>
                  {t.steward.emoji}
                </span>
                {flagged > 0 && (
                  <Tooltip content={`${t.counts.at_risk} at risk, ${t.counts.overdue} overdue`}>
                    <span className="text-[12px] tabular text-muted min-w-3 text-right">{flagged}</span>
                  </Tooltip>
                )}
              </NavLink>
            );
          })}
        </Group>

        <Group title={admin ? "Admin" : "Records"}>
          {admin && <NavItem to="/people" icon={<Users />} label="People" />}
          <NavItem to="/audit" icon={<ScrollText />} label="Audit log" />
          {admin && <NavItem to="/setup" icon={<Settings />} label="Setup" />}
        </Group>
      </div>

      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-line">
        {me?.demo && (
          <div className="px-2.5 pt-1 pb-2 text-[12px] text-muted leading-snug">
            <span className="font-medium text-soft">Demo workspace.</span> Sample teams and data; nothing is sent.
          </div>
        )}
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

const DESKTOP = "(min-width: 900px)";

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
    <header className="nav:hidden shrink-0 flex items-center gap-2 h-14 px-2 sm:px-3 border-b border-line bg-side">
      <button
        onClick={onMenu}
        aria-label="Open menu"
        aria-controls="sidebar"
        aria-expanded={menuOpen}
        className="relative grid place-items-center size-10 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer"
      >
        <Menu className="size-5" />
        {waiting > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-accent ring-2 ring-side" aria-label={`${waiting} waiting for approval`} />}
      </button>
      <NavLink to="/" className="flex items-center gap-2.5 min-w-0 rounded-lg pr-2">
        <KeelMark size={24} />
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold tracking-[-0.01em] leading-tight">Keel</span>
          <span className="block text-[12px] text-muted leading-tight truncate">{me?.org?.name ?? "—"}</span>
        </span>
      </NavLink>
      <button onClick={onSearch} aria-label="Search or jump" className="ml-auto grid place-items-center size-10 rounded-lg text-muted hover:text-fg hover:bg-hover cursor-pointer">
        <Search className="size-[18px]" />
      </button>
    </header>
  );
}

/** Pages that need more room (the board) ask for it. */
const WideCtx = createContext<(wide: boolean) => void>(() => {});
export function useWidePage(wide = true) {
  const set = useContext(WideCtx);
  useEffect(() => {
    set(wide);
    return () => set(false);
  }, [set, wide]);
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
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(false);

  return (
    <div className="app-bg h-full flex flex-col nav:flex-row overflow-hidden">
      <TopBar onMenu={openMenu} onSearch={openPalette} menuOpen={menu} />
      <AnimatePresence>
        {drawer && menu && (
          <motion.div
            key="scrim"
            className="fixed inset-0 z-[79] bg-black/30 dark:bg-black/55 nav:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={closeMenu}
            aria-hidden
          />
        )}
      </AnimatePresence>
      <Sidebar onSearch={openPalette} onHelp={openHelp} drawer={drawer} open={menu} onClose={closeMenu} />
      <main className="flex-1 min-w-0 min-h-0 nav:h-full overflow-y-auto overflow-x-hidden" id="main">
        <div ref={setSlot} className="sticky top-0 z-30 bg-bg border-b border-line empty:hidden" />
        <HeaderSlot.Provider value={slot}>
          <WideCtx.Provider value={setWide}>
            <motion.div
              key={pageKey}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className={cn("mx-auto px-4 py-6 sm:px-6 nav:px-8 nav:py-8", wide ? "max-w-[1280px]" : "max-w-[960px]")}
            >
              {slot && <Outlet />}
            </motion.div>
          </WideCtx.Provider>
        </HeaderSlot.Provider>
      </main>
      <CommandPalette open={palette} onClose={closePalette} />
      <ShortcutsHelp open={help} onClose={closeHelp} />
    </div>
  );
}
