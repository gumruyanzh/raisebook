"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button, Chip, FitMeter, SearchInput, StageDot } from "@/components/ui";
import type { Participant, Priority, Round, Stage } from "@/lib/api/types";
import { INSTRUMENT_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { money, moneyCompact, num, priorityFromFit } from "@/lib/format";
import { cardSlot, GROUP_LABEL, hiddenPipFit, nextUpBuckets, PRIORITY_ORDER, type NextUpBucket } from "@/lib/pipeline";

import { bucketCopy, dueRows, dueText, stripMessage, type LedgerFacts } from "./PipelineLedger";

/** Two lines in 48px: about nine investors above the fold once the list is scrolled. */
const ROW_H = 48;
const GROUP_H = 40;

type Row = { kind: "group"; priority: Priority; ids: string[] } | { kind: "row"; p: Participant };

/**
 * The phone pipeline (DECISION §7.1): no board. A Sorted card with Start triage before money
 * exists (else a compact ledger), Follow up now, stage pills, search, and one stage as a ruled
 * list (grouped by priority when New is long), windowed against the page scroll.
 */
export function PipelinePhone({
  round,
  stages,
  rows,
  all,
  openKey,
  facts,
  moneyOn,
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
  onBucket,
  onOpen,
  onStartTriage,
  onFilters,
  activeFilters,
  search,
  onSearch,
  base,
  onListChange,
  stickyTop = 0,
  onAdd,
}: {
  round: Round;
  stages: Stage[];
  /** The filtered rows (search, filters; the stage filter when the URL has one). */
  rows: Participant[];
  all: Participant[];
  openKey: string | null;
  facts: LedgerFacts;
  moneyOn: boolean;
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
  onBucket: (b: NextUpBucket) => void;
  onOpen: (id: string) => void;
  onStartTriage: () => void;
  onFilters: () => void;
  activeFilters: number;
  search: string;
  onSearch: (v: string) => void;
  base: string;
  /** The ids in the list on screen (the sheet's ↑/↓ walk this list, not the whole round). */
  onListChange?: (ids: string[]) => void;
  /** Height of the sticky top bar: a long list's group header sticks under it. */
  stickyTop?: number;
  /** Opens Add investor (writers only): the phone's way to add after the first investor. */
  onAdd?: () => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of all) c[p.stage.key] = (c[p.stage.key] ?? 0) + 1;
    return c;
  }, [all]);
  const firstWithInvestors = stages.find((s) => counts[s.key])?.key ?? stages[0]?.key ?? "";
  const pick = dueOnly ? "due" : stage || (dueTotal > 0 ? "due" : firstWithInvestors);
  const pickStage = stages.find((s) => s.key === pick);
  const list = useMemo(() => {
    const inPick =
      pick === "due" ? dueRows(rows) : rows.filter((p) => p.stage.key === pick);
    // Fit groups for a not-contacted stage of 12+, as on the board (no rows of identical pips).
    const grouped = pickStage?.kind === "open" && inPick.length >= 12;
    // Pips as on the board: none past the open stages, and not on the fit most cards share.
    const pipHidden = grouped ? null : hiddenPipFit(pickStage ?? { kind: "active" }, inPick.map((p) => p.fit));
    if (!grouped) return { grouped, pipHidden, rows: inPick.map((p) => ({ kind: "row", p }) as Row) };
    const by: Record<Priority, Participant[]> = { hot: [], warm: [], maybe: [], low: [] };
    for (const p of inPick) by[priorityFromFit(p.fit)].push(p);
    const out: Row[] = [];
    for (const pr of PRIORITY_ORDER) {
      if (!by[pr].length) continue;
      out.push({ kind: "group", priority: pr, ids: by[pr].map((p) => p.investor.id) });
      for (const p of by[pr]) out.push({ kind: "row", p });
    }
    return { grouped, pipHidden: null, rows: out };
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

  const msg = stripMessage(facts, stages.find((s) => s.key === openKey)?.label ?? "New");
  const sorted = facts.total - facts.openCount;
  const due = dueRows(all);
  const buckets = nextUpBuckets(all, openKey, today, Date.now()).filter((b) => canWrite || b.id !== "new");
  const sub = moneyOn
    ? [INSTRUMENT_LABEL[round.instrument], facts.daysToClose !== null && facts.daysToClose >= 0 ? `${num(facts.daysToClose)} days left` : null]
    : [INSTRUMENT_LABEL[round.instrument], `${moneyCompact(round.target_amount, round.currency)} target`];
  const pctC = round.target_amount ? Math.min(100, (facts.committed / round.target_amount) * 100) : 0;
  const pctS = round.target_amount ? Math.min(100 - pctC, (facts.soft / round.target_amount) * 100) : 0;
  const pill = (key: string, label: string, n: number, dot?: Stage["color"], bad = false) => {
    const on = pick === key;
    return (
      <button
        key={key}
        type="button"
        aria-pressed={on}
        onClick={() => (key === "due" ? onDue() : onStage(key))}
        className={cn(
          "inline-flex h-40 shrink-0 items-center gap-8 rounded-pill border px-14 whitespace-nowrap",
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
            className="link border-0 bg-transparent p-0"
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
    <div className={cn("flex flex-col gap-12", canWrite && onAdd && "pb-64")}>
      {canWrite && onAdd && !anySel ? (
        // Always in reach on a phone, whatever the list's length (the title-row button is
        // desktop-only). Above the page bottom inset on notched phones.
        <div className="fixed right-16 z-30" style={{ bottom: "calc(16px + env(safe-area-inset-bottom))" }}>
          <Button
            variant="primary"
            onClick={onAdd}
            aria-label="Add investor"
            className="h-48 rounded-pill px-18 text-[16px] shadow-menu"
          >
            + Investor
          </Button>
        </div>
      ) : null}
      {/* The round picker above already says "Seed": the terms only (critique 3: Seed twice). */}
      <div className="-mt-4 flex h-20 items-center gap-10">
        <h1 className="sr-only">{round.name}</h1>
        <span className="t-micro min-w-0 truncate text-muted uppercase">{sub.filter(Boolean).join(" · ")}</span>
        {canWrite ? (
          <span className="ml-auto flex shrink-0 items-center gap-14">
            <Link href={`${base}/import?round=${encodeURIComponent(round.slug)}`} className="link t-body-s">
              Import
            </Link>
            <Link href={`${base}/r/${encodeURIComponent(round.slug)}/settings`} className="link t-body-s">
              Edit round
            </Link>
          </span>
        ) : null}
      </div>

      {moneyOn ? (
        <section aria-label={`${round.name} summary`} className="rounded-md border border-line bg-surface p-14">
          <p className="font-display text-[24px] font-bold tnum">
            <span className="text-good-ink">{money(facts.committed, round.currency)}</span>{" "}
            <span className="text-[15px] font-medium text-muted">of {moneyCompact(round.target_amount, round.currency)}</span>
          </p>
          <div className="mt-8 flex h-8 overflow-hidden rounded-pill bg-sunk" aria-hidden>
            <i className="block h-full bg-good not-italic" style={{ width: `${pctC}%` }} />
            <i className="block h-full not-italic" style={{ width: `${pctS}%`, background: "color-mix(in oklab, var(--good) 30%, var(--sunk))" }} />
          </div>
          <p className="t-body-s mt-8 text-muted">
            <b className="text-fg">{num(facts.committedCount)}</b> committed · <b className="text-fg">{moneyCompact(facts.soft, round.currency)}</b> soft ·{" "}
            <b className="text-fg">{num(facts.talking)}</b> talking
          </p>
        </section>
      ) : (
        <section aria-label="Sorted" className="flex flex-col gap-10 rounded-md border border-line bg-surface p-14">
          <div className="flex items-center gap-10">
            <span className="t-label">Sorted</span>
            <span className="h-6 flex-1 overflow-hidden rounded-pill bg-sunk" aria-hidden>
              <i className="block h-full bg-good not-italic" style={{ width: `${facts.total ? (sorted / facts.total) * 100 : 0}%` }} />
            </span>
            <span className="text-muted">
              <b className="text-fg tnum">{num(sorted)}</b> of {num(facts.total)}
            </span>
          </div>
          <p className="text-muted">{msg.text}</p>
          {msg.triage && triageOk ? (
            <Button variant="primary" className="h-48 w-full text-[16px]" onClick={onStartTriage}>
              Start triage
            </Button>
          ) : null}
        </section>
      )}

      {moneyOn && due.length && pick !== "due" ? (
        <section aria-label="Follow up now" className="rounded-md border border-line bg-surface px-14 py-10">
          <p className="t-label mb-4 flex">
            Follow up now
            <button type="button" onClick={onDue} className="link t-body-s ml-auto border-0 bg-transparent p-0 normal-case tracking-normal">
              All {num(due.length)} →
            </button>
          </p>
          {due.slice(0, 3).map((p) => (
            <button
              key={p.investor.id}
              type="button"
              onClick={() => onOpen(p.investor.id)}
              className="flex h-44 w-full min-w-0 items-center gap-8 border-0 border-t border-line bg-transparent px-0 text-left first-of-type:border-t-0"
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
        </section>
      ) : null}

      {showPills ? (
        <div className="-mx-16 flex gap-8 overflow-x-auto px-16 scrollbar-none" role="group" aria-label="Stage">
          {dueTotal > 0 ? pill("due", "Due now", dueTotal, undefined, true) : null}
          {pillStages.map((s) => pill(s.key, s.label, counts[s.key] ?? 0, s.color))}
        </div>
      ) : null}

      <div className="flex gap-8">
        <SearchInput placeholder="Search investors…" aria-label="Search investors" value={search} onChange={(e) => onSearch(e.target.value)} />
        <Button onClick={onFilters}>
          Filter{activeFilters ? <span className="font-mono text-[12px] text-accent">{activeFilters}</span> : null}
        </Button>
      </div>

      {/* overflow-clip (not hidden): the sticky group header follows the page scroll. */}
      <section aria-label={pick === "due" ? "Due now" : (pickStage?.label ?? "")} className="overflow-clip rounded-md border border-line bg-surface">
        {/* One way into Triage per screen (critique 3): the Sorted card's button before money
            exists; afterwards one line here, without repeating the pill's name and count. */}
        {moneyOn && pickStage && pick === openKey && triageOk && list.rows.length ? (
          <button type="button" onClick={onStartTriage} className="flex h-40 w-full items-center gap-8 border-0 border-b border-line bg-transparent px-14 text-left">
            <span className="t-body-s text-muted">Go through them one at a time</span>
            <span className="link ml-auto">Triage →</span>
          </button>
        ) : null}
        {list.rows.length === 0 ? (
          <p className="t-body-s p-14 text-muted">{pick === "due" ? "Nothing due." : `Nobody in ${pickStage?.label ?? "this stage"} yet.`}</p>
        ) : null}
        <div ref={listRef} style={{ height: tops[tops.length - 1], position: "relative" }}>
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
            const slot = cardSlot(p, today, round.currency);
            const isSel = selected?.has(id) ?? false;
            return (
              <div key={id} style={{ ...style, height: ROW_H }} className={cn("flex items-center border-b border-line", isSel && "bg-accent-soft")}>
                {anySel ? (
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggle(id)}
                    aria-label={`Select ${p.investor.name}`}
                    className="ml-14 size-18 shrink-0 accent-[var(--accent)]"
                  />
                ) : null}
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 flex-col justify-center gap-2 border-0 bg-transparent px-14 text-left"
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
                  onContextMenu={(e) => canWrite && e.preventDefault()}
                  onClick={() => {
                    if (pressed.current) return;
                    if (anySel) toggle(id);
                    else onOpen(id);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-8">
                    <span className="min-w-0 flex-1 truncate font-semibold">{p.investor.name}</span>
                    {/* Inside Hot, Warm or Maybe every row has the same fit: the header says it. */}
                    {list.pipHidden === "all" || list.pipHidden === p.fit || (list.grouped && priorityFromFit(p.fit) !== "low") ? null : (
                      <FitMeter value={p.fit} />
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-8">
                    <span className="t-body-s min-w-0 flex-1 truncate text-muted">{p.investor.firm || p.investor.title || ""}</span>
                    {slot ? (
                      slot.kind === "due" || slot.kind === "money" || slot.kind === "soon" ? (
                        <Chip tone={slot.kind === "due" ? "due" : slot.kind === "money" ? "money" : "soon"}>{slot.text}</Chip>
                      ) : (
                        <span className="font-mono text-[12px] text-muted">{slot.text}</span>
                      )
                    ) : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {moneyOn && buckets.length ? (
        <section aria-label="Next up" className="rounded-md border border-line bg-surface px-14 py-10">
          <p className="t-label mb-4">Next up</p>
          {buckets.slice(0, 3).map((b) => {
            const c = bucketCopy(b, stages.find((s) => s.key === openKey)?.label ?? "New");
            return (
              // Counts sit on the card's left edge, under the label, on the sentence's first line.
              <div key={b.id} className="grid min-h-40 grid-cols-[minmax(28px,auto)_minmax(0,1fr)_auto] items-baseline gap-x-10 py-6">
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
                <button type="button" className="link t-body-s border-0 bg-transparent p-0" onClick={() => onBucket(b)}>
                  {c.link}
                </button>
              </div>
            );
          })}
        </section>
      ) : null}
      <div className={anySel ? "h-120" : "h-8"} aria-hidden />
    </div>
  );
}
