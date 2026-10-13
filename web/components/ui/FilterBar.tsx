"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "@/lib/cn";

import { Kbd } from "./Kbd";

/**
 * The pipeline's filter controls (UX pass 1, P1-4): a 28px "Filter" button that opens a
 * searchable two-level popover (field → value), and a row of removable chips for the applied
 * filters ("Owner is Dana ✕"). The URL stays the source of truth: these are controlled.
 *
 * Keyboard: the button (or F, wired by the page) opens it with the search box focused. ↑/↓
 * move, Enter or → opens a field, Enter picks a value and closes, ← or Backspace in an empty
 * box goes back, Esc clears the text first and then closes. Typing at the first level also
 * finds values across fields ("meeting" → "Stage: Meeting"). A focused chip is removed with
 * Backspace or Delete.
 */

export interface FilterValue {
  value: string;
  label: string;
  /** Right-aligned muted hint (a count). */
  hint?: ReactNode;
  /** Left slot (a StageDot, an Avatar). */
  icon?: ReactNode;
  /** Extra match terms. */
  keywords?: string[];
}

export interface FilterField {
  key: string;
  label: string;
  values: FilterValue[];
  /** Chip verb: "Stage is Meeting". */
  verb?: string;
  /** The whole chip text, when "<label> <verb> <value>" reads badly ("Not in Seed"). */
  chipLabel?: (valueLabel: string) => string;
}

