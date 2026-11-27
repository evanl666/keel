import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "keel-theme";

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const subs = new Set<(t: Theme) => void>();

export function setTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage may be blocked */
  }
  subs.forEach((s) => s(t));
}

export function toggleTheme() {
  setTheme(current() === "dark" ? "light" : "dark");
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
