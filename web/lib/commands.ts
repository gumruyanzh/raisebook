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

export { fold, matchRanges, rankBy, scoreText } from "./match";
