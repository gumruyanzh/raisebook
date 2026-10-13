"use client";

/**
 * Commands for the ⌘K palette (UX-PASS-1 §2.4). Any component can contribute commands while
 * it is mounted:
 *
 *   useCommands("investor-sheet", open ? [
 *     { id: "sheet.move", label: `Move ${name} to…`, group: name, run: openMoveMenu },
 *   ] : null);
 *
 * Well-known ids the shell calls when present (else it falls back to a route):
 * - `investor.new`: open the page's "Add investor" dialog (the `c` key, "New investor").
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

export interface Command {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  /** Hotkey combo shown as a hint ("c", "mod+k", "g p"). Display only. */
  kbd?: string;
  run: () => void | Promise<void>;
}

const sources = new Map<string, Command[]>();
const order: string[] = [];
const listeners = new Set<() => void>();
let snapshot: Command[] = [];

function emit() {
  // Most recently registered source first: the open sheet's commands lead the list.
  const out: Command[] = [];
  const seen = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    for (const c of sources.get(order[i]!) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  snapshot = out;
  listeners.forEach((l) => l());
}

function setSource(id: string, cmds: Command[] | null) {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  if (cmds && cmds.length) {
    sources.set(id, cmds);
    order.push(id);
  } else sources.delete(id);
  emit();
}

/**
 * Contribute `commands` under `sourceId` while mounted; `null` withdraws them. The `run`
 * functions always call the latest render's closures, so the array may be rebuilt freely;
 * the registry only updates when the ids or labels change.
 */
export function useCommands(sourceId: string, commands: Command[] | null): void {
  const latest = useRef(commands);
  latest.current = commands;
  const sig = commands ? commands.map((c) => `${c.id}\u0001${c.label}\u0001${c.group}\u0001${c.kbd ?? ""}\u0001${(c.keywords ?? []).join(",")}`).join("\u0002") : null;
  useEffect(() => {
    if (sig === null) {
      setSource(sourceId, null);
      return;
    }
    const wrapped = (latest.current ?? []).map((c) => ({
      ...c,
      run: () => (latest.current?.find((x) => x.id === c.id) ?? c).run(),
    }));
    setSource(sourceId, wrapped);
    return () => setSource(sourceId, null);
  }, [sourceId, sig]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: Command[] = [];

/** Every registered command, most recent source first. */
export function useRegisteredCommands(): Command[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** A registered command by id, at call time (for hotkeys that defer to the page). */
export function findCommand(id: string): Command | undefined {
  return snapshot.find((c) => c.id === id);
}

/* ---------- ranking ---------- */

/** Lowercase and strip diacritics: "São Paulo" → "sao paulo". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Score a label against a query (higher is better, 0 = no match): exact > prefix > word
 * prefix > keyword > substring > in-order subsequence. Every query word must match.
 */
export function scoreText(label: string, query: string, keywords: string[] = []): number {
  const q = fold(query).trim();
  if (!q) return 1;
  const l = fold(label);
  const words = q.split(/\s+/);
  if (l === q) return 1000;
  if (l.startsWith(q)) return 900 - Math.min(l.length, 100) / 1000;
  const lw = l.split(/[\s·,./@()-]+/).filter(Boolean);
  if (words.every((w) => lw.some((x) => x.startsWith(w)))) return 800;
  const kws = keywords.map(fold);
  if (kws.some((k) => k === q)) return 700;
  if (kws.some((k) => k.startsWith(q))) return 600;
  if (words.every((w) => l.includes(w) || kws.some((k) => k.includes(w)))) return 500;
  let i = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    i = l.indexOf(ch, i);
    if (i < 0) return 0;
    i += 1;
  }
  return 100;
}

/** Ranked matches, stable for ties. */
export function rankBy<T>(items: T[], query: string, text: (t: T) => string, keywords?: (t: T) => string[]): T[] {
  if (!query.trim()) return items;
  return items
    .map((it, idx) => ({ it, idx, s: scoreText(text(it), query, keywords?.(it)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map((x) => x.it);
}

/** Query match ranges in `text` for highlighting (case- and diacritic-insensitive). */
export function matchRanges(text: string, query: string): [number, number][] {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const f = fold(text);
  const out: [number, number][] = [];
  for (const w of words) {
    const at = f.indexOf(w);
    if (at >= 0) out.push([at, at + w.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
