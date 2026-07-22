import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "taxis:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the operating system or browser says right now. */
export function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The explicit choice, if one has been made. `null` means "whatever the system says". */
function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

function store(theme: Theme | null): void {
  try {
    if (theme == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* private browsing, or storage is full — the theme just won't survive a reload */ }
}

/** The stylesheet reads `data-theme` and nothing else, so this is the only place it is written
    outside the pre-paint script in index.html. */
function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * The resolved theme, plus a way to flip it.
 *
 * Until someone picks a side this tracks the system preference live — change it in the OS and the
 * page follows without a reload. Picking a side overrides that, and the override is dropped again
 * as soon as the system comes round to agreeing with it, so an override is a temporary departure
 * from the system default rather than a permanent one.
 */
export function useTheme(): { theme: Theme; following: boolean; toggle: () => void } {
  const [pref, setPref] = useState<Theme | null>(storedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // An override that now says the same thing as the system is not an override any more.
  const following = pref == null || pref === system;
  const theme = pref ?? system;

  useEffect(() => {
    apply(theme);
    if (following && pref != null) { store(null); setPref(null); }
  }, [theme, following, pref]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const override = next === system ? null : next;
    store(override);
    setPref(override);
  };

  return { theme, following, toggle };
}
