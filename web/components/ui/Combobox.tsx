"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/cn";
import { matchRanges, rankOptions } from "@/lib/rank";

export { rankOptions };

/* =====================================================================================
   Combobox (UX pass 1, P0-1): a searchable single-select. The trigger looks like a Select;
   the popover holds a search input (role=combobox, ARIA 1.2) over a role=listbox. Sync
   (`options`) or async (`loadOptions`) sources, ranked diacritic-insensitive matching,
   windowed rendering past 60 rows, and a full-screen sheet under 640px.
   ===================================================================================== */

export interface ComboboxOption<V = string> {
  value: V;
  /** Primary text; matched and highlighted. */
  label: string;
  /** Muted text after the label. */
  description?: ReactNode;
  /** Right-aligned (a mono offset, a symbol, a count, a Kbd). */
  hint?: ReactNode;
  /** Extra match terms (aliases, countries, abbreviations). */
  keywords?: string[];
  /** Section label ("Suggested", "Contact", "In Seed"). */
  group?: string;
  disabled?: boolean;
}

export interface ComboboxRenderState {
  query: string;
  active: boolean;
  selected: boolean;
}

export interface ComboboxProps<V = string> {
  value: V | null;
  onChange: (value: V | null, option: ComboboxOption<V> | null) => void;
  /** Sync source, or… */
  options?: ComboboxOption<V>[];
  /** …async source. Debounced; stale requests are aborted and never overwrite newer ones. */
  loadOptions?: (query: string, signal: AbortSignal) => Promise<ComboboxOption<V>[]>;
  /** Default: `rankOptions` (ranked, diacritic-insensitive). */
  filter?: (options: ComboboxOption<V>[], query: string) => ComboboxOption<V>[];
  /** Shown above the results while the query is empty. */
  pinned?: ComboboxOption<V>[];
  /** Trigger content. */
  renderValue?: (option: ComboboxOption<V> | null) => ReactNode;
  /** Row content (default: highlighted label, muted description, hint on the right). */
  renderOption?: (option: ComboboxOption<V>, state: ComboboxRenderState) => ReactNode;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: (query: string) => ReactNode;
  clearable?: boolean;
  disabled?: boolean;
  /** 28 / 32px trigger. */
  size?: "sm" | "md";
  /** `form` (canvas, inside forms and sheets, the default) or `toolbar` (surface). */
  tone?: "form" | "toolbar";
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Async only, default 150. */
  debounceMs?: number;
  /** Default 200; rows are windowed past 60. */
  maxResults?: number;
  /** Default true: under 640px the popover opens full screen with the search on top. */
  fullScreenOnMobile?: boolean;
  /** Called when the popover opens (e.g. to load data lazily). */
  onOpen?: () => void;
  /** Minimum popover width in px (default 320); it is never narrower than the trigger. */
  popoverMinWidth?: number;
  className?: string;
}

/* ---------------------------------------------------------------- shared popover plumbing */

const MOBILE_QUERY = "(max-width: 639.98px)";

function useIsMobile(enabled: boolean): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [enabled]);
  return enabled && mobile;
}

export interface AnchoredPlacement {
  style: CSSProperties;
  /** Height available to the popover's content (px). */
  maxHeight: number;
  /** The popover is a full-screen sheet (phones). */
  sheet: boolean;
}

/**
 * Fixed positioning next to `anchor` (so scroll containers and dialogs never clip it): below
 * when there is room, else above; at least `minWidth` wide and never past the viewport. On
 * phones (`fullScreen`) it fills the visual viewport, so the on-screen keyboard never covers it.
 * Exported for DateField.
 */
