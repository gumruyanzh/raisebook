"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button, Kbd, SectionLabel, StageDot, Textarea, useToast, useToastLift } from "@/components/ui";
import { DateField } from "@/components/ui/DateField";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import { logActivity } from "@/lib/api/activities";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { setFollowUp, type FollowUpList } from "@/lib/api/rounds";
import type { FollowUpItem, Round } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { addDays, nextWeekday } from "@/lib/dates";
import { daysBetween, formatDate, num, plural } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";

type GroupKey = "overdue" | "today" | "soon";
type Row = { type: "head"; key: GroupKey; title: string; count: number } | { type: "item"; item: FollowUpItem; index: number };
type Prompt = { kind: "done" | "snooze" | "note"; item: FollowUpItem } | null;
type Pick = { label: string; iso: string | null; kbd: string };

const HEAD_H = 30;
const ROW_H = 58;
/** A row with no note or next step is one line. */
const ROW_H_1 = 42;
const WINDOW_DAYS = 7;

function groupOf(i: FollowUpItem, today: string): GroupKey | null {
  const d = daysBetween(today, i.follow_up_on);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d <= WINDOW_DAYS) return "soon";
  return null;
}

function sortItems(items: FollowUpItem[]): FollowUpItem[] {
  return [...items].sort(
    (a, b) => a.follow_up_on.localeCompare(b.follow_up_on) || a.investor.name.localeCompare(b.investor.name),
  );
}

function dueText(i: FollowUpItem, today: string): string {
  const late = daysBetween(i.follow_up_on, today);
  if (late > 0) return `${plural(late, "day")} late`;
  if (late === 0) return "Today";
  return formatDate(i.follow_up_on, today);
}

/**
 * The Today queue (UX-PASS-1 P1-8): every overdue, today and next-7-days follow-up in one
 * windowed list, worked from the keyboard. j/k move, Enter opens the investor, `e` marks it
 * done and asks for the next follow-up (one more key: 1, 3, m, 7, 2; Esc for none), `s`
 * snoozes, `n` logs a note. Every write shows an Undo toast that restores the old date.
 */
