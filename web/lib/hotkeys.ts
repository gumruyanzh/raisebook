"use client";

/**
 * Keyboard shortcuts (UX-PASS-1 §2.4). One document listener serves every registration.
 *
 *   useHotkey("mod+k", openPalette, { allowInInputs: true, description: "Command palette", group: "General" });
 *   useHotkey("g p", goPipeline, { description: "Go to pipeline", group: "Navigation" });
 *
 * Combos: modifiers `mod` (⌘ on Apple platforms, Ctrl elsewhere), `ctrl`, `meta`, `alt`,
 * `shift`, joined with `+`; a space separates the steps of a sequence ("g p", one second
 * apart at most). Keys are `KeyboardEvent.key` values, case-insensitive for letters
 * ("k", "/", "?", "enter", "escape", "arrowdown", "1"). Shift is implied for symbols typed
 * with it, so "?" and "shift+?" are the same combo.
 *
 * Rules:
 * - Hotkeys never fire while focus is in an input, textarea, select or contenteditable, unless
 *   `allowInInputs` is set. They also stay out of open menus and listboxes (typeahead).
 * - The most recent registration of a combo wins (a sheet's `j` beats the page's `j`), unless
 *   another one has a higher `priority` (sheets set 1, so a deep-linked sheet still wins).
 * - `blockedByModals` keeps app-wide keys quiet while a dialog or sheet is open.
 * - Every registration with a `description` is listed in the `?` sheet (`useHotkeyList`).
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

import { isTypingTarget, matchStep, parseCombo, type Step } from "./keys";

export { comboKeys, comboLabel, isApple, isTypingTarget, matchStep, parseCombo } from "./keys";

export interface HotkeyOptions {
  enabled?: boolean;
  allowInInputs?: boolean;
  description?: string;
  /** Section in the `?` sheet ("General", "Navigation", "Pipeline", "Today"). */
  group?: string;
  /** Skip while a modal dialog or sheet is open (app-wide shortcuts set this). */
  blockedByModals?: boolean;
  /** Keep the browser default (the handler still runs). Default: prevented. */
  allowDefault?: boolean;
  /**
   * Higher wins over the registration order. A sheet or panel sets 1 so its keys beat the
   * page's even when both mount together (a deep-linked sheet registers before its parent).
   */
  priority?: number;
}

export interface HotkeyInfo {
  id: number;
  combo: string;
  description: string;
  group: string;
}

interface Registration {
  id: number;
  combo: string;
  steps: Step[];
  handler: { current: (e: KeyboardEvent) => void };
  opts: HotkeyOptions;
}

const SEQUENCE_MS = 1000;

/* ---------- registry ---------- */

let seq = 0;
const regs: Registration[] = [];
const listeners = new Set<() => void>();
let snapshot: HotkeyInfo[] = [];
let pending: { regs: Registration[]; depth: number; at: number } | null = null;
let installed = false;

function emit() {
  const seen = new Set<string>();
  const list: HotkeyInfo[] = [];
  // Latest registration first, so the live description of a combo wins.
  for (let i = regs.length - 1; i >= 0; i--) {
    const r = regs[i]!;
    if (!r.opts.description || r.opts.enabled === false) continue;
    const key = `${r.opts.group ?? "General"}|${r.combo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ id: r.id, combo: r.combo, description: r.opts.description, group: r.opts.group ?? "General" });
  }
  snapshot = list.reverse();
  listeners.forEach((l) => l());
}

/** A modal dialog (native or `aria-modal`) is open. */
export function modalOpen(): boolean {
  if (typeof document === "undefined") return false;
  for (const d of Array.from(document.querySelectorAll("dialog[open]"))) {
    try {
      if (d.matches(":modal")) return true;
    } catch {
      return true;
    }
  }
  return Boolean(document.querySelector('[aria-modal="true"]'));
}

function eligible(r: Registration, typing: boolean, inPopup: boolean, modal: boolean): boolean {
  if (r.opts.enabled === false) return false;
  if ((typing || inPopup) && !r.opts.allowInInputs) return false;
  if (modal && r.opts.blockedByModals) return false;
  return true;
}

/** The highest priority registration; among equals the most recent one. */
function top(list: Registration[]): Registration | undefined {
  let best: Registration | undefined;
  for (const r of list) if (!best || (r.opts.priority ?? 0) >= (best.opts.priority ?? 0)) best = r;
  return best;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.key === "Process") return;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
  const target = e.target;
  const typing = isTypingTarget(target);
  const inPopup = target instanceof Element && Boolean(target.closest('[role="menu"],[role="listbox"]'));
  const modal = modalOpen();
  const now = Date.now();

  // Continue a pending sequence ("g" was pressed; now "p").
  if (pending && now - pending.at <= SEQUENCE_MS) {
    const { depth } = pending;
    const next = pending.regs.filter((r) => r.steps[depth] && matchStep(r.steps[depth]!, e));
    pending = null;
    const done = next.filter((r) => r.steps.length === depth + 1);
    const hit = top(done);
    if (hit) {
      if (!hit.opts.allowDefault) e.preventDefault();
      hit.handler.current(e);
      return;
    }
    if (next.length) {
      pending = { regs: next, depth: depth + 1, at: now };
      e.preventDefault();
      return;
    }
  }
  pending = null;

  const candidates = regs.filter((r) => eligible(r, typing, inPopup, modal) && matchStep(r.steps[0]!, e));
  if (!candidates.length) return;
  const single = candidates.filter((r) => r.steps.length === 1);
  const seqs = candidates.filter((r) => r.steps.length > 1);
  const hit = top(single);
  if (hit) {
    if (!hit.opts.allowDefault) e.preventDefault();
    hit.handler.current(e);
    return;
  }
  if (seqs.length) pending = { regs: seqs, depth: 1, at: now };
}

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("keydown", onKeyDown);
}

/** Register a hotkey for the lifetime of the calling component. */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, opts: HotkeyOptions = {}): void {
  const ref = useRef(handler);
  ref.current = handler;
  const { enabled = true, allowInInputs, description, group, blockedByModals, allowDefault, priority } = opts;
  useEffect(() => {
    if (!enabled) return;
    install();
    const reg: Registration = {
      id: ++seq,
      combo,
      steps: parseCombo(combo),
      handler: ref,
      opts: { enabled, allowInInputs, description, group, blockedByModals, allowDefault, priority },
    };
    regs.push(reg);
    emit();
    return () => {
      const i = regs.indexOf(reg);
      if (i >= 0) regs.splice(i, 1);
      emit();
    };
  }, [combo, enabled, allowInInputs, description, group, blockedByModals, allowDefault, priority]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: HotkeyInfo[] = [];

/** Every described hotkey that is live right now, for the `?` sheet. */
export function useHotkeyList(): HotkeyInfo[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