export function useAnchoredPopover(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  { minWidth = 320, maxHeight = 380, fullScreen = true }: { minWidth?: number; maxHeight?: number; fullScreen?: boolean } = {},
): AnchoredPlacement | null {
  const sheet = useIsMobile(fullScreen);
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const vv = window.visualViewport;
      const vh = vv?.height ?? window.innerHeight;
      const vw = document.documentElement.clientWidth;
      if (sheet) {
        const top = vv?.offsetTop ?? 0;
        setPlacement({ sheet: true, maxHeight: vh, style: { top, left: 0, width: vw, height: vh } });
        return;
      }
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, minWidth), vw - 16);
      const left = Math.max(8, Math.min(r.left, vw - width - 8));
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      if (below >= Math.min(maxHeight, 260) || below >= above) {
        setPlacement({ sheet: false, maxHeight: Math.min(maxHeight, Math.max(160, below)), style: { top: r.bottom + 4, left, width } });
      } else {
        setPlacement({ sheet: false, maxHeight: Math.min(maxHeight, above), style: { bottom: window.innerHeight - r.top + 4, left, width } });
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, sheet, anchor, minWidth, maxHeight]);
  return placement;
}

/** Closes on a pointer down outside every element in `refs`. */
export function useDismissOnOutsidePointer(
  open: boolean,
  refs: RefObject<HTMLElement | null>[],
  onDismiss: () => void,
) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      cb.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/* ---------------------------------------------------------------- highlight */

/** `text` with the characters matching `query` in weight 600 (no color change). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = query ? matchRanges(text, query) : [];
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <b key={i} className="font-semibold">
        {text.slice(s, e)}
      </b>,
    );
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/* ---------------------------------------------------------------- rows */

const OPTION_H = 32;
const GROUP_H = 28;
const WINDOW_AFTER = 60;
const OVERSCAN = 8;

type Row<V> =
  | { kind: "group"; key: string; label: string }
  | { kind: "option"; key: string; option: ComboboxOption<V>; pos: number };

function buildRows<V>(lists: ComboboxOption<V>[][]): { rows: Row<V>[]; optionRows: number[] } {
  const rows: Row<V>[] = [];
  const optionRows: number[] = [];
  let group: string | undefined;
  let n = 0;
  for (const list of lists) {
    for (const o of list) {
      if (o.group && o.group !== group) rows.push({ kind: "group", key: `g${rows.length}`, label: o.group });
      group = o.group;
      optionRows.push(rows.length);
      rows.push({ kind: "option", key: `o${rows.length}`, option: o, pos: n++ });
    }
  }
  return { rows, optionRows };
}

function sameValue<V>(a: V | null, b: V | null): boolean {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
}

/* ---------------------------------------------------------------- component */

const TRIGGER_TONE = {
  form: "border-line bg-canvas hover:border-muted",
  toolbar: "border-line bg-surface hover:border-muted",
} as const;

