/**
 * Pure keyboard helpers (no React): parse and match hotkey combos, render key caps, and tell
 * whether an event target is a text field. `lib/hotkeys.ts` builds the registry on these.
 */

export interface Step {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

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

export function isTypingTarget(el: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return el.getAttribute("role") === "combobox" || el.getAttribute("role") === "textbox";
}
