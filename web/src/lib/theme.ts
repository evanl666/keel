import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "keel-theme";
const DARK = "(prefers-color-scheme: dark)";

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

const subs = new Set<(t: Theme) => void>();

function apply(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  subs.forEach((s) => s(t));
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage may be blocked */
  }
  apply(t);
}

export function toggleTheme() {
  setTheme(current() === "dark" ? "light" : "dark");
}

// Without a saved choice the app follows the system setting, live.
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia(DARK).addEventListener("change", (e) => {
    if (!stored()) apply(e.matches ? "dark" : "light");
  });
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(current);
  useEffect(() => {
    subs.add(setT);
    return () => {
      subs.delete(setT);
    };
  }, []);
  return [t, setTheme];
}