export function Combobox<V = string>({
  value,
  onChange,
  options,
  loadOptions,
  filter,
  pinned,
  renderValue,
  renderOption,
  placeholder = "Choose…",
  searchPlaceholder = "Search…",
  emptyText,
  clearable,
  disabled,
  size = "md",
  tone = "form",
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  debounceMs = 150,
  maxResults = 200,
  fullScreenOnMobile = true,
  onOpen,
  popoverMinWidth = 320,
  className,
}: ComboboxProps<V>) {
  const auto = useId();
  const triggerId = id ?? `cb${auto}`;
  const listId = `${triggerId}-list`;
  const inputId = `${triggerId}-search`;
  const valueId = `${triggerId}-value`;
  const ownLabelId = `${triggerId}-own-label`;

  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const placement = useAnchoredPopover(wrap, open, { fullScreen: fullScreenOnMobile, minWidth: popoverMinWidth });
  const sheet = placement?.sheet ?? false;

  // The last option the user picked (async sources may not list it again).
  const picked = useRef<ComboboxOption<V> | null>(null);

  /* ---- async ---- */
  const [asyncState, setAsyncState] = useState<{
    status: "idle" | "loading" | "done" | "error";
    query: string;
    items: ComboboxOption<V>[];
  }>({ status: "idle", query: "", items: [] });
  const reqId = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || !loadOptions) return;
    const my = ++reqId.current;
    setAsyncState((s) => ({ status: "loading", query, items: s.query === query ? s.items : [] }));
    const t = setTimeout(
      () => {
        ctrl.current?.abort();
        const c = new AbortController();
        ctrl.current = c;
        loadOptions(query, c.signal).then(
          (items) => {
            if (my === reqId.current && !c.signal.aborted) setAsyncState({ status: "done", query, items });
          },
          () => {
            if (my === reqId.current && !c.signal.aborted) setAsyncState({ status: "error", query, items: [] });
          },
        );
      },
      query ? debounceMs : 0,
    );
    return () => clearTimeout(t);
  }, [open, query, loadOptions, debounceMs, retry]);

  useEffect(() => () => ctrl.current?.abort(), []);

  /* ---- results ---- */
  const results = useMemo<ComboboxOption<V>[]>(() => {
    // Only results for the current query: while a newer query loads, older results are hidden.
    if (loadOptions) return asyncState.query === query ? asyncState.items.slice(0, maxResults) : [];
    const all = options ?? [];
    if (!query.trim()) return all.slice(0, Math.max(maxResults, all.length));
    return (filter ? filter(all, query) : rankOptions(all, query)).slice(0, maxResults);
  }, [loadOptions, asyncState.items, asyncState.query, options, query, filter, maxResults]);

  const showPinned = !query.trim() && pinned && pinned.length > 0;
  const { rows, optionRows } = useMemo(
    () => buildRows<V>(showPinned ? [pinned!, results] : [results]),
    [showPinned, pinned, results],
  );
  const optionCount = optionRows.length;

  const selectedOption = useMemo<ComboboxOption<V> | null>(() => {
    if (value === null || value === undefined) return null;
    const pools = [pinned ?? [], options ?? [], asyncState.items];
    for (const pool of pools) {
      const hit = pool.find((o) => sameValue(o.value, value));
      if (hit) return hit;
    }
    if (picked.current && sameValue(picked.current.value, value)) return picked.current;
    return null;
  }, [value, pinned, options, asyncState.items]);

  /* ---- geometry (fixed row heights; windowed past 60 rows) ---- */
  const offsets = useMemo(() => {
    const o = new Array<number>(rows.length + 1);
    o[0] = 0;
    for (let i = 0; i < rows.length; i++) o[i + 1] = o[i]! + (rows[i]!.kind === "group" ? GROUP_H : OPTION_H);
    return o;
  }, [rows]);
  const total = offsets[rows.length] ?? 0;
  const searchH = 49; // the search box row
  const statusH = !loadOptions || asyncState.status === "done" ? 0 : OPTION_H;
  const listMax = sheet
    ? Math.max(120, (placement?.maxHeight ?? 400) - searchH - 52)
    : Math.max(96, (placement?.maxHeight ?? 380) - searchH - 2);
  const listH = sheet ? listMax : Math.min(listMax, total + 8);
  const windowed = rows.length > WINDOW_AFTER;

  const firstVisible = useMemo(() => {
    if (!windowed) return 0;
    let lo = 0;
    let hi = rows.length - 1;
    const y = Math.max(0, scrollTop - 4);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo - OVERSCAN);
  }, [windowed, rows.length, scrollTop, offsets]);
  const lastVisible = useMemo(() => {
    if (!windowed) return rows.length - 1;
    const bottom = scrollTop + listH;
    let i = firstVisible;
    while (i < rows.length - 1 && offsets[i]! < bottom) i++;
    return Math.min(rows.length - 1, i + OVERSCAN);
  }, [windowed, rows.length, scrollTop, listH, firstVisible, offsets]);

  /* ---- active option ---- */
  const optionAt = (pos: number) => {
    const r = rows[optionRows[pos] ?? -1];
    return r && r.kind === "option" ? r.option : null;
  };

  const scrollToPos = useCallback(
    (pos: number) => {
      const el = scroller.current;
      const rowIdx = optionRows[pos];
      if (!el || rowIdx === undefined) return;
      // Keep the group label of the first option visible.
      const top = rowIdx > 0 && rows[rowIdx - 1]?.kind === "group" && pos === 0 ? 0 : offsets[rowIdx]!;
      const bottom = offsets[rowIdx + 1]!;
      const pad = 4;
      if (top < el.scrollTop + pad) el.scrollTop = Math.max(0, top - pad);
      else if (bottom > el.scrollTop + el.clientHeight - pad) el.scrollTop = bottom - el.clientHeight + pad;
    },
    [optionRows, offsets, rows],
  );

  const move = (to: number, wrapAround = false) => {
    if (!optionCount) return;
    let pos = to;
    if (wrapAround) pos = ((to % optionCount) + optionCount) % optionCount;
    else pos = Math.max(0, Math.min(optionCount - 1, to));
    // Skip disabled options in the direction of travel.
    const dir = to >= active ? 1 : -1;
    for (let i = 0; i < optionCount; i++) {
      const o = optionAt(pos);
      if (o && !o.disabled) break;
      pos = wrapAround ? (pos + dir + optionCount) % optionCount : Math.max(0, Math.min(optionCount - 1, pos + dir));
    }
    setActive(pos);
    scrollToPos(pos);
  };

  // On open: the current value (else the first option) is active and in view.
  const openedAt = useRef(0);
  useLayoutEffect(() => {
    if (!open) return;
    openedAt.current++;
    let pos = 0;
    if (value !== null && value !== undefined) {
      for (let i = 0; i < optionCount; i++) {
        const o = optionAt(i);
        if (o && sameValue(o.value, value)) {
          pos = i;
          break;
        }
      }
    }
    setActive(pos);
    requestAnimationFrame(() => {
      const el = scroller.current;
      const rowIdx = optionRows[pos];
      if (el && rowIdx !== undefined && pos > 0) el.scrollTop = Math.max(0, offsets[rowIdx]! - el.clientHeight / 2 + OPTION_H / 2);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A new query makes the first result active.
  useEffect(() => {
    if (!open) return;
    setActive(0);
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (active >= optionCount && optionCount > 0) setActive(optionCount - 1);
  }, [active, optionCount]);

  /* ---- open / close ---- */
  const doOpen = (seed = "") => {
    if (disabled) return;
    setQuery(seed);
    setScrollTop(0);
    setOpen(true);
    onOpen?.();
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };

  const choose = (o: ComboboxOption<V> | null, refocus = true) => {
    if (o?.disabled) return;
    if (o) picked.current = o;
    if (!o || !sameValue(o.value, value)) onChange(o ? o.value : null, o);
    close(refocus);
  };

  useDismissOnOutsidePointer(open, [wrap, pop], () => close(false));

  // Focus the search box once the popover is placed.
  useEffect(() => {
    if (open && placement) input.current?.focus({ preventScroll: true });
  }, [open, placement]);

  // Lock page scroll behind the phone sheet.
  useEffect(() => {
    if (!open || !sheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, sheet]);

  /* ---- keyboard ---- */
  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    // Keys typed in the moment between opening and the search box taking focus still land
    // on the trigger: add them to the query instead of reopening with only the last key.
    if (open) {
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setQuery((q) => q + e.key);
        input.current?.focus({ preventScroll: true });
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setQuery((q) => q.slice(0, -1));
      }
      return;
    }
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      doOpen();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && clearable && value !== null) {
      e.preventDefault();
      onChange(null, null);
      return;
    }
    if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      doOpen(e.key);
    }
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (mod) move(optionCount - 1);
        else move(active + 1, true);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (e.altKey) {
          choose(optionAt(active));
          return;
        }
        if (mod) move(0);
        else move(active - 1, true);
        return;
      case "Home":
        e.preventDefault();
        move(0);
        return;
      case "End":
        e.preventDefault();
        move(optionCount - 1);
        return;
      case "PageDown":
        e.preventDefault();
        move(active + 10);
        return;
      case "PageUp":
        e.preventDefault();
        move(active - 10);
        return;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (optionCount) choose(optionAt(active));
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery("");
        else close(true);
        return;
      case "Tab": {
        const o = optionAt(active);
        if (o && query.trim() && !o.disabled && !sameValue(o.value, value)) {
          picked.current = o;
          onChange(o.value, o);
        }
        if (e.shiftKey) {
          e.preventDefault();
          close(true);
        } else {
          // Let the browser move on from the trigger.
          e.preventDefault();
          close(false);
          requestAnimationFrame(() => focusNextAfter(trigger.current, wrap.current));
        }
        return;
      }
    }
  };

  /* ---- render ---- */
  const activeOption = open ? optionAt(active) : null;
  const activeId = activeOption ? `${listId}-${optionRows[active]}` : undefined;
  const statusText =
    loadOptions && asyncState.status === "loading"
      ? "Searching…"
      : loadOptions && asyncState.status === "error"
        ? "Couldn't load results."
        : `${optionCount} ${optionCount === 1 ? "result" : "results"}`;

  const triggerContent = renderValue ? (
    renderValue(selectedOption)
  ) : selectedOption ? (
    <span className="truncate">{selectedOption.label}</span>
  ) : value !== null && value !== undefined ? (
    <span className="truncate">{String(value)}</span>
  ) : null;
  const empty = value === null || value === undefined;

  const listLabel = ariaLabel ?? (open ? labelTextFor(triggerId) : undefined);

  return (
    <div ref={wrap} className={cn("relative min-w-0", className)}>
      {ariaLabel ? (
        <span id={ownLabelId} hidden>
          {ariaLabel}
        </span>
      ) : null}
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        name={name}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${ariaLabel ? ownLabelId : `${triggerId}-label`} ${valueId}`}
        aria-describedby={describedBy}
        data-invalid={invalid || undefined}
        onClick={() => (open ? close(true) : doOpen())}
        onKeyDown={onTriggerKey}
        className={cn(
          "rb-select flex w-full min-w-0 items-center gap-8 rounded-sm border text-left text-fg",
          "transition-[border-color,background-color] duration-[120ms]",
          "focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-accent",
          "disabled:cursor-not-allowed disabled:opacity-60 data-[invalid=true]:border-bad",
          TRIGGER_TONE[tone],
          open && "border-accent",
          size === "sm" ? "h-28 pr-26 pl-8 text-sm" : "h-32 pr-26 pl-9 text-base",
          clearable && !empty && "pr-48",
        )}
      >
        <span id={valueId} className={cn("flex min-w-0 flex-1 items-center gap-8", empty && "text-faint")}>
          {empty && !triggerContent ? placeholder : triggerContent}
        </span>
      </button>
      {clearable && !empty && !disabled ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear"
          onClick={() => {
            onChange(null, null);
            trigger.current?.focus();
          }}
          className="absolute top-1/2 right-24 flex size-20 -translate-y-1/2 items-center justify-center rounded-xs text-xs text-muted hover:bg-sunk hover:text-fg"
        >
          ✕
        </button>
      ) : null}

      {open ? (
        <div
          ref={pop}
          className={cn(
            "fixed z-[60] flex flex-col overflow-hidden bg-surface text-fg",
            sheet ? "border-0" : "anim-fade rounded-md border border-line shadow-menu",
            !placement && "invisible",
          )}
          style={placement?.style}
        >
          {sheet ? (
            <div className="flex h-52 shrink-0 items-center gap-8 border-b border-line px-16">
              <span className="t-display-xs min-w-0 flex-1 truncate">{listLabel ?? "Choose"}</span>
              <button
                type="button"
                onClick={() => close(true)}
                className="h-40 rounded-sm border border-line bg-surface px-12 text-base font-medium"
              >
                Cancel
              </button>
            </div>
          ) : null}
          <div className={cn("shrink-0 border-b border-line p-8", sheet && "px-16 py-10")}>
            <input
              ref={input}
              id={inputId}
              role="combobox"
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              aria-label={listLabel ? `Search ${listLabel.toLowerCase()}` : "Search"}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              className={cn(
                "w-full min-w-0 rounded-sm border border-line bg-canvas px-9 text-fg placeholder:text-faint",
                "focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-accent",
                sheet ? "h-40 text-lg" : "h-32 text-base",
              )}
            />
          </div>
          <div role="status" aria-live="polite" className="sr-only">
            {open ? statusText : ""}
          </div>
          {statusH ? (
            <div className="flex h-32 shrink-0 items-center gap-8 px-12 text-sm text-muted">
              {asyncState.status === "error" ? (
                <>
                  <span className="text-bad">Couldn&apos;t load results.</span>
                  <button
                    type="button"
                    className="link border-0 bg-transparent p-0 text-sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setRetry((n) => n + 1);
                      input.current?.focus();
                    }}
                  >
                    Retry
                  </button>
                </>
              ) : (
                "Searching…"
              )}
            </div>
          ) : null}
          <div
            ref={scroller}
            id={listId}
            role="listbox"
            aria-label={listLabel ?? "Options"}
            tabIndex={-1}
            onScroll={(e) => windowed && setScrollTop(e.currentTarget.scrollTop)}
            className={cn("relative min-h-0 overflow-y-auto overscroll-contain scrollbar-thin", sheet ? "flex-1" : "")}
            style={sheet ? undefined : { height: rows.length ? listH : undefined }}
          >
            {optionCount === 0 && (!loadOptions || asyncState.status === "done") ? (
              <p className="px-12 py-10 text-sm text-muted">
                {emptyText ? emptyText(query) : query ? <>No matches for &ldquo;{query}&rdquo;.</> : "Nothing to choose from."}
              </p>
            ) : (
              <div className="relative" style={{ height: total + 8 }}>
                {rows.slice(firstVisible, lastVisible + 1).map((row, k) => {
                  const i = firstVisible + k;
                  const top = offsets[i]! + 4;
                  if (row.kind === "group") {
                    return (
                      <div
                        key={row.key}
                        role="presentation"
                        className="t-label absolute inset-x-0 flex items-end px-12 pb-6"
                        style={{ top, height: GROUP_H }}
                      >
                        {row.label}
                      </div>
                    );
                  }
                  const o = row.option;
                  const isActive = row.pos === active;
                  const isSelected = !empty && sameValue(o.value, value);
                  return (
                    <div
                      key={row.key}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={o.disabled || undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => !isActive && setActive(row.pos)}
                      onClick={() => choose(o)}
                      className={cn(
                        "absolute inset-x-4 flex cursor-default items-center gap-8 rounded-sm px-8 text-base",
                        isActive && "bg-accent-soft",
                        isSelected && "shadow-[inset_2px_0_0_var(--accent)]",
                        o.disabled && "cursor-not-allowed opacity-50",
                      )}
                      style={{ top, height: OPTION_H }}
                    >
                      {renderOption ? (
                        renderOption(o, { query, active: isActive, selected: isSelected })
                      ) : (
                        <DefaultOption option={o} query={query} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DefaultOption<V>({ option, query }: { option: ComboboxOption<V>; query: string }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg">
          <Highlight text={option.label} query={query} />
        </span>
        {option.description ? <span className="ml-8 text-muted">{option.description}</span> : null}
      </span>
      {option.hint ? <span className="t-micro shrink-0 text-muted">{option.hint}</span> : null}
    </>
  );
}

/** The text of the `<label for=id>` (from Field), for the search box and the phone sheet title. */
function labelTextFor(id: string): string | undefined {
  try {
    const el = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    const text = el?.firstChild?.textContent ?? el?.textContent ?? "";
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/** Focus the next tabbable element after the combobox (Tab out of the popover). */
function focusNextAfter(trigger: HTMLElement | null, wrap: HTMLElement | null) {
  if (!trigger) return;
  const scope = trigger.closest("dialog[open]") ?? document;
  const all = Array.from(scope.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (n) => n === trigger || (n.tabIndex >= 0 && n.offsetParent !== null && !wrap?.contains(n)),
  );
  const next = all[all.indexOf(trigger) + 1];
  (next ?? trigger).focus();
}
