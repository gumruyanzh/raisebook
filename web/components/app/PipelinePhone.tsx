"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, Chip, SearchInput, StageDot, useToastLift } from "@/components/ui";
import type { Participant, Priority, Round, Stage } from "@/lib/api/types";
import { INSTRUMENT_LABEL, PRIORITY_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { money, moneyCompact, num, priorityFromFit } from "@/lib/format";
import { cardPriority } from "@/lib/boardCard";
import { cardSlot, GROUP_LABEL, nextUpBuckets, PRIORITY_ORDER, type NextUpBucket } from "@/lib/pipeline";

import { useWorkspace } from "@/lib/session";

import { useViewerTimeZone } from "./meetings/useViewerTimeZone";
import { bucketCopy, dueRows, dueText, stripMessage, type LedgerFacts } from "./PipelineLedger";

/** Three lines in 76px: name and fit, stage or firm and the follow-up, the next step. */
const ROW_H = 76;
const GROUP_H = 40;

type Row = { kind: "group"; priority: Priority; ids: string[] } | { kind: "row"; p: Participant };

/**
 * The summary strip on a phone (design/mobile-audit): one tappable line ("$825k of $2M ·
 * 24 due", or "Sorted 73 of 100" before money exists) that opens the money card, Follow up
 * now and Next up. Before money exists, Start triage stays on the line itself.
 */
export function PhoneSummary({
  round,
  stages,
  all,
  openKey,
  facts,
  moneyOn,
  today,
  canWrite,
  triageOk,
  onDue,
  onBucket,
  onOpen,
  onStartTriage,
  extra,
}: {
  /** More for the round, at the end of the open summary (AI research). */
  extra?: ReactNode;
  round: Round;
  stages: Stage[];
  all: Participant[];
  openKey: string | null;
  facts: LedgerFacts;
  moneyOn: boolean;
  today: string;
  canWrite: boolean;
  triageOk: boolean;
  onDue: () => void;
  onBucket: (b: NextUpBucket) => void;
  onOpen: (id: string) => void;
  onStartTriage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const openLabel = stages.find((s) => s.key === openKey)?.label ?? "New";
  const msg = stripMessage(facts, openLabel);
  const sorted = facts.total - facts.openCount;
  const due = dueRows(all);
  const buckets = nextUpBuckets(all, openKey, today, Date.now()).filter((b) => canWrite || b.id !== "new");
  const sub = moneyOn
    ? [INSTRUMENT_LABEL[round.instrument], facts.daysToClose !== null && facts.daysToClose >= 0 ? `${num(facts.daysToClose)} days left` : null]
    : [INSTRUMENT_LABEL[round.instrument], `${moneyCompact(round.target_amount, round.currency)} target`];
  const pctC = round.target_amount ? Math.min(100, (facts.committed / round.target_amount) * 100) : 0;
  const pctS = round.target_amount ? Math.min(100 - pctC, (facts.soft / round.target_amount) * 100) : 0;
  const bar = moneyOn ? (
    <span aria-hidden className="flex h-6 w-56 shrink-0 overflow-hidden rounded-pill bg-sunk">
      <i className="block h-full bg-good not-italic" style={{ width: `${pctC}%` }} />
      <i className="block h-full not-italic" style={{ width: `${pctS}%`, background: "color-mix(in oklab, var(--good) 30%, var(--sunk))" }} />
    </span>
  ) : (
    <span aria-hidden className="h-6 w-56 shrink-0 overflow-hidden rounded-pill bg-sunk">
      <i className="block h-full bg-good not-italic" style={{ width: `${facts.total ? (sorted / facts.total) * 100 : 0}%` }} />
    </span>
  );
  return (
    <section aria-label={`${round.name} summary`} className="rounded-md border border-line bg-surface">
      <div className="flex min-h-48 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-48 min-w-0 flex-1 items-center gap-10 border-0 bg-transparent pr-6 pl-14 text-left"
        >
          {moneyOn ? (
            <span className="min-w-0 truncate tnum">
              <b className="font-display text-[17px] font-bold text-good-ink">{moneyCompact(facts.committed, round.currency)}</b>{" "}
              <span className="text-muted">of {moneyCompact(round.target_amount, round.currency)}</span>
            </span>
          ) : (
            <span className="min-w-0 truncate">
              <span className="t-label">Sorted</span> <b className="tnum">{num(sorted)}</b>
              <span className="text-muted"> of {num(facts.total)}</span>
            </span>
          )}
          {bar}
          {moneyOn && due.length ? (
            <span className="shrink-0 font-mono text-[12.5px] text-bad">{num(due.length)} due</span>
          ) : null}
          <span aria-hidden className={cn("ml-auto shrink-0 text-muted transition-transform duration-[120ms]", open && "rotate-180")}>
            ▾
          </span>
          <span className="sr-only">{open ? "Hide the round summary" : "Show the round summary"}</span>
        </button>
        {!moneyOn && msg.triage && triageOk ? (
          <Button variant="primary" size="sm" className="mr-8 min-h-36" onClick={onStartTriage}>
            Start triage
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-12 border-t border-line px-14 pt-10 pb-14">
          <p className="t-micro text-muted uppercase">{sub.filter(Boolean).join(" · ")}</p>
          {moneyOn ? (
            <div>
              <p className="font-display text-[22px] font-bold tnum">
                <span className="text-good-ink">{money(facts.committed, round.currency)}</span>{" "}
                <span className="text-[15px] font-medium text-muted">of {moneyCompact(round.target_amount, round.currency)}</span>
              </p>
              <p className="t-body-s mt-4 text-muted">
                <b className="text-fg">{num(facts.committedCount)}</b> committed · <b className="text-fg">{moneyCompact(facts.soft, round.currency)}</b> soft ·{" "}
                <b className="text-fg">{num(facts.talking)}</b> talking
              </p>
            </div>
          ) : (
            <p className="text-muted">{msg.text}</p>
          )}
          {due.length ? (
            <div>
              <p className="t-label mb-2 flex items-center">
                Follow up now
                <button type="button" onClick={onDue} className="link t-body-s ml-auto inline-flex h-44 items-center border-0 bg-transparent p-0 normal-case tracking-normal">
                  All {num(due.length)} →
                </button>
              </p>
              {due.slice(0, 3).map((p) => (
                <button
                  key={p.investor.id}
                  type="button"
                  onClick={() => onOpen(p.investor.id)}
                  className="flex min-h-48 w-full min-w-0 items-center gap-8 border-0 border-t border-line bg-transparent px-0 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.investor.name}</span>
                    <span className="t-body-s inline-flex items-center gap-6 text-muted">
                      <StageDot color={p.stage.color} />
                      {p.stage.label}
                    </span>
                  </span>
                  <Chip tone="due">{dueText(p, today)}</Chip>
                </button>
              ))}
            </div>
          ) : null}
          {moneyOn && buckets.length ? (
            <div>
              <p className="t-label mb-2">Next up</p>
              {buckets.slice(0, 3).map((b) => {
                const c = bucketCopy(b, openLabel);
                return (
                  <div key={b.id} className="grid min-h-44 grid-cols-[minmax(28px,auto)_minmax(0,1fr)_auto] items-center gap-x-10 border-t border-line">
                    <b className="font-mono text-[12.5px] tnum">{num(b.count)}</b>
                    <span className="t-body-s min-w-0">
                      {c.text}
                      {b.id === "ready" && b.next ? (
                        <>
                          {" · next "}
                          <button type="button" className="border-0 bg-transparent p-0 font-semibold text-fg" onClick={() => onOpen(b.next!.id)}>
                            {b.next.name}
                          </button>
                        </>
                      ) : null}
                    </span>
                    <button type="button" className="link t-body-s inline-flex h-44 items-center border-0 bg-transparent p-0" onClick={() => onBucket(b)}>
                      {c.link}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {extra ? <div className="flex flex-wrap items-center gap-8 border-t border-line pt-12">{extra}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The phone's "+": a 56px circle above the tab bar (or the page bottom on a sideways phone),
 * clear of the list's last row (the list leaves room under itself). Toasts rise above it.
 */
export function PhoneFab({ onAdd, label = "Add investor" }: { onAdd: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useToastLift(ref, true);
  return (
    <div
      ref={ref}
      className="fixed right-16 z-30"
      style={{ bottom: "calc(16px + max(env(safe-area-inset-bottom), var(--rb-tabbar)))" }}
    >
      <button
        type="button"
        onClick={onAdd}
        aria-label={label}
        title={label}
        className="inline-flex size-56 items-center justify-center rounded-pill border-0 bg-accent text-accent-ink shadow-menu"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/** The view switch on a phone: List, Board and Triage, full width, with a ⋯ for the rest. */
export function PhoneViewBar({
  view,
  onView,
  triageCount,
  filters,
  more,
  slotRef,
}: {
  /** A sideways phone: the board's stage tabs move up into this row (the board keeps the height). */
  slotRef?: (el: HTMLElement | null) => void;
  view: "table" | "board" | "triage";
  onView: (v: "table" | "board" | "triage") => void;
  /** Triage's count; null when Triage is not offered (viewers, nothing New). */
  triageCount: number | null;
  /** The Filter button (board view). */
  filters?: ReactNode;
  /** The ⋯ menu (Import, Edit round, AI research). */
  more?: ReactNode;
}) {
  const opts: { value: "table" | "board" | "triage"; label: ReactNode }[] = [
    { value: "table", label: "List" },
    { value: "board", label: "Board" },
    ...(triageCount !== null
      ? [
          {
            value: "triage" as const,
            label: (
              <>
                Triage <span className={cn("font-mono text-[12px]", view === "triage" ? "text-canvas" : "text-muted")}>{num(triageCount)}</span>
              </>
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="flex items-center gap-8">
      <div
        role="group"
        aria-label="View"
        className={cn("flex min-w-0 flex-1 rounded-md border border-line bg-surface p-2", slotRef && "short:flex-none")}
      >
        {opts.map((o) => {
          const on = o.value === view;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => !on && onView(o.value)}
              className={cn(
                // Basis auto: "Triage 27" is wider than "List", so it gets the room it needs when Filter
                // joins the row (board view) instead of spilling into its neighbour.
                "inline-flex h-40 min-w-0 flex-auto items-center justify-center gap-6 rounded-sm border-0 px-6 font-medium whitespace-nowrap",
                slotRef && "short:flex-none short:px-12",
                on ? "bg-fg text-canvas" : "bg-transparent text-muted",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {slotRef ? <span ref={slotRef} className="hidden min-w-0 flex-1 short:block" /> : null}
      {filters}
      {more}
    </div>
  );
}

/**
 * The phone list (DECISION §7.1, design/mobile-audit): stage pills that scroll sideways (with
 * a fade at the edge that says so), search and Filter, and one stage as a list of 76px rows
 * (grouped by priority when New is long), windowed against the page scroll. The board and
 * Triage are the other two views; the summary sits above, in one line.
 */
export function PipelinePhone({
  round,
  stages,
  rows,
  all,
  openKey,
  today,
  canWrite,
  triageOk,
  stage,
  dueOnly,
  dueTotal,
  selected,
  onSelectedChange,
  onStage,
  onDue,
  onOpen,
  onStartTriage,
  onFilters,
  activeFilters,
  search,
  onSearch,
  onListChange,
  stickyTop = 0,
  roomForFab,
}: {
  round: Round;
  stages: Stage[];
  /** The filtered rows (search, filters; the stage filter when the URL has one). */
  rows: Participant[];
  all: Participant[];
  openKey: string | null;
  today: string;
  canWrite: boolean;
  triageOk: boolean;
  stage: string;
  dueOnly: boolean;
  dueTotal: number;
  selected: Set<string> | null;
  onSelectedChange: (s: Set<string>) => void;
  onStage: (key: string) => void;
  onDue: () => void;
  onOpen: (id: string) => void;
  onStartTriage: () => void;
  onFilters: () => void;
  activeFilters: number;
  search: string;
  onSearch: (v: string) => void;
  /** The ids in the list on screen (the sheet's ↑/↓ walk this list, not the whole round). */
  onListChange?: (ids: string[]) => void;
  /** Height of the sticky top bar: a long list's group header sticks under it. */
  stickyTop?: number;
  /** The + button floats over the page: leave room under the last row. */
  roomForFab?: boolean;
}) {
  const viewerTz = useViewerTimeZone(useWorkspace().workspace.timezone);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of all) c[p.stage.key] = (c[p.stage.key] ?? 0) + 1;
    return c;
  }, [all]);
  const firstWithInvestors = stages.find((s) => counts[s.key])?.key ?? stages[0]?.key ?? "";
  const pick = dueOnly ? "due" : stage || (dueTotal > 0 ? "due" : firstWithInvestors);
  const pickStage = stages.find((s) => s.key === pick);
  const list = useMemo(() => {
    const inPick = pick === "due" ? dueRows(rows) : rows.filter((p) => p.stage.key === pick);
    // Fit groups for a not-contacted stage of 12+, as on the board.
    const grouped = pickStage?.kind === "open" && inPick.length >= 12;
    if (!grouped) return { grouped, rows: inPick.map((p) => ({ kind: "row", p }) as Row) };
    const by: Record<Priority, Participant[]> = { hot: [], warm: [], maybe: [], low: [] };
    for (const p of inPick) by[priorityFromFit(p.fit)].push(p);
    const out: Row[] = [];
    for (const pr of PRIORITY_ORDER) {
      if (!by[pr].length) continue;
      out.push({ kind: "group", priority: pr, ids: by[pr].map((p) => p.investor.id) });
      for (const p of by[pr]) out.push({ kind: "row", p });
    }
    return { grouped, rows: out };
  }, [rows, pick, pickStage]);
  useEffect(() => {
    onListChange?.(list.rows.flatMap((r) => (r.kind === "row" ? [r.p.investor.id] : [])));
  }, [list.rows, onListChange]);

  // Windowing against the page scroll (fixed row heights).
  const listRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ start: 0, end: 30 });
  /** How far the list's top is scrolled under the top bar (for the sticky group header). */
  const [under, setUnder] = useState(0);
  const tops = useMemo(() => {
    const t: number[] = [0];
    for (const r of list.rows) t.push(t[t.length - 1]! + (r.kind === "group" ? GROUP_H : ROW_H));
    return t;
  }, [list.rows]);
  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current;
      if (!el) return;
      const top = -el.getBoundingClientRect().top;
      const bottom = top + window.innerHeight;
      setUnder(top + stickyTop);
      let start = 0;
      while (start < list.rows.length && tops[start + 1]! < top) start++;
      let end = start;
      while (end < list.rows.length && tops[end]! < bottom) end++;
      setWin({ start: Math.max(0, start - 6), end: Math.min(list.rows.length, end + 6) });
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [list.rows, tops, stickyTop]);
  // Deep in 300 rows the group header has scrolled away: the current group sticks instead.
  // The next group's header pushes it up instead of hiding under it.
  const stuck = (() => {
    if (!list.grouped || under <= 0) return null;
    let cur: Extract<Row, { kind: "group" }> | null = null;
    let nextTop = Infinity;
    list.rows.forEach((r, i) => {
      if (r.kind !== "group") return;
      if (tops[i]! < under) cur = r;
      else if (nextTop === Infinity) nextTop = tops[i]!;
    });
    if (!cur) return null;
    return { row: cur as Extract<Row, { kind: "group" }>, shift: Math.min(0, nextTop - under - GROUP_H) };
  })();

  // Long-press starts selection.
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const anySel = Boolean(selected && selected.size);
  const toggle = (id: string) => {
    if (!selected) return;
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    onSelectedChange(n);
  };
  useEffect(() => () => void (press.current && clearTimeout(press.current)), []);

  // The pill strip fades at an edge it can still scroll past (the cut-off pill said nothing).
  const pillsRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const onPills = () => {
    const el = pillsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 4;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  useLayoutEffect(onPills);
  // The picked pill scrolls into view (a link straight to "Passed" lands on its pill).
  useEffect(() => {
    pillsRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pick]);

  const pill = (key: string, label: string, n: number, dot?: Stage["color"], bad = false) => {
    const on = pick === key;
    return (
      <button
        key={key}
        type="button"
        aria-pressed={on}
        onClick={() => (key === "due" ? onDue() : onStage(key))}
        className={cn(
          "inline-flex h-44 shrink-0 items-center gap-8 rounded-pill border px-14 whitespace-nowrap",
          on ? "border-fg bg-fg text-canvas" : "border-line bg-surface text-fg",
        )}
      >
        {dot ? <StageDot color={dot} /> : null}
        {label}
        <span className={cn("font-mono text-[12px]", on ? "text-canvas" : bad ? "text-bad" : "text-muted")}>{num(n)}</span>
      </button>
    );
  };

  const groupHead = (r: Extract<Row, { kind: "group" }>, style?: React.CSSProperties) => {
    const allSel = selected && r.ids.every((id) => selected.has(id));
    return (
      <div key={`g-${r.priority}`} style={{ ...style, height: GROUP_H }} className="flex items-center gap-12 border-b border-line bg-sunk px-14">
        <span className="t-label">{GROUP_LABEL[r.priority]}</span>
        <span className="ml-auto font-mono text-[12px] text-muted tnum">{num(r.ids.length)}</span>
        {canWrite && selected ? (
          <button
            type="button"
            className="link inline-flex h-40 items-center border-0 bg-transparent p-0"
            onClick={() => {
              const n = new Set(selected);
              for (const id of r.ids) {
                if (allSel) n.delete(id);
                else n.add(id);
              }
              onSelectedChange(n);
            }}
          >
            {allSel ? "Clear" : "Select"}
          </button>
        ) : null}
      </div>
    );
  };
  // One pill that only repeats the list header below it ("New 411") is left out.
  const pillStages = stages.filter((s) => (counts[s.key] ?? 0) > 0 || s.key === pick);
  const showPills = dueTotal > 0 || pillStages.length > 1;

  return (
    <div className={cn("flex flex-col gap-12", roomForFab && "pb-72")}>
      {showPills ? (
        <div className="relative -mx-16">
          <div
            ref={pillsRef}
            onScroll={onPills}
            className="flex gap-8 overflow-x-auto px-16 scrollbar-none"
            role="group"
            aria-label="Stage"
          >
            {dueTotal > 0 ? pill("due", "Due now", dueTotal, undefined, true) : null}
            {pillStages.map((s) => pill(s.key, s.label, counts[s.key] ?? 0, s.color))}
          </div>
          {edges.left ? <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-28 bg-linear-to-r from-canvas to-transparent" /> : null}
          {edges.right ? <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-40 bg-linear-to-l from-canvas to-transparent" /> : null}
        </div>
      ) : null}

      <div className="flex gap-8">
        <SearchInput placeholder="Search investors…" aria-label="Search investors" value={search} onChange={(e) => onSearch(e.target.value)} className="min-h-44" />
        <Button onClick={onFilters} className="min-h-44">
          Filter{activeFilters ? <span className="font-mono text-[12px] text-accent">{activeFilters}</span> : null}
        </Button>
      </div>

      {/* overflow-clip (not hidden): the sticky group header follows the page scroll. */}
      <section aria-label={pick === "due" ? "Due now" : (pickStage?.label ?? "")} className="overflow-clip rounded-md border border-line bg-surface">
        {/* One way into Triage per screen: one line here, without repeating the pill's count. */}
        {pickStage && pick === openKey && triageOk && list.rows.length ? (
          <button type="button" onClick={onStartTriage} className="flex h-44 w-full items-center gap-8 border-0 border-b border-line bg-transparent px-14 text-left">
            <span className="t-body-s text-muted">Go through them one at a time</span>
            <span className="link ml-auto">Triage →</span>
          </button>
        ) : null}
        {list.rows.length === 0 ? (
          <p className="t-body-s p-14 text-muted">
            {search.trim() || activeFilters
              ? // Searching or filtering: say so, and where the matches are, not "Nothing due".
                `No match${pick === "due" ? " due now" : ` in ${pickStage?.label ?? "this stage"}`}${
                  rows.length ? ` · ${num(rows.length)} in other stages` : ""
                }.`
              : pick === "due"
                ? "Nothing due."
                : `Nobody in ${pickStage?.label ?? "this stage"} yet.`}
          </p>
        ) : null}
        <div ref={listRef} role="list" style={{ height: tops[tops.length - 1], position: "relative" }}>
          {stuck && stuck.shift > -GROUP_H ? (
            <div className="sticky z-[2] h-0 overflow-visible" style={{ top: stickyTop }}>
              <div style={{ transform: `translateY(${stuck.shift}px)` }}>{groupHead(stuck.row)}</div>
            </div>
          ) : null}
          {list.rows.slice(win.start, win.end).map((r, k) => {
            const i = win.start + k;
            const style = { position: "absolute" as const, top: tops[i], left: 0, right: 0 };
            if (r.kind === "group") return groupHead(r, style);
            const p = r.p;
            const id = p.investor.id;
            const slot = cardSlot(p, today, round.currency, { timeZone: viewerTz });
            const isSel = selected?.has(id) ?? false;
            // Inside a priority group every row has the same priority: the header says it.
            const prio = list.grouped ? null : p.stage.kind === "won" || p.stage.kind === "lost" ? null : cardPriority(p.fit);
            const who = p.investor.firm || p.investor.title || "";
            const showStage = pick === "due";
            return (
              <div
                key={id}
                role="listitem"
                style={{ ...style, height: ROW_H }}
                className={cn("flex items-center border-b border-line", isSel && "bg-accent-soft")}
              >
                {anySel ? (
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggle(id)}
                    aria-label={`Select ${p.investor.name}`}
                    className="ml-14 size-20 shrink-0 accent-[var(--accent)]"
                  />
                ) : null}
                <button
                  type="button"
                  className={cn("flex h-full min-w-0 flex-1 flex-col justify-center gap-2 border-0 bg-transparent px-14 text-left", canWrite && selected && "rb-press")}
                  onPointerDown={() => {
                    pressed.current = false;
                    if (!canWrite || !selected) return;
                    press.current = setTimeout(() => {
                      pressed.current = true;
                      toggle(id);
                    }, 500);
                  }}
                  onPointerUp={() => press.current && clearTimeout(press.current)}
                  onPointerLeave={() => press.current && clearTimeout(press.current)}
                  // A scroll that starts on a row cancels the pointer: no select mid-scroll.
                  onPointerCancel={() => press.current && clearTimeout(press.current)}
                  onContextMenu={(e) => canWrite && e.preventDefault()}
                  onClick={() => {
                    if (pressed.current) return;
                    if (anySel) toggle(id);
                    else onOpen(id);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-8">
                    <span className="min-w-0 flex-1 truncate text-[15.5px] font-semibold">{p.investor.name}</span>
                    {prio ? (
                      <Chip tone={prio} className="shrink-0">
                        {PRIORITY_LABEL[prio]}
                      </Chip>
                    ) : null}
                  </span>
                  <span className="flex min-w-0 items-center gap-8">
                    <span className="t-body-s inline-flex min-w-0 flex-1 items-center gap-6 text-muted">
                      {showStage ? (
                        <>
                          <StageDot color={p.stage.color} />
                          <span className="shrink-0">{p.stage.label}</span>
                          {who ? <span aria-hidden>·</span> : null}
                        </>
                      ) : null}
                      <span className="min-w-0 truncate">{who}</span>
                    </span>
                    {slot ? (
                      slot.kind === "meeting" ? (
                        <Chip tone={slot.today ? "soon" : "type"} title={slot.title} className="shrink-0">
                          {slot.text}
                        </Chip>
                      ) : slot.kind === "due" || slot.kind === "money" || slot.kind === "soon" ? (
                        <Chip tone={slot.kind === "due" ? "due" : slot.kind === "money" ? "money" : "soon"} className="shrink-0">
                          {slot.text}
                        </Chip>
                      ) : (
                        <span className="shrink-0 font-mono text-[12px] text-muted">{slot.text}</span>
                      )
                    ) : null}
                  </span>
                  <span className={cn("t-body-s block truncate", p.next_step ? "text-fg/80" : "text-faint")}>
                    {p.next_step ? `→ ${p.next_step}` : "No next step"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </section>
      <div className={anySel ? "h-120" : "h-8"} aria-hidden />
    </div>
  );
}