export interface FilterMenuHandle {
  open: () => void;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function matches(q: string, ...texts: (string | undefined)[]): number {
  const f = fold(q).trim();
  if (!f) return 1;
  let best = 0;
  for (const t of texts) {
    if (!t) continue;
    const l = fold(t);
    if (l === f) best = Math.max(best, 4);
    else if (l.startsWith(f)) best = Math.max(best, 3);
    else if (l.split(/[\s·/-]+/).some((w) => w.startsWith(f))) best = Math.max(best, 2);
    else if (l.includes(f)) best = Math.max(best, 1);
  }
  return best;
}

type Option =
  | { kind: "field"; id: string; field: FilterField }
  | { kind: "value"; id: string; field: FilterField; value: FilterValue; showField: boolean }
  | { kind: "any"; id: string; field: FilterField };

export function FilterMenu({
  fields,
  active,
  onChange,
  onOpenRequest,
  ref,
  className,
}: {
  fields: FilterField[];
  /** Applied value per field key. */
  active: Record<string, string | undefined>;
  onChange: (key: string, value: string | null) => void;
  /** Return true to handle the open yourself (phones open a Filters sheet instead). */
  onOpenRequest?: () => boolean;
  ref?: Ref<FilterMenuHandle>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The popover hangs from the button's left edge unless that would run off the screen.
  const [alignEnd, setAlignEnd] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const applied = fields.filter((f) => active[f.key]).length;

  const doOpen = useCallback(() => {
    if (onOpenRequest?.()) return;
    setLevel(null);
    setQ("");
    setActiveIdx(0);
    const r = btn.current?.getBoundingClientRect();
    setAlignEnd(Boolean(r && r.left + 300 > window.innerWidth - 16));
    setOpen(true);
  }, [onOpenRequest]);
  useImperativeHandle(ref, () => ({ open: doOpen }), [doOpen]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => btn.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => input.current?.focus());
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const field = level ? fields.find((f) => f.key === level) : undefined;

  const options: Option[] = useMemo(() => {
    if (field) {
      const vals = field.values
        .map((v, i) => ({ v, i, s: matches(q, v.label, ...(v.keywords ?? [])) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map(({ v }) => ({ kind: "value", id: `v-${field.key}-${v.value}`, field, value: v, showField: false }) as Option);
      return active[field.key] && !q ? [{ kind: "any", id: `any-${field.key}`, field }, ...vals] : vals;
    }
    const fs = fields
      .filter((f) => matches(q, f.label) > 0)
      .map((f) => ({ kind: "field", id: `f-${f.key}`, field: f }) as Option);
    if (!q.trim()) return fs;
    const vals: { o: Option; s: number }[] = [];
    for (const f of fields)
      for (const v of f.values) {
        const s = matches(q, v.label, ...(v.keywords ?? []));
        if (s > 1) vals.push({ o: { kind: "value", id: `v-${f.key}-${v.value}`, field: f, value: v, showField: true }, s });
      }
    vals.sort((a, b) => b.s - a.s);
    return [...fs, ...vals.slice(0, 30).map((x) => x.o)];
  }, [field, fields, q, active]);

  useEffect(() => setActiveIdx(0), [q, level]);
  const cur = options[Math.min(activeIdx, options.length - 1)];

  // Keep the active option in view.
  useLayoutEffect(() => {
    if (!open || !cur) return;
    list.current?.querySelector<HTMLElement>(`[data-opt="${CSS.escape(cur.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, cur]);

  const choose = (o: Option | undefined) => {
    if (!o) return;
    if (o.kind === "field") {
      setLevel(o.field.key);
      setQ("");
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    if (o.kind === "any") onChange(o.field.key, null);
    else onChange(o.field.key, active[o.field.key] === o.value.value ? null : o.value.value);
    close(true);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (n) setActiveIdx((i) => (i + 1) % n);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (n) setActiveIdx((i) => (i - 1 + n) % n);
        return;
      case "Home":
        if (!q) {
          e.preventDefault();
          setActiveIdx(0);
        }
        return;
      case "End":
        if (!q) {
          e.preventDefault();
          setActiveIdx(Math.max(0, n - 1));
        }
        return;
      case "PageDown":
        e.preventDefault();
        setActiveIdx((i) => Math.min(n - 1, i + 10));
        return;
      case "PageUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 10));
        return;
      case "Enter":
        e.preventDefault();
        choose(cur);
        return;
      case "ArrowRight":
        if (cur?.kind === "field" && e.currentTarget.selectionStart === q.length) {
          e.preventDefault();
          choose(cur);
        }
        return;
      case "ArrowLeft":
        if (level && !q) {
          e.preventDefault();
          setLevel(null);
        }
        return;
      case "Backspace":
        if (level && !q) {
          e.preventDefault();
          setLevel(null);
        }
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (q) setQ("");
        else close(true);
        return;
      case "Tab":
        setOpen(false);
        return;
    }
  };

  return (
    <div ref={wrap} className={cn("relative inline-flex", className)}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="F"
        onClick={() => (open ? close(false) : doOpen())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            doOpen();
          }
        }}
        className={cn(
          "inline-flex h-32 items-center gap-6 rounded-sm border bg-surface px-10 text-base whitespace-nowrap transition-colors duration-[120ms]",
          applied ? "border-accent text-fg" : "border-line text-muted hover:border-muted hover:text-fg",
        )}
      >
        Filter
        {applied ? <span className="font-mono text-xs text-accent tnum">{applied}</span> : null}
        <Kbd className="max-lg:hidden">F</Kbd>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={field ? `Filter by ${field.label}` : "Filter investors"}
          className={cn(
            alignEnd ? "right-0" : "left-0",
            "anim-fade absolute top-full z-[45] mt-4 flex w-[min(300px,calc(100vw-32px))] flex-col rounded-md border border-line bg-surface shadow-menu",
          )}
        >
          <div className="flex items-center gap-6 border-b border-line px-8">
            {field ? (
              <button
                type="button"
                onClick={() => {
                  setLevel(null);
                  input.current?.focus();
                }}
                className="t-micro shrink-0 border-0 bg-transparent px-2 text-muted hover:text-fg"
                aria-label="Back to all fields"
              >
                ← {field.label}
              </button>
            ) : null}
            <input
              ref={input}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={cur ? `${listId}-${cur.id}` : undefined}
              aria-label={field ? `Search ${field.label.toLowerCase()} values` : "Filter by"}
              placeholder={field ? `${field.label}…` : "Filter by…"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              className="h-36 min-w-0 flex-1 border-0 bg-transparent px-4 text-base outline-none placeholder:text-faint"
            />
          </div>
          <div ref={list} id={listId} role="listbox" aria-label={field?.label ?? "Fields"} className="max-h-[min(340px,60vh)] overflow-y-auto py-4">
            {options.length === 0 ? (
              <p className="t-body-s px-12 py-8 text-muted">No match for “{q}”.</p>
            ) : (
              options.map((o, i) => {
                const on = i === Math.min(activeIdx, options.length - 1);
                const selected = o.kind === "value" && active[o.field.key] === o.value.value;
                return (
                  <div
                    key={o.id}
                    id={`${listId}-${o.id}`}
                    data-opt={o.id}
                    role="option"
                    aria-selected={on}
                    aria-checked={o.kind === "value" ? selected : undefined}
                    onPointerMove={() => setActiveIdx(i)}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                    className={cn(
                      "flex h-32 cursor-pointer items-center gap-8 px-12 text-base whitespace-nowrap",
                      on && "bg-accent-soft",
                    )}
                  >
                    {o.kind === "field" ? (
                      <>
                        <span className="min-w-0 flex-1 truncate">{o.field.label}</span>
                        {active[o.field.key] ? (
                          <span className="t-micro max-w-[120px] truncate text-accent">
                            {o.field.values.find((v) => v.value === active[o.field.key])?.label ?? active[o.field.key]}
                          </span>
                        ) : null}
                        <span aria-hidden className="text-muted">
                          →
                        </span>
                      </>
                    ) : o.kind === "any" ? (
                      <span className="min-w-0 flex-1 truncate text-muted">Any {o.field.label.toLowerCase()}</span>
                    ) : (
                      <>
                        {o.value.icon}
                        <span className={cn("min-w-0 flex-1 truncate", selected && "font-semibold")}>
                          {o.showField ? <span className="text-muted">{o.field.label}: </span> : null}
                          {o.value.label}
                        </span>
                        {selected ? (
                          <span aria-hidden className="text-accent">
                            ✓
                          </span>
                        ) : o.value.hint !== undefined ? (
                          <span className="t-micro text-muted">{o.value.hint}</span>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Applied filters as removable chips, plus "Clear". Renders nothing when none apply. */
export function FilterChips({
  fields,
  active,
  onRemove,
  onClear,
  extra,
  className,
  focusAfterRemove,
}: {
  fields: FilterField[];
  active: Record<string, string | undefined>;
  onRemove: (key: string) => void;
  onClear: () => void;
  /** Chips that are not fields (the search text). */
  extra?: { key: string; label: string; onRemove: () => void }[];
  className?: string;
  /** Where focus goes when the last chip is removed (the Filter button). */
  focusAfterRemove?: () => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const chips = [
    ...(extra ?? []),
    ...fields
      .filter((f) => active[f.key])
      .map((f) => {
        const v = f.values.find((x) => x.value === active[f.key]);
        return {
          key: f.key,
          label: f.chipLabel
            ? f.chipLabel(v?.label ?? active[f.key]!)
            : `${f.label} ${f.verb ?? "is"} ${v?.label ?? active[f.key]}`,
          onRemove: () => onRemove(f.key),
        };
      }),
  ];
  if (!chips.length) return null;
  const removeAt = (i: number) => {
    chips[i]!.onRemove();
    requestAnimationFrame(() => {
      const left = row.current?.querySelectorAll<HTMLElement>("[data-chip]");
      const next = left?.[Math.min(i, (left?.length ?? 1) - 1)];
      if (next) next.focus();
      else focusAfterRemove?.();
    });
  };
  return (
    <div ref={row} role="group" aria-label="Applied filters" className={cn("flex flex-wrap items-center gap-6", className)}>
      {chips.map((c, i) => (
        <button
          key={c.key}
          type="button"
          data-chip
          onClick={() => removeAt(i)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" || e.key === "Delete") {
              e.preventDefault();
              removeAt(i);
            }
          }}
          aria-label={`Remove filter: ${c.label}`}
          title="Remove (Backspace)"
          className="t-chip inline-flex h-24 max-w-[260px] items-center gap-6 rounded-pill border border-line bg-surface pr-6 pl-10 text-fg hover:border-muted"
        >
          <span className="truncate">{c.label}</span>
          <span aria-hidden className="text-muted">
            ✕
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          onClear();
          focusAfterRemove?.();
        }}
        className="t-body-s border-0 bg-transparent px-4 text-muted hover:text-fg"
      >
        Clear
      </button>
    </div>
  );
}
