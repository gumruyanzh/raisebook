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
 * - The most recent registration of a combo wins (a sheet's `j` beats the page's `j`).
 * - `blockedByModals` keeps app-wide keys quiet while a dialog or sheet is open.
 * - Every registration with a `description` is listed in the `?` sheet (`useHotkeyList`).
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

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
}

export interface HotkeyInfo {
  id: number;
  combo: string;
  description: string;
  group: string;
}

interface Step {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

interface Registration {
  id: number;
  combo: string;
  steps: Step[];
  handler: { current: (e: KeyboardEvent) => void };
  opts: HotkeyOptions;
}

const SEQUENCE_MS = 1000;

/* ---------- platform ---------- */

let appleCache: boolean | null = null;
export function isApple(): boolean {
  if (appleCache !== null) return appleCache;
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? navigator.platform ?? "";
  appleCache = /mac|iphone|ipad|ipod/i.test(p) || /Mac OS X/.test(navigator.userAgent);
  return appleCache;
}

/* ---------- parsing and matching ---------- */

const ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  plus: "+",
};

/** Symbols typed with Shift on common layouts: Shift is implied, never required. */
const SHIFTED = new Set(["?", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", '"', "<", ">", "~"]);

export function parseCombo(combo: string): Step[] {
  return combo
    .trim()
    .split(/\s+/)
    .map((part) => {
      // "mod++" → modifiers ["mod"], key "+"
      const tokens = part === "+" ? ["+"] : part.endsWith("++") ? [...part.slice(0, -2).split("+"), "+"] : part.split("+");
      const step: Step = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
      for (const raw of tokens) {
        const t = raw.toLowerCase();
        if (t === "mod") step.mod = true;
        else if (t === "ctrl" || t === "control") step.ctrl = true;
        else if (t === "meta" || t === "cmd") step.meta = true;
        else if (t === "alt" || t === "option") step.alt = true;
        else if (t === "shift") step.shift = true;
        else step.key = ALIASES[t] ?? t;
      }
      if (SHIFTED.has(step.key)) step.shift = false;
      return step;
    });
}

function eventKey(e: KeyboardEvent): string {
  // With Alt on macOS, e.key is a composed glyph ("∂"); use the physical key for letters/digits.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(e.code) && (e.altKey || e.metaKey || e.ctrlKey)) return e.code.slice(5);
  return e.key.toLowerCase();
}

export function matchStep(step: Step, e: KeyboardEvent): boolean {
  const apple = isApple();
  const wantMeta = step.meta || (step.mod && apple);
  const wantCtrl = step.ctrl || (step.mod && !apple);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== step.alt) return false;
  const key = eventKey(e);
  if (SHIFTED.has(step.key) || SHIFTED.has(e.key)) return key === step.key || e.key === step.key;
  if (e.shiftKey !== step.shift) return false;
  return key === step.key;
}

/* ---------- display ---------- */

const KEY_LABEL: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "Del",
  " ": "Space",
  tab: "Tab",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

/** Key caps for a combo: "mod+k" → ["⌘", "K"] on a Mac, ["Ctrl", "K"] elsewhere; "g p" → ["G", "then", "P"]. */
export function comboKeys(combo: string): string[] {
  const apple = isApple();
  const out: string[] = [];
  parseCombo(combo).forEach((s, i) => {
    if (i > 0) out.push("then");
    if (s.mod) out.push(apple ? "⌘" : "Ctrl");
    if (s.ctrl) out.push(apple ? "⌃" : "Ctrl");
    if (s.meta) out.push(apple ? "⌘" : "Win");
    if (s.alt) out.push(apple ? "⌥" : "Alt");
    if (s.shift) out.push(apple ? "⇧" : "Shift");
    out.push(KEY_LABEL[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key));
  });
  return out;
}

/** One-string label for a `title` or `aria-keyshortcuts`-style hint: "⌘K", "G then P", "?". */
export function comboLabel(combo: string): string {
  const apple = isApple();
  return comboKeys(combo).reduce((acc, k, i, all) => {
    if (k === "then") return `${acc} then `;
    const prev = all[i - 1];
    const glue = i === 0 || prev === "then" ? "" : apple ? "" : "+";
    return acc + glue + k;
  }, "");
}

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

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return el.getAttribute("role") === "combobox" || el.getAttribute("role") === "textbox";
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
    const hit = done[done.length - 1];
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
  const hit = single[single.length - 1];
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
  const { enabled = true, allowInInputs, description, group, blockedByModals, allowDefault } = opts;
  useEffect(() => {
    if (!enabled) return;
    install();
    const reg: Registration = {
      id: ++seq,
      combo,
      steps: parseCombo(combo),
      handler: ref,
      opts: { enabled, allowInInputs, description, group, blockedByModals, allowDefault },
    };
    regs.push(reg);
    emit();
    return () => {
      const i = regs.indexOf(reg);
      if (i >= 0) regs.splice(i, 1);
      emit();
    };
  }, [combo, enabled, allowInInputs, description, group, blockedByModals, allowDefault]);
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
