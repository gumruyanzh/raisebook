"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import {
  addDays,
  addMonths,
  dateFieldLabel,
  isIsoDate,
  monthGrid,
  MONTH_NAMES,
  parseLooseDate,
  quickPicks as picksFor,
  todayIn,
  weekday,
} from "@/lib/dates";
import { daysBetween, formatDate } from "@/lib/format";

import { useAnchoredPopover, useDismissOnOutsidePointer } from "./Combobox";
import { Kbd } from "./Kbd";

export interface DateFieldProps {
  /** ISO `YYYY-MM-DD`, or null. */
  value: string | null;
  onChange: (iso: string | null) => void;
  /** The workspace timezone: "today" and every quick pick are computed in it. */
  timeZone: string;
  /** Quick picks: follow-up (Today, Tomorrow, In 3 days, Next Monday…), deadline, or none. */
  quickPicks?: "followup" | "deadline" | "none";
  placeholder?: string;
  clearable?: boolean;
  size?: "sm" | "md";
  tone?: "form" | "toolbar";
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Bounds for the calendar and typed dates (ISO). */
  min?: string;
  max?: string;
  /**
   * A past date is late (a follow-up): the trigger reads "Overdue 2d · Oct 10" in `bad`, the
   * way the card and Follow up now say it, instead of a neutral "Oct 10 · 2d ago".
   */
  pastIsOverdue?: boolean;
  /**
   * The empty trigger's text: `faint` (a form placeholder) or `muted` when the empty trigger
   * is itself the action ("Pick…" in Triage must not look disabled).
   */
  placeholderTone?: "faint" | "muted";
  className?: string;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function longLabel(iso: string): string {
  const [y, m, d] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
  return `${LONG_DAYS[weekday(iso)]}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

const TONE = {
  form: "border-line bg-canvas hover:border-muted",
  toolbar: "border-line bg-surface hover:border-muted",
} as const;

/**
 * Date picker (UX pass 1, P1-5a). The trigger reads `Oct 16 · in 4d` in mono (or a muted
 * placeholder). The popover has quick picks with one-key shortcuts (0 1 3 m 7 2, ⌫ clears), a
 * typed box that reads "fri", "+7", "oct 20", "10/20" or "2026-10-20", and a month grid with
 * arrow-key navigation. Dates are calendar dates in the workspace timezone.
 */
export function DateField({
  value,
  onChange,
  timeZone,
  quickPicks = "followup",
  placeholder = "Set date",
  clearable = true,
  size = "md",
  tone = "form",
  disabled,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  min,
  max,
  pastIsOverdue,
  placeholderTone = "faint",
  className,
}: DateFieldProps) {
  const auto = useId();
  const triggerId = id ?? `df${auto}`;
  const popId = `${triggerId}-pop`;
  const valueId = `${triggerId}-value`;
  const ownLabelId = `${triggerId}-own-label`;
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const picksRef = useRef<HTMLDivElement>(null);
  const typedRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [today, setToday] = useState(() => todayIn(timeZone));
  const [cursor, setCursor] = useState<string>(() => value ?? today);
  const [pickFocus, setPickFocus] = useState(0);
  const placement = useAnchoredPopover(wrap, open, { minWidth: quickPicks === "none" ? 280 : 452, maxHeight: 460 });
  const sheet = placement?.sheet ?? false;

  const valid = value && isIsoDate(value) ? value : null;
  const inRange = (d: string) => (!min || d >= min) && (!max || d <= max);
  const picks = useMemo(
    () => (quickPicks === "none" ? [] : picksFor(quickPicks, today).filter((p) => inRange(p.iso))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quickPicks, today, min, max],
  );
  const parsed = typed.trim() ? parseLooseDate(typed, today) : null;
  const parsedOk = parsed && inRange(parsed) ? parsed : null;

  const close = (refocus: boolean) => {
    setOpen(false);
    setTyped("");
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };

  const commit = (iso: string | null) => {
    if (iso !== valid) onChange(iso);
    close(true);
  };

  const doOpen = () => {
    if (disabled) return;
    const t = todayIn(timeZone);
    setToday(t);
    setCursor(valid ?? t);
    setTyped("");
    setPickFocus(0);
    setOpen(true);
  };

  useDismissOnOutsidePointer(open, [wrap, pop], () => close(false));

  // Initial focus: the quick picks (so one key applies a pick), else the typed box.
  useEffect(() => {
    if (!open || !placement) return;
    const first = picksRef.current?.querySelector<HTMLElement>('[data-pick="0"]');
    (first ?? typedRef.current)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!placement]);

  const focusPick = (i: number) => {
    const n = picks.length;
    if (!n) return;
    const k = ((i % n) + n) % n;
    setPickFocus(k);
    picksRef.current?.querySelector<HTMLElement>(`[data-pick="${k}"]`)?.focus();
  };

  const focusDay = (iso: string) => {
    setCursor(iso);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-day="${iso}"]`)?.focus());
  };

  const onPopKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (typed && document.activeElement === typedRef.current) setTyped("");
      else close(true);
    }
  };

  const onPicksKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusPick(pickFocus + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusPick(pickFocus - 1);
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && clearable) {
      e.preventDefault();
      commit(null);
      return;
    }
    const hit = picks.find((p) => p.kbd === e.key.toLowerCase());
    if (hit) {
      e.preventDefault();
      commit(hit.iso);
      return;
    }
    // Any other printable key starts typing a date.
    if (e.key.length === 1 && /\S/.test(e.key)) {
      e.preventDefault();
      setTyped(e.key);
      typedRef.current?.focus();
    }
  };

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      focusDay(addDays(cursor, step[e.key]!));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const n = (e.key === "PageUp" ? -1 : 1) * (e.shiftKey ? 12 : 1);
      focusDay(addMonths(cursor, n));
    } else if (e.key === "Home") {
      e.preventDefault();
      focusDay(addDays(cursor, -weekday(cursor)));
    } else if (e.key === "End") {
      e.preventDefault();
      focusDay(addDays(cursor, 6 - weekday(cursor)));
    } else if ((e.key === "Backspace" || e.key === "Delete") && clearable) {
      e.preventDefault();
      commit(null);
    }
  };

  const grid = useMemo(() => monthGrid(cursor), [cursor]);
  const month = Number(cursor.slice(5, 7));
  const year = Number(cursor.slice(0, 4));

  const nowDay = todayIn(timeZone);
  const late = pastIsOverdue && valid ? daysBetween(valid, nowDay) : 0;
  const display = valid ? (late > 0 ? `Overdue ${late}d · ${formatDate(valid, nowDay)}` : dateFieldLabel(valid, nowDay)) : null;

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
        name={name}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-labelledby={`${ariaLabel ? ownLabelId : `${triggerId}-label`} ${valueId}`}
        aria-describedby={describedBy}
        data-invalid={invalid || undefined}
        title={valid ? longLabel(valid) : undefined}
        onClick={() => (open ? close(true) : doOpen())}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            doOpen();
          } else if ((e.key === "Backspace" || e.key === "Delete") && clearable && valid) {
            e.preventDefault();
            onChange(null);
          }
        }}
        className={cn(
          "flex w-full min-w-0 items-center gap-8 rounded-sm border text-left text-fg",
          "transition-[border-color,background-color] duration-[120ms]",
          "focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-accent",
          "disabled:cursor-not-allowed disabled:opacity-60 data-[invalid=true]:border-bad",
          TONE[tone],
          open && "border-accent",
          late > 0 && !open && "border-bad/50",
          size === "sm" ? "h-28 px-8 text-sm" : "h-32 px-9 text-base",
          clearable && valid && "pr-28",
        )}
      >
        <span
          id={valueId}
          className={cn("min-w-0 flex-1 truncate", valid ? cn("t-data", late > 0 && "text-bad") : placeholderTone === "muted" ? "text-muted" : "text-faint")}
          suppressHydrationWarning
        >
          {display ?? placeholder}
        </span>
      </button>
      {clearable && valid && !disabled ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear date"
          onClick={() => {
            onChange(null);
            trigger.current?.focus();
          }}
          className="absolute top-1/2 right-6 flex size-20 -translate-y-1/2 items-center justify-center rounded-xs text-xs text-muted hover:bg-sunk hover:text-fg"
        >
          ✕
        </button>
      ) : null}

      {open ? (
        <div
          ref={pop}
          id={popId}
          role="dialog"
          aria-modal="false"
          aria-label={ariaLabel ?? "Choose a date"}
          onKeyDown={onPopKey}
          onBlur={(e) => {
            // Tabbing out of the popover closes it (it is not modal).
            const next = e.relatedTarget as Node | null;
            if (next && !pop.current?.contains(next) && !wrap.current?.contains(next)) close(false);
          }}
          className={cn(
            "fixed z-[60] flex flex-col overflow-y-auto bg-surface text-fg",
            sheet ? "" : "anim-fade rounded-md border border-line shadow-menu",
            !placement && "invisible",
          )}
          style={placement?.style}
        >
          {sheet ? (
            <div className="flex h-52 shrink-0 items-center gap-8 border-b border-line px-16">
              <span className="t-display-xs min-w-0 flex-1 truncate">{ariaLabel ?? "Choose a date"}</span>
              <button
                type="button"
                onClick={() => close(true)}
                className="h-40 rounded-sm border border-line bg-surface px-12 text-base font-medium"
              >
                Cancel
              </button>
            </div>
          ) : null}
          <div className={cn("border-b border-line p-8", sheet && "px-16 py-10")}>
            <input
              ref={typedRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label="Type a date"
              aria-describedby={`${popId}-preview`}
              placeholder="Type a date: fri, +7, oct 20"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (parsedOk) commit(parsedOk);
                } else if (e.key === "ArrowDown" && picks.length && !typed) {
                  e.preventDefault();
                  focusPick(0);
                }
              }}
              className={cn(
                "w-full min-w-0 rounded-sm border border-line bg-canvas px-9 text-fg placeholder:text-faint",
                "focus-visible:border-accent focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-accent",
                sheet ? "h-40 text-lg" : "h-32 text-base",
              )}
            />
            <p id={`${popId}-preview`} aria-live="polite" className="t-body-s mt-6 min-h-18 px-2 text-muted">
              {typed.trim() ? (
                parsedOk ? (
                  <>
                    <span className="text-fg">{longLabel(parsedOk)}</span> · Enter to set
                  </>
                ) : parsed ? (
                  "That date is out of range."
                ) : (
                  "Not a date yet. Try fri, +7, oct 20 or 10/20."
                )
              ) : valid ? (
                <>Set to {longLabel(valid)}</>
              ) : (
                "Pick, type, or use a shortcut."
              )}
            </p>
          </div>

          <div className={cn("flex min-h-0", sheet || quickPicks === "none" ? "flex-col" : "flex-row")}>
            {picks.length || clearable ? (
              <div
                ref={picksRef}
                role="group"
                aria-label="Quick picks"
                onKeyDown={onPicksKey}
                className={cn(
                  "flex shrink-0 flex-col p-4",
                  sheet || quickPicks === "none" ? "border-b border-line" : "w-[188px] border-r border-line",
                )}
              >
                {picks.map((p, i) => (
                  <button
                    key={p.label}
                    type="button"
                    data-pick={i}
                    tabIndex={i === pickFocus ? 0 : -1}
                    onFocus={() => setPickFocus(i)}
                    onClick={() => commit(p.iso)}
                    className={cn(
                      "flex items-center gap-8 rounded-sm px-8 text-left text-base outline-none",
                      "hover:bg-accent-soft focus-visible:bg-accent-soft",
                      sheet ? "h-40" : "h-32",
                      p.iso === valid && "shadow-[inset_2px_0_0_var(--accent)]",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{p.label}</span>
                    <span className="t-micro text-muted">{formatDate(p.iso, today)}</span>
                    {p.kbd ? <Kbd>{p.kbd}</Kbd> : null}
                  </button>
                ))}
                {clearable && valid ? (
                  <button
                    type="button"
                    data-pick={picks.length}
                    tabIndex={picks.length === 0 ? 0 : -1}
                    onClick={() => commit(null)}
                    className={cn(
                      "flex items-center gap-8 rounded-sm px-8 text-left text-base text-muted outline-none",
                      "hover:bg-accent-soft hover:text-fg focus-visible:bg-accent-soft",
                      sheet ? "h-40" : "h-32",
                    )}
                  >
                    <span className="flex-1">Clear</span>
                    <Kbd>⌫</Kbd>
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="min-w-0 flex-1 p-8">
              <div className="mb-6 flex items-center gap-4">
                <span className="min-w-0 flex-1 px-4 text-base font-semibold" aria-live="polite">
                  {MONTH_NAMES[month - 1]} {year}
                </span>
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() => setCursor(addMonths(cursor, -1))}
                  className="flex size-28 items-center justify-center rounded-sm text-muted hover:bg-sunk hover:text-fg"
                >
                  ←
                </button>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() => setCursor(addMonths(cursor, 1))}
                  className="flex size-28 items-center justify-center rounded-sm text-muted hover:bg-sunk hover:text-fg"
                >
                  →
                </button>
              </div>
              <div
                ref={gridRef}
                role="grid"
                aria-label={`${MONTH_NAMES[month - 1]} ${year}`}
                onKeyDown={onGridKey}
                className="grid grid-cols-7 gap-y-2"
              >
                <div role="row" className="contents">
                  {WEEKDAYS.map((d, i) => (
                    <span key={d} role="columnheader" aria-label={LONG_DAYS[i]} className="t-micro flex h-24 items-center justify-center text-muted">
                      {d}
                    </span>
                  ))}
                </div>
                {Array.from({ length: 6 }, (_, w) => (
                  <div role="row" key={w} className="contents">
                    {grid.slice(w * 7, w * 7 + 7).map((d) => {
                      const inMonth = Number(d.slice(5, 7)) === month;
                      const isSel = d === valid;
                      const isToday = d === today;
                      const allowed = inRange(d);
                      return (
                        <span role="gridcell" key={d} aria-selected={isSel} className="flex justify-center">
                          <button
                            type="button"
                            data-day={d}
                            tabIndex={d === cursor ? 0 : -1}
                            disabled={!allowed}
                            aria-label={`${longLabel(d)}${isToday ? ", today" : ""}`}
                            aria-current={isToday ? "date" : undefined}
                            onClick={() => commit(d)}
                            onFocus={() => d !== cursor && setCursor(d)}
                            className={cn(
                              "t-data flex items-center justify-center rounded-sm text-sm outline-none",
                              sheet ? "size-40" : "size-32",
                              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                              isSel
                                ? "bg-accent text-accent-ink"
                                : cn("hover:bg-accent-soft", inMonth ? "text-fg" : "text-muted"),
                              isToday && !isSel && "font-semibold underline decoration-accent decoration-2 underline-offset-4",
                              !allowed && "cursor-not-allowed opacity-40",
                            )}
                          >
                            {Number(d.slice(8, 10))}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
