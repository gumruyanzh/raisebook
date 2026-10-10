"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { applyThemePref, readThemePref, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * "Light · Dark · System" in micro mono (SYSTEM 3.27). Stores localStorage["rb-theme"] and sets
 * data-theme on <html>; the pre-paint script in app/layout.tsx prevents a flash.
 */
export function ThemeToggle({ className }: { className?: string }) {
  // Unknown until mounted, so server and client render the same markup.
  const [pref, setPref] = useState<ThemePref | null>(null);
  useEffect(() => setPref(readThemePref()), []);
  return (
    <div role="group" aria-label="Theme" className={cn("t-micro flex items-center text-muted", className)}>
      {OPTIONS.map((o, i) => (
        <span key={o.value} className="inline-flex items-center">
          {i > 0 ? <span aria-hidden className="px-4">·</span> : null}
          <button
            type="button"
            aria-pressed={pref === o.value}
            onClick={() => {
              applyThemePref(o.value);
              setPref(o.value);
            }}
            className={cn(
              "border-0 bg-transparent p-0 font-mono text-micro",
              pref === o.value ? "text-fg underline underline-offset-3" : "text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        </span>
      ))}
    </div>
  );
}
