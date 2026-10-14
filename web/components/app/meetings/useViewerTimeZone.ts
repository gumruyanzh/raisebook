"use client";

import { useEffect, useState } from "react";

import { viewerTimeZone } from "@/lib/meetings";

/**
 * The viewer's timezone for showing meeting times. The server render (and the first client
 * render) use `fallback` (the workspace timezone) so hydration matches; the browser's zone
 * takes over after mount.
 */
export function useViewerTimeZone(fallback: string): string {
  const [tz, setTz] = useState(fallback);
  useEffect(() => setTz(viewerTimeZone()), []);
  return tz;
}

/** A clock that ticks every `ms` (meetings move from "today" to "needs an outcome"). */
export function useNow(ms = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