export function TodayQueue({
  round,
  initial,
  today,
  client,
  canWrite,
  pipelineHref,
  timeZone,
  onChanged,
  className,
  style,
}: {
  round: Round;
  initial: FollowUpList;
  today: string;
  client: ApiClient;
  canWrite: boolean;
  pipelineHref: string;
  /** Workspace timezone (the date picker's calendar). */
  timeZone: string;
  /** A write landed: refresh the ledger and feed in the background. */
  onChanged?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(() => sortItems(initial.data));
  const [active, setActive] = useState(0);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [pickDate, setPickDate] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useToastLift(strip, Boolean(prompt));
  const listFocus = useRef(false);

  useEffect(() => setItems(sortItems(initial.data)), [initial]);

  const visible = useMemo(() => items.filter((i) => groupOf(i, today) !== null), [items, today]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const groups: [GroupKey, string][] = [
      ["overdue", "Overdue"],
      ["today", "Today"],
      ["soon", "Next 7 days"],
    ];
    let index = 0;
    for (const [key, title] of groups) {
      const its = visible.filter((i) => groupOf(i, today) === key);
      if (!its.length) continue;
      out.push({ type: "head", key, title, count: its.length });
      for (const item of its) out.push({ type: "item", item, index: index++ });
    }
    return out;
  }, [visible, today]);
  const itemRows = useMemo(() => rows.filter((r): r is Extract<Row, { type: "item" }> => r.type === "item"), [rows]);
  const rowIndexOf = useMemo(() => {
    const m: number[] = [];
    rows.forEach((r, i) => {
      if (r.type === "item") m[r.index] = i;
    });
    return m;
  }, [rows]);

  // Touch screens move the due date to the second line, so every row there has two.
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const on = () => setCoarse(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const twoLines = useCallback(
    (it: FollowUpItem) => Boolean(it.follow_up_note || it.next_step) || (canWrite && coarse),
    [canWrite, coarse],
  );
  const height = useCallback(
    (i: number) => {
      const r = rows[i];
      if (!r || r.type === "head") return HEAD_H;
      return twoLines(r.item) ? ROW_H : ROW_H_1;
    },
    [rows, twoLines],
  );
  const v = useVirtualRows({ scrollRef: scroll, count: rows.length, height, initial: 40 });

  const count = itemRows.length;
  const cur = count ? Math.min(active, count - 1) : -1;
  const curItem = cur >= 0 ? itemRows[cur]!.item : null;

  // Focus lands after the window re-renders around the row (it may not exist yet).
  const pendingFocus = useRef<number | null>(null);
  const focusRow = useCallback(
    (i: number) => {
      if (!count) return;
      const n = Math.max(0, Math.min(count - 1, i));
      pendingFocus.current = n;
      setActive(n);
      v.scrollToIndex(rowIndexOf[n] ?? 0);
    },
    [count, v, rowIndexOf],
  );
  useLayoutEffect(() => {
    const n = pendingFocus.current;
    if (n === null) return;
    const el = scroll.current?.querySelector<HTMLElement>(`[data-q-index="${n}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  const open = useCallback(
    (it: FollowUpItem) => router.push(`${pipelineHref}?investor=${encodeURIComponent(it.investor.id)}`),
    [router, pipelineHref],
  );

  /* ---------- writes ---------- */

  const apply = useCallback(
    async (it: FollowUpItem, next: string | null, verb: "done" | "snooze") => {
      const prev = { on: it.follow_up_on, note: it.follow_up_note ?? undefined };
      const idx = items.findIndex((x) => x.investor.id === it.investor.id);
      // Optimistic: move or drop the row right away.
      setItems((xs) =>
        sortItems(
          next
            ? xs.map((x) => (x.investor.id === it.investor.id ? { ...x, follow_up_on: next, days_overdue: Math.max(0, daysBetween(next, today)) } : x))
            : xs.filter((x) => x.investor.id !== it.investor.id),
        ),
      );
      setBusy(true);
      try {
        await setFollowUp(client, round.id, it.investor.id, next ? { on: next, note: verb === "snooze" ? prev.note : undefined } : { clear: true });
        const name = it.investor.name;
        const msg =
          verb === "snooze"
            ? `${name} snoozed to ${formatDate(next!, today)}.`
            : next
              ? `Done with ${name}. Next follow-up ${formatDate(next, today)}.`
              : `Done with ${name}. No next follow-up.`;
        toast.show(msg, {
          label: "Undo",
          onClick: async () => {
            try {
              await setFollowUp(client, round.id, it.investor.id, { on: prev.on, note: prev.note });
              setItems((xs) => sortItems([...xs.filter((x) => x.investor.id !== it.investor.id), it]));
              toast.show(`${name}'s follow-up is back on ${formatDate(prev.on, today)}.`);
              onChanged?.();
            } catch (err) {
              toast.show(errorMessage(err));
            }
          },
        });
        onChanged?.();
      } catch (err) {
        // Put the row back as it was.
        setItems((xs) => {
          const rest = xs.filter((x) => x.investor.id !== it.investor.id);
          rest.splice(Math.max(0, idx), 0, it);
          return sortItems(rest);
        });
        toast.show(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [items, client, round.id, today, toast, onChanged],
  );

  const closePrompt = useCallback(
    (refocus = true) => {
      setPrompt(null);
      setPickDate(false);
      setNote("");
      if (refocus) requestAnimationFrame(() => focusRow(active));
    },
    [focusRow, active],
  );

  const choose = useCallback(
    (p: Pick) => {
      if (!prompt || prompt.kind === "note") return;
      const it = prompt.item;
      setPrompt(null);
      setPickDate(false);
      void apply(it, p.iso, prompt.kind).then(() => requestAnimationFrame(() => focusRow(active)));
    },
    [prompt, apply, focusRow, active],
  );

  const logNote = useCallback(async () => {
    if (!prompt || prompt.kind !== "note" || !note.trim()) return;
    const it = prompt.item;
    setBusy(true);
    try {
      await logActivity(client, { investor_id: it.investor.id, kind: "note", body: note.trim(), round: round.id });
      toast.show(`Note added to ${it.investor.name}.`);
      closePrompt();
      onChanged?.();
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [prompt, note, client, round.id, toast, closePrompt, onChanged]);

  const startPrompt = useCallback(
    (kind: "done" | "snooze" | "note", it: FollowUpItem | null) => {
      if (!it || !canWrite || busy) return;
      setPrompt({ kind, item: it });
      setPickDate(false);
      setNote("");
      requestAnimationFrame(() => {
        const first = strip.current?.querySelector<HTMLElement>("textarea, button");
        first?.focus({ preventScroll: true });
        strip.current?.scrollIntoView({ block: "nearest" });
      });
    },
    [canWrite, busy],
  );

  /* ---------- keys ---------- */

  const keysOn = count > 0 && !prompt;
  useHotkey("j", () => focusRow(listFocus.current ? cur + 1 : Math.max(cur, 0)), {
    enabled: keysOn,
    description: "Next follow-up",
    group: "Today",
    blockedByModals: true,
  });
  useHotkey("k", () => focusRow(cur - 1), { enabled: keysOn, description: "Previous follow-up", group: "Today", blockedByModals: true });
  useHotkey("e", () => startPrompt("done", curItem), {
    enabled: keysOn && canWrite,
    description: "Done, then pick the next follow-up",
    group: "Today",
    blockedByModals: true,
  });
  useHotkey("s", () => startPrompt("snooze", curItem), {
    enabled: keysOn && canWrite,
    description: "Snooze",
    group: "Today",
    blockedByModals: true,
  });
  useHotkey("n", () => startPrompt("note", curItem), {
    enabled: keysOn && canWrite,
    description: "Log a note",
    group: "Today",
    blockedByModals: true,
  });

  const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>, it: FollowUpItem, idx: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      open(it);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(count - 1);
    }
  };

  const picks: Pick[] = useMemo(() => {
    if (!prompt || prompt.kind === "note") return [];
    const base: Pick[] = [
      { label: "Tomorrow", iso: addDays(today, 1), kbd: "1" },
      { label: "In 3 days", iso: addDays(today, 3), kbd: "3" },
      { label: "Next Monday", iso: nextWeekday(today, 1), kbd: "m" },
    ];
    if (prompt.kind === "done") base.push({ label: "In 1 week", iso: addDays(today, 7), kbd: "7" });
    base.push({ label: "In 2 weeks", iso: addDays(today, 14), kbd: "2" });
    return base;
  }, [prompt, today]);

  const onStripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!prompt) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (pickDate) {
        setPickDate(false);
        return;
      }
      if (prompt.kind === "done") choose({ label: "None", iso: null, kbd: "Escape" });
      else closePrompt();
      return;
    }
    if (prompt.kind === "note") {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void logNote();
      }
      return;
    }
    if (pickDate || e.metaKey || e.ctrlKey || e.altKey) return;
    const hit = picks.find((p) => p.kbd === e.key.toLowerCase());
    if (hit) {
      e.preventDefault();
      choose(hit);
    } else if (prompt.kind === "snooze" && e.key.toLowerCase() === "d") {
      e.preventDefault();
      setPickDate(true);
    }
  };

  /* ---------- render ---------- */

  const counts = {
    overdue: visible.filter((i) => groupOf(i, today) === "overdue").length,
    today: visible.filter((i) => groupOf(i, today) === "today").length,
    soon: visible.filter((i) => groupOf(i, today) === "soon").length,
  };

  return (
    <section aria-label="Follow-ups" className={cn("flex flex-col rounded-md border border-line bg-surface", className)} style={style}>
      <div className="flex flex-wrap items-baseline gap-x-12 gap-y-4 px-14 pt-12 pb-8">
        <SectionLabel className="mb-0">Follow-ups</SectionLabel>
        <span className="t-micro text-muted">
          <span className={counts.overdue ? "text-bad" : undefined}>{num(counts.overdue)} overdue</span> · {num(counts.today)} today ·{" "}
          {num(counts.soon)} this week
        </span>
        {count && canWrite ? (
          <span className="t-micro ml-auto hidden items-center gap-6 text-muted xl:flex" aria-hidden>
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move <Kbd>E</Kbd> done <Kbd>S</Kbd> snooze <Kbd>N</Kbd> note
          </span>
        ) : null}
      </div>

      {count === 0 ? (
        <p className="t-body-s px-14 pb-14 text-muted">
          Nothing due in the next {WINDOW_DAYS} days. Set follow-up dates on investor files and they line up here.
        </p>
      ) : (
        <div
          ref={scroll}
          role="list"
          aria-label={`${plural(count, "follow-up")}, overdue first`}
          className="max-h-[min(66vh,640px)] overflow-y-auto overscroll-contain border-t border-line"
          onFocus={() => (listFocus.current = true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) listFocus.current = false;
          }}
        >
          <div style={{ height: v.padTop }} aria-hidden />
          {rows.slice(v.start, v.end).map((r) => {
            if (r.type === "head") {
              return (
                <div
                  key={`h-${r.key}`}
                  role="presentation"
                  className={cn("t-label flex items-end bg-surface px-14 pb-4", r.key === "soon" ? "" : "text-bad")}
                  style={{ height: HEAD_H }}
                >
                  {r.title} · {num(r.count)}
                </div>
              );
            }
            const it = r.item;
            const on = r.index === cur;
            const g = groupOf(it, today);
            const line = it.follow_up_note || it.next_step || "";
            return (
              <div
                key={it.investor.id}
                role="listitem"
                tabIndex={on ? 0 : -1}
                data-q-index={r.index}
                aria-label={`${it.investor.name}${it.investor.firm ? `, ${it.investor.firm}` : ""}, ${it.stage.label}, ${dueText(it, today)}${line ? `. ${line}` : ""}`}
                onKeyDown={(e) => onRowKey(e, it, r.index)}
                onFocus={() => setActive(r.index)}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button,a")) return;
                  setActive(r.index);
                  open(it);
                }}
                className={cn(
                  "group relative flex cursor-pointer flex-col justify-center gap-2 border-b border-line px-14 outline-none",
                  "hover:bg-[color-mix(in_oklab,var(--sunk)_55%,var(--surface))]",
                  "focus-visible:bg-accent-soft focus-visible:shadow-[inset_2px_0_0_var(--accent)]",
                  on && prompt?.item.investor.id === it.investor.id && "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]",
                )}
                style={{ height: twoLines(it) ? ROW_H : ROW_H_1 }}
              >
                <div className="flex min-w-0 items-center gap-8">
                  <StageDot color={it.stage.color} />
                  <span className="max-w-[60%] shrink-0 truncate font-semibold sm:max-w-[45%]">{it.investor.name}</span>
                  <span className="t-body-s min-w-0 truncate text-muted">
                    {it.investor.firm ? <span>{it.investor.firm}</span> : null}
                    <span className="hidden sm:inline">
                      {it.investor.firm ? " · " : ""}
                      {it.stage.label}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "t-micro ml-auto shrink-0 pl-8 whitespace-nowrap",
                      g === "soon" ? "text-muted" : "text-bad",
                      canWrite && "group-hover:hidden group-focus-within:hidden [@media(pointer:coarse)]:hidden",
                    )}
                  >
                    {dueText(it, today)}
                  </span>
                  {canWrite ? (
                    <span className="ml-auto hidden shrink-0 items-center gap-2 group-hover:flex group-focus-within:flex [@media(pointer:coarse)]:flex">
                      <Button size="sm" variant="ghost" tabIndex={on ? 0 : -1} onClick={() => startPrompt("done", it)} title="Done (E)">
                        Done
                      </Button>
                      <Button size="sm" variant="ghost" tabIndex={on ? 0 : -1} onClick={() => startPrompt("snooze", it)} title="Snooze (S)">
                        Snooze
                      </Button>
                    </span>
                  ) : null}
                </div>
                {twoLines(it) ? (
                  <p className="t-body-s truncate pl-17 text-muted" title={line || undefined}>
                    {canWrite ? (
                      // Touch screens show the actions where the date sits; the date moves here.
                      <span className={cn("hidden font-mono [@media(pointer:coarse)]:inline", g === "soon" ? "text-muted" : "text-bad")}>
                        {dueText(it, today)}
                        {line ? " · " : ""}
                      </span>
                    ) : null}
                    {line}
                  </p>
                ) : null}
              </div>
            );
          })}
          <div style={{ height: v.padBottom }} aria-hidden />
        </div>
      )}

      {prompt ? (
        <div
          ref={strip}
          role="group"
          aria-label={
            prompt.kind === "done"
              ? `Next follow-up for ${prompt.item.investor.name}`
              : prompt.kind === "snooze"
                ? `Snooze ${prompt.item.investor.name}`
                : `Note on ${prompt.item.investor.name}`
          }
          onKeyDown={onStripKey}
          className="anim-fade flex flex-col gap-8 border-t border-line bg-sunk px-14 py-10"
        >
          <p className="text-13">
            {prompt.kind === "done" ? (
              <>
                Done with <b className="font-semibold">{prompt.item.investor.name}</b>. Next follow-up?
              </>
            ) : prompt.kind === "snooze" ? (
              <>
                Snooze <b className="font-semibold">{prompt.item.investor.name}</b> until…
              </>
            ) : (
              <>
                Note on <b className="font-semibold">{prompt.item.investor.name}</b>
              </>
            )}
          </p>
          {prompt.kind === "note" ? (
            <>
              <Textarea
                aria-label="Note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What happened?"
                className="min-h-[72px]!"
              />
              <div className="flex items-center justify-end gap-8">
                <Button size="sm" variant="ghost" onClick={() => closePrompt()}>
                  Cancel <Kbd className="ml-6">Esc</Kbd>
                </Button>
                <Button size="sm" onClick={() => void logNote()} disabled={!note.trim()} busy={busy ? "Saving…" : false}>
                  Log note <Kbd className="ml-6">⌘↵</Kbd>
                </Button>
              </div>
            </>
          ) : pickDate ? (
            <div className="flex flex-wrap items-center gap-8">
              <DateField
                value={null}
                timeZone={timeZone}
                quickPicks="followup"
                placeholder="Pick a date"
                min={addDays(today, 1)}
                aria-label={`Snooze ${prompt.item.investor.name} until`}
                onChange={(iso) => {
                  if (iso) choose({ label: "Date", iso, kbd: "" });
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => setPickDate(false)}>
                Back
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-6">
              {picks.map((p) => (
                <Button key={p.kbd} size="sm" onClick={() => choose(p)}>
                  {p.label}
                  <Kbd className="ml-6">{p.kbd.toUpperCase()}</Kbd>
                </Button>
              ))}
              {prompt.kind === "snooze" ? (
                <Button size="sm" onClick={() => setPickDate(true)}>
                  Pick date… <Kbd className="ml-6">D</Kbd>
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => (prompt.kind === "done" ? choose({ label: "None", iso: null, kbd: "" }) : closePrompt())}>
                {prompt.kind === "done" ? "No follow-up" : "Cancel"} <Kbd className="ml-6">Esc</Kbd>
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
