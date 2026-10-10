/**
 * Theme preference (SYSTEM 3.27). "system" leaves <html data-theme> unset so the CSS follows
 * prefers-color-scheme; "light"/"dark" set it explicitly. Stored in localStorage["rb-theme"].
 */
export type ThemePref = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "rb-theme";

/** Inline pre-paint script for <head>: applies the stored theme before first paint (no flash). */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;

export function readThemePref(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    if (pref === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts for this page view only */
  }
}
