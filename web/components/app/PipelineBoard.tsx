"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Board, BoardCard, BoardColumn, EmptyStages, Menu, StageDot } from "@/components/ui";
import { CARD_GAP, CARD_H, CARD_H_STEP } from "@/components/ui/Board";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import type { Participant, Priority, Round, Stage } from "@/lib/api/types";
import { PRIORITY_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact, num, priorityFromFit } from "@/lib/format";
import {
  boardSegments,
  cardSlot,
  GROUP_LABEL,
  PRIORITY_ORDER,
  segmentTrack,
  STAGE_MEANING,
  triageTargets,
  type TriageSlice,
} from "@/lib/pipeline";

import { byFit } from "./util";

export interface AgentMark {
  label: string;
  tip: string;
}

export type BoardSort = "fit" | "due" | "activity" | "name";

export const BOARD_SORTS: { value: BoardSort; label: string }[] = [
  { value: "fit", label: "Fit" },
  { value: "due", label: "Due first" },
  { value: "activity", label: "Last activity" },
  { value: "name", label: "Name" },
];

const FAR = "9999-12-31";

/** Card order within a column. "fit" is the prototype's byFit (fit, follow-up, name). */
export function sortCards(cards: Participant[], sort: BoardSort): Participant[] {
  const out = [...cards];
  switch (sort) {
    case "due":
      return out.sort(
        (a, b) =>
          (a.follow_up_on ?? FAR).localeCompare(b.follow_up_on ?? FAR) || b.fit - a.fit || a.investor.name.localeCompare(b.investor.name),
      );
    case "activity":
      return out.sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") || byFit(a, b));
    case "name":
      return out.sort((a, b) => a.investor.name.localeCompare(b.investor.name));
    default:
      return out.sort(byFit);
  }
}

/** The fill per priority group (the bar under the dominant New column). */
const PRIO_FILL: Record<Priority, string> = { hot: "bg-hot", warm: "bg-warm", maybe: "bg-maybe", low: "bg-faint" };

interface ColumnApi {
  scrollToIndex: (cardIndex: number) => boolean;
  /**
   * The card next to `idx` in a direction, for columns laid out as a grid (the wide New
   * column): undefined when the column is a plain list (the board's default moves apply),
   * null when there is nothing that way inside the column.
   */
  neighbor: (idx: number, dir: "up" | "down" | "left" | "right") => number | null | undefined;
}

/**
 * The pipeline board (DECISION §5.2–§5.5, critique 1). One column per stage and never a rail:
 * the dominant stage gets at least 352px and lays its cards out in as many columns as fit, a
 * stage with cards 232px, a lone empty stage 136px with a "Drop here" zone, and a run of two
 * or more empty stages shares one narrow track of stacked drop zones. So the 411-in-New round
 * and the round after its first session both fit 1440px, and a mature round scrolls sideways
 * (a pill in the toolbar reaches the end stages). The board fills the viewport and only the
 * columns scroll, each windowed (cards are 52px). The dominant New column adds a priority
 * bar and groups its cards by priority with "Select N".
 *
 * Keyboard (one tab stop): arrows or J/K move, Enter opens, Alt+→ / Alt+← moves a card one
 * stage (skipping the lost stage), M opens "Move to…" (digits pick a stage), X selects,
 * Shift+↑/↓ extends the selection. Bare digits never write on the board.
 */
export function PipelineBoard({
  round,
  stages,
  columns,
  sorts,
  onSortChange,
  agentMarks,
  today,
  canWrite,
  showNextStep,
  filtered,
  height,
  openId,
  focusReq,
  openKey,
  dominantKey,
  activePrio,
  onPrioFilter,
  onTriage,
  selected,
  onSelectedChange,
  onOpen,
  onFocusMove,
  onMove,
  onMoveMany,
  endSlot,
}: {
  round: Round;
  stages: Stage[];
  /** Filtered cards per stage, already sorted. */
  columns: { stage: Stage; cards: Participant[] }[];
  sorts: Record<string, BoardSort>;
  onSortChange: (stageKey: string, sort: BoardSort) => void;
  agentMarks: Record<string, AgentMark>;
  today: string;
  canWrite: boolean;
  showNextStep: boolean;
  /** Filters or search are applied (the empty-column copy changes). */
  filtered: boolean;
  /** Fill height in px. */
  height: number | null;
  openId?: string | null;
  focusReq: { id: string; n: number } | null;
  /** The open stage `O` (New). */
  openKey: string | null;
  /** The stage holding most of the round (over all investors, not the filtered view). */
  dominantKey: string | null;
  activePrio?: Priority | "";
  onPrioFilter?: (p: Priority | null) => void;
  /** "Triage →" in the New header and its fit groups (writers, while New has investors). */
  onTriage?: (slice?: TriageSlice) => void;
  selected: Set<string> | null;
  onSelectedChange: (next: Set<string>) => void;
  onOpen: (investorId: string) => void;
  /** With the split sheet open, keyboard moves open the card they land on. */
  onFocusMove?: (investorId: string) => void;
  /** Returns false when the move failed (the card snaps back). */
  onMove: (investorId: string, stageKey: string) => Promise<boolean>;
  /** One bulk request (dragging or "Move to…" with several selected). */
  onMoveMany: (investorIds: string[], stageKey: string) => void;
  /** Where the end-stage pill goes (a slot in the toolbar), so it never covers cards. */
  endSlot?: HTMLElement | null;
}) {
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const apis = useRef<Record<string, ColumnApi>>({});
  const sel = selected ?? EMPTY;
  const anySelected = sel.size > 0;

  // Opening or closing the split sheet reflows the board under a still pointer, which would
  // hover a different card than the open one (two highlights read as two selections). Hover
  // styles wait for the pointer to move.
  const [hoverOff, setHoverOff] = useState(false);
  const sheetOpen = Boolean(openId);
  const lastSheet = useRef(sheetOpen);
  useEffect(() => {
    if (lastSheet.current === sheetOpen) return;
    lastSheet.current = sheetOpen;
    setHoverOff(true);
    const on = () => setHoverOff(false);
    window.addEventListener("pointermove", on, { once: true });
    window.addEventListener("wheel", on, { once: true, passive: true });
    return () => {
      window.removeEventListener("pointermove", on);
      window.removeEventListener("wheel", on);
    };
  }, [sheetOpen]);

  const segments = useMemo(() => boardSegments(columns.map((c) => ({ key: c.stage.key, count: c.cards.length }))), [columns]);
  const lostKey = useMemo(() => columns.find((c) => c.stage.kind === "lost")?.stage.key ?? null, [columns]);
  const template = segments.map((g) => segmentTrack(g, dominantKey, lostKey)).join(" ");
  const colByKey = useMemo(() => new Map(columns.map((c, i) => [c.stage.key, { c, i }])), [columns]);

  /* ---------- the right edge: fade and the end-stage pill ---------- */
  const [fade, setFade] = useState(false);
  const [offEnds, setOffEnds] = useState<string[]>([]);
  const endKeys = useMemo(
    () => columns.filter((c) => c.stage.kind === "won" || c.stage.kind === "lost").map((c) => c.stage.key),
    [columns],
  );
  const updateEdge = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    const right = el.scrollLeft + el.clientWidth;
    setFade(el.scrollWidth - right > 4);
    const off: string[] = [];
    for (const key of endKeys) {
      if (!colByKey.get(key)?.c.cards.length) continue;
      const col = el.querySelector<HTMLElement>(`[data-stage="${CSS.escape(key)}"]`);
      if (col && col.offsetLeft + 40 > right) off.push(key);
    }
    setOffEnds((prev) => (prev.join() === off.join() ? prev : off));
  }, [endKeys, colByKey]);
  useEffect(() => {
    updateEdge();
    window.addEventListener("resize", updateEdge);
    const ro = typeof ResizeObserver !== "undefined" && boardRef.current ? new ResizeObserver(updateEdge) : null;
    if (ro && boardRef.current) ro.observe(boardRef.current);
    return () => {
      window.removeEventListener("resize", updateEdge);
      ro?.disconnect();
    };
  }, [updateEdge, template]);

  const where = useMemo(() => {
    const m = new Map<string, { col: number; idx: number }>();
    columns.forEach((c, col) => c.cards.forEach((p, idx) => m.set(p.investor.id, { col, idx })));
    return m;
  }, [columns]);

  const focusCard = useCallback(
    (investorId: string) => {
      const at = where.get(investorId);
      if (!at) return;
      const key = columns[at.col]!.stage.key;
      apis.current[key]?.scrollToIndex(at.idx);
      setActiveId(investorId);
      const tryFocus = (n: number) =>
        requestAnimationFrame(() => {
          const el = boardRef.current?.querySelector<HTMLButtonElement>(`[data-investor="${CSS.escape(investorId)}"]`);
          if (el) {
            el.focus({ preventScroll: true });
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
          } else if (n > 0) tryFocus(n - 1);
        });
      tryFocus(3);
    },
    [where, columns],
  );

  useEffect(() => {
    if (focusReq) requestAnimationFrame(() => focusCard(focusReq.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq]);

  const move = useCallback(
    async (investorId: string, key: string) => {
      const at = where.get(investorId);
      const p = at ? columns[at.col]!.cards[at.idx] : undefined;
      if (!p || p.stage.key === key) return;
      await onMove(investorId, key);
      focusCard(investorId);
    },
    [where, columns, onMove, focusCard],
  );

  /* ---------- selection ---------- */
  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    anchor.current = id;
    onSelectedChange(next);
  };
  const extendTo = (id: string) => {
    const a = anchor.current && where.get(anchor.current);
    const b = where.get(id);
    if (!a || !b || a.col !== b.col) return toggle(id);
    const cards = columns[b.col]!.cards;
    const [lo, hi] = a.idx < b.idx ? [a.idx, b.idx] : [b.idx, a.idx];
    const next = new Set(sel);
    for (let i = lo; i <= hi; i++) next.add(cards[i]!.investor.id);
    onSelectedChange(next);
  };
  const selectMany = (ids: string[]) => {
    const next = new Set(sel);
    const all = ids.every((id) => next.has(id));
    for (const id of ids) {
      if (all) next.delete(id);
      else next.add(id);
    }
    onSelectedChange(next);
  };

  // Keyboard path skips the lost stage (reachable only through the menu).
  const keyPath = useMemo(() => stages.filter((s) => s.kind !== "lost"), [stages]);
  const accel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of triageTargets(stages)) if (t.key) m[t.stage.key] = t.key;
    return m;
  }, [stages]);

  const onCardKey = (e: KeyboardEvent<HTMLButtonElement>, p: Participant) => {
    const at = where.get(p.investor.id);
    if (!at) return;
    if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      if (!canWrite) return;
      e.preventDefault();
      const i = keyPath.findIndex((s) => s.key === p.stage.key);
      const from = i < 0 ? keyPath.length : i; // from the lost stage, Alt+← goes back
      const next = keyPath[from + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) void move(p.investor.id, next.key);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const col = columns[at.col]!;
    const go = (colIdx: number, idx: number, extend = false) => {
      const c = columns[colIdx];
      const target = c?.cards[Math.max(0, Math.min(c.cards.length - 1, idx))];
      if (target) {
        e.preventDefault();
        if (extend && canWrite && selected) {
          if (!anchor.current) anchor.current = p.investor.id;
          const next = new Set(sel).add(p.investor.id).add(target.investor.id);
          onSelectedChange(next);
        }
        focusCard(target.investor.id);
        onFocusMove?.(target.investor.id);
      }
    };
    const sideways = (dir: 1 | -1) => {
      const inside = apis.current[col.stage.key]?.neighbor(at.idx, dir === 1 ? "right" : "left");
      if (typeof inside === "number") return go(at.col, inside);
      for (let c = at.col + dir; c >= 0 && c < columns.length; c += dir) {
        if (columns[c]!.cards.length) return go(c, Math.min(at.idx, columns[c]!.cards.length - 1));
      }
    };
    const vertical = (dir: 1 | -1) => {
      const n = apis.current[col.stage.key]?.neighbor(at.idx, dir === 1 ? "down" : "up");
      if (n === null) return e.preventDefault();
      return go(at.col, n ?? at.idx + dir, e.shiftKey);
    };
    switch (e.key) {
      case "ArrowDown":
      case "j":
      case "J":
        return vertical(1);
      case "ArrowUp":
      case "k":
      case "K":
        return vertical(-1);
      case "ArrowRight":
        return sideways(1);
      case "ArrowLeft":
        return sideways(-1);
      case "Home":
        return go(at.col, 0);
      case "End":
        return go(at.col, col.cards.length - 1);
      case "PageDown":
        return go(at.col, at.idx + 8);
      case "PageUp":
        return go(at.col, at.idx - 8);
      case "x":
      case "X":
        if (!canWrite || !selected) return;
        e.preventDefault();
        toggle(p.investor.id);
        return;
      case "m":
      case "M":
        if (!canWrite) return;
        e.preventDefault();
        setMenuFor(p.investor.id);
        return;
    }
  };

  const drop = (e: DragEvent, key: string) => {
    e.preventDefault();
    const ids = dragIds ?? [e.dataTransfer.getData("text/plain")].filter(Boolean);
    setOverKey(null);
    setDragIds(null);
    if (ids.length > 1) onMoveMany(ids, key);
    else if (ids[0]) void move(ids[0], key);
  };

  // One tab stop: the active card, else the first card on the board.
  const firstId = columns.find((c) => c.cards.length)?.cards[0]?.investor.id ?? null;
  const tabStop = activeId && where.has(activeId) ? activeId : firstId;

  const scrollToEnds = () => {
    const el = boardRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  };
  // Only end stages with someone in them: "Committed 0 · Passed 0" says nothing.
  const endCols = columns.filter((c) => offEnds.includes(c.stage.key) && c.cards.length > 0);

  return (
    <div className="relative">
      <Board
        ref={boardRef}
        role="group"
        aria-label={`${round.name} board`}
        aria-keyshortcuts={canWrite ? "ArrowUp ArrowDown ArrowLeft ArrowRight Enter Alt+ArrowRight Alt+ArrowLeft M X" : undefined}
        columns={template}
        onScroll={updateEdge}
        className="min-h-0! grid-rows-[100%] pb-6!"
        // No hit-testing (so no :hover) until the pointer moves again.
        style={{ height: height ?? "70vh", ...(hoverOff ? { pointerEvents: "none" } : null) }}
      >
        {segments.map((seg) => {
          if (seg.kind === "empty") {
            return (
              <EmptyStages
                key={`empty-${seg.keys.join("-")}`}
                stages={seg.keys.map((k) => {
                  const st = colByKey.get(k)!.c.stage;
                  return { key: st.key, label: st.label, color: st.color, meaning: STAGE_MEANING[st.key] ?? null };
                })}
                readOnly={!canWrite}
                filtered={filtered}
                dragCount={dragIds !== null && canWrite ? dragIds.length : 0}
                overKey={overKey}
                onDragOver={
                  canWrite
                    ? (k, e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (overKey !== k) setOverKey(k);
                      }
                    : undefined
                }
                onDragLeave={(k, e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverKey((x) => (x === k ? null : x));
                }}
                onDrop={canWrite ? (k, e) => drop(e, k) : undefined}
              />
            );
          }
          const { stage: s, cards } = colByKey.get(seg.key)!.c;
          const sort = sorts[s.key] ?? "fit";
          const isOpen = s.key === openKey;
          const grouped = isOpen && s.key === dominantKey;
          return (
            <StageColumn
              key={s.key}
              stage={s}
              cards={cards}
              grouped={grouped}
              sort={sort}
              onSortChange={(v) => onSortChange(s.key, v)}
              currency={round.currency}
              readOnly={!canWrite}
              filtered={filtered}
              showNextStep={showNextStep}
              agentMarks={agentMarks}
              today={today}
              canWrite={canWrite}
              selectable={canWrite && Boolean(selected)}
              anySelected={anySelected}
              selected={sel}
              tabStop={tabStop}
              openId={openId ?? null}
              dragIds={dragIds}
              isDropTarget={dragIds !== null && canWrite}
              activePrio={activePrio ?? ""}
              onPrioFilter={grouped ? onPrioFilter : undefined}
              onSelectGroup={canWrite && selected ? selectMany : undefined}
              onTriageGroup={grouped && onTriage ? onTriage : undefined}
              headerAction={
                isOpen && onTriage && cards.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => onTriage()}
                    className="t-body-s ml-4 shrink-0 border-0 bg-transparent p-0 font-medium whitespace-nowrap text-accent hover:underline"
                    title="Sort New one investor at a time (T)"
                  >
                    Triage →
                  </button>
                ) : null
              }
              registerApi={(api) => {
                if (api) apis.current[s.key] = api;
                else delete apis.current[s.key];
              }}
              onDragOver={
                canWrite
                  ? (e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overKey !== s.key) setOverKey(s.key);
                    }
                  : undefined
              }
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverKey((k) => (k === s.key ? null : k));
              }}
              onDrop={canWrite ? (e) => drop(e, s.key) : undefined}
              renderMenu={(p) => {
                if (menuFor !== p.investor.id) return null;
                const many = sel.has(p.investor.id) && sel.size > 1;
                return (
                  <Menu
                    label={many ? `Move ${num(sel.size)} selected to` : `Move ${p.investor.name} to`}
                    open
                    onOpenChange={(o) => {
                      if (!o) {
                        setMenuFor(null);
                        focusCard(p.investor.id);
                      }
                    }}
                    className="absolute! inset-x-0 top-full h-0"
                    items={[
                      { type: "label", label: many ? `Move ${num(sel.size)} to` : "Move to" },
                      ...stages.map((st) => ({
                        label: st.label,
                        icon: <StageDot color={st.color} />,
                        selected: !many && st.key === p.stage.key,
                        accel: accel[st.key],
                        onSelect: () => {
                          setMenuFor(null);
                          if (many) onMoveMany([...sel], st.key);
                          else void move(p.investor.id, st.key);
                        },
                      })),
                    ]}
                  />
                );
              }}
              onCardFocus={setActiveId}
              onCardKey={onCardKey}
              onCardClick={(e, id) => {
                if (canWrite && selected && e.shiftKey) {
                  e.preventDefault();
                  extendTo(id);
                } else if (canWrite && selected && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  toggle(id);
                } else onOpen(id);
              }}
              onToggle={toggle}
              onDragStart={(id) => setDragIds(sel.has(id) && sel.size > 1 ? [...sel] : [id])}
              onDragEnd={() => {
                setDragIds(null);
                setOverKey(null);
              }}
            />
          );
        })}
      </Board>
      {fade ? (
        <div aria-hidden className="pointer-events-none absolute top-0 right-0 bottom-8 w-48 bg-linear-to-l from-canvas to-transparent" />
      ) : null}
      {endCols.length && endSlot
        ? createPortal(
            <button
              type="button"
              onClick={scrollToEnds}
              title="Scroll to the end stages"
              className="inline-flex h-28 shrink-0 items-center gap-8 rounded-pill border border-line bg-surface px-10 text-sm whitespace-nowrap hover:border-accent"
            >
              {endCols.map((c, i) => {
                const amount = c.stage.kind === "won" ? c.cards.reduce((n, p) => n + (p.amount_committed ?? 0), 0) : 0;
                return (
                  <span key={c.stage.key} className="inline-flex items-center gap-6">
                    {i > 0 ? <span className="text-muted">·</span> : null}
                    <StageDot color={c.stage.color} />
                    <span className="font-medium">{c.stage.label}</span>
                    {amount > 0 ? <span className="font-mono text-[12px] text-good-ink">{moneyCompact(amount, round.currency)}</span> : null}
                    <span className="font-mono text-[12px] text-muted">{num(c.cards.length)}</span>
                  </span>
                );
              })}
              <span aria-hidden className="text-accent">
                →
              </span>
            </button>,
            endSlot,
          )
        : null}
      {canWrite ? (
        <p className="sr-only">
          Use the arrow keys to move between cards and columns, Enter to open a file, Alt with the left or right arrow to
          move a card one stage, M for Move to, and X to select.
        </p>
      ) : null}
    </div>
  );
}

const EMPTY = new Set<string>();
const GROUP_H = 28;

/** A wide dominant column lays cards out in columns at least this wide. */
const GRID_MIN_W = 236;
const GRID_GAP = 8;

type Row =
  | { kind: "group"; priority: Priority; ids: string[] }
  /** One line of cards: one card in a plain column, up to `perRow` in the wide New column. */
  | { kind: "cards"; items: { p: Participant; idx: number }[] };

function StageColumn({
  stage: s,
  cards,
  grouped,
  sort,
  onSortChange,
  currency,
  readOnly,
  filtered,
  showNextStep,
  agentMarks,
  today,
  canWrite,
  selectable,
  anySelected,
  selected,
  tabStop,
  openId,
  dragIds,
  isDropTarget,
  activePrio,
  onPrioFilter,
  onSelectGroup,
  onTriageGroup,
  headerAction,
  registerApi,
  onDragOver,
  onDragLeave,
  onDrop,
  renderMenu,
  onCardFocus,
  onCardKey,
  onCardClick,
  onToggle,
  onDragStart,
  onDragEnd,
}: {
  stage: Stage;
  cards: Participant[];
  grouped: boolean;
  sort: BoardSort;
  onSortChange: (s: BoardSort) => void;
  currency: string;
  readOnly: boolean;
  filtered: boolean;
  showNextStep: boolean;
  agentMarks: Record<string, AgentMark>;
  today: string;
  canWrite: boolean;
  selectable: boolean;
  anySelected: boolean;
  selected: Set<string>;
  tabStop: string | null;
  openId: string | null;
  dragIds: string[] | null;
  isDropTarget: boolean;
  activePrio: Priority | "";
  onPrioFilter?: (p: Priority | null) => void;
  onSelectGroup?: (ids: string[]) => void;
  /** "Triage these →" on a fit group of the dominant New column. */
  onTriageGroup?: (slice: TriageSlice) => void;
  headerAction?: ReactNode;
  registerApi: (api: ColumnApi | null) => void;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  renderMenu: (p: Participant) => ReactNode;
  onCardFocus: (id: string) => void;
  onCardKey: (e: KeyboardEvent<HTMLButtonElement>, p: Participant) => void;
  onCardClick: (e: MouseEvent, id: string) => void;
  onToggle: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const won = s.kind === "won";
  const cardH = (showNextStep ? CARD_H_STEP : CARD_H) + CARD_GAP;

  // The wide New column fits several cards per line (critique 1: 9 visible of 411 was too few).
  const [perRow, setPerRow] = useState(1);
  useEffect(() => {
    const el = body.current;
    if (!grouped || !el) {
      setPerRow(1);
      return;
    }
    const measure = () => setPerRow(Math.max(1, Math.floor((el.clientWidth - 16 + GRID_GAP) / (GRID_MIN_W + GRID_GAP))));
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [grouped]);

  // Grouped (the dominant New column): cards partitioned by priority, keeping the column sort.
  const { rows, groupCounts } = useMemo(() => {
    const counts: Record<Priority, number> = { hot: 0, warm: 0, maybe: 0, low: 0 };
    for (const p of cards) counts[priorityFromFit(p.fit)]++;
    if (!grouped) {
      return {
        rows: cards.map((p, idx) => ({ kind: "cards", items: [{ p, idx }] }) as Row),
        groupCounts: counts,
      };
    }
    const by: Record<Priority, Participant[]> = { hot: [], warm: [], maybe: [], low: [] };
    for (const p of cards) by[priorityFromFit(p.fit)].push(p);
    // The parent passes this column already partitioned by priority (keyboard order = rows).
    const out: Row[] = [];
    let idx = 0;
    for (const pr of PRIORITY_ORDER) {
      if (!by[pr].length) continue;
      out.push({ kind: "group", priority: pr, ids: by[pr].map((p) => p.investor.id) });
      for (let i = 0; i < by[pr].length; i += perRow) {
        out.push({ kind: "cards", items: by[pr].slice(i, i + perRow).map((p) => ({ p, idx: idx++ })) });
      }
    }
    return { rows: out, groupCounts: counts };
  }, [cards, grouped, perRow]);

  const heightAt = useCallback((i: number) => (rows[i]?.kind === "group" ? GROUP_H : cardH), [rows, cardH]);
  const v = useVirtualRows({ scrollRef: body, count: rows.length, height: heightAt, offset: 2, initial: 16 });
  /** card index → [row, place in the row] */
  const placeOf = useMemo(() => {
    const m: [number, number][] = [];
    rows.forEach((r, i) => {
      if (r.kind === "cards") r.items.forEach((it, c) => (m[it.idx] = [i, c]));
    });
    return m;
  }, [rows]);
  const { scrollToIndex, topOf } = v;
  useEffect(() => {
    const neighbor = (idx: number, dir: "up" | "down" | "left" | "right"): number | null | undefined => {
      if (perRow === 1 && !grouped) return undefined;
      const at = placeOf[idx];
      if (!at) return undefined;
      const [r, c] = at;
      const row = rows[r] as Extract<Row, { kind: "cards" }>;
      if (dir === "left") return c > 0 ? row.items[c - 1]!.idx : null;
      if (dir === "right") return c < row.items.length - 1 ? row.items[c + 1]!.idx : null;
      const step = dir === "down" ? 1 : -1;
      for (let i = r + step; i >= 0 && i < rows.length; i += step) {
        const x = rows[i]!;
        if (x.kind === "cards") return x.items[Math.min(c, x.items.length - 1)]!.idx;
      }
      return null;
    };
    registerApi({ scrollToIndex: (i) => scrollToIndex(placeOf[i]?.[0] ?? i), neighbor });
    return () => registerApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex, placeOf, rows, perRow, grouped]);

  // Pips that never vary say nothing: hidden in the lost stage and in a column where every
  // card has the same fit (the grouped New column keeps them; its Low fit group varies).
  const lost = s.kind === "lost";
  const sameFit = !grouped && cards.length > 1 && cards.every((p) => p.fit === cards[0]!.fit);
  const hidePips = lost || sameFit;

  // The sticky group header: the last group that starts at or above the scroll position.
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    if (!grouped) return;
    const el = body.current;
    if (!el) return;
    const on = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [grouped]);
  const stuck = useMemo(() => {
    if (!grouped || scrollTop <= 2) return null;
    let cur: Extract<Row, { kind: "group" }> | null = null;
    rows.forEach((r, i) => {
      if (r.kind === "group" && topOf(i) <= scrollTop) cur = r;
    });
    return cur as Extract<Row, { kind: "group" }> | null;
  }, [grouped, scrollTop, rows, topOf]);

  const total = won ? cards.reduce((sum, p) => sum + (p.amount_committed ?? 0), 0) : 0;
  const due = cards.filter((p) => p.follow_up_state === "overdue" || p.follow_up_state === "today").length;

  const groupHeader = (g: Extract<Row, { kind: "group" }>, sticky = false) => {
    const all = g.ids.every((id) => selected.has(id));
    return (
      <div
        className={cn(
          "group/gh flex h-28 items-center gap-6 px-4",
          sticky && "rounded-sm bg-sunk shadow-[0_1px_0_var(--line)]",
        )}
      >
        <span aria-hidden className={cn("inline-block size-7 rounded-pill", PRIO_FILL[g.priority])} />
        <span className="t-label">{GROUP_LABEL[g.priority]}</span>
        <span className="font-mono text-[11.5px] text-muted">{num(g.ids.length)}</span>
        <span className="ml-auto flex items-center gap-12">
          {onSelectGroup ? (
            <button
              type="button"
              onClick={() => onSelectGroup(g.ids)}
              className={cn(
                "t-body-s border-0 bg-transparent p-0 text-accent hover:underline",
                !anySelected && "opacity-0 group-hover/gh:opacity-100 focus-visible:opacity-100",
              )}
            >
              {all ? "Clear" : `Select ${num(g.ids.length)}`}
            </button>
          ) : null}
          {onTriageGroup ? (
            // The way through a group of 95 near-identical cards is Triage, one at a time.
            <button
              type="button"
              onClick={() => onTriageGroup(g.priority === "hot" || g.priority === "warm" ? "hw" : g.priority)}
              className="t-body-s border-0 bg-transparent p-0 font-medium whitespace-nowrap text-accent hover:underline"
              title={`Sort the ${PRIORITY_LABEL[g.priority]} group one investor at a time`}
            >
              Triage these →
            </button>
          ) : null}
        </span>
      </div>
    );
  };

  const prioBar =
    grouped && cards.length ? (
      // The legend alone (its swatches and counts are the breakdown; a bar repeated them).
      <div className="flex shrink-0 flex-col px-10 pb-2">
        <div className="flex flex-wrap gap-x-12 gap-y-2" role="group" aria-label="Filter New by fit">
          {PRIORITY_ORDER.filter((pr) => groupCounts[pr] > 0 || activePrio === pr).map((pr) => (
            <button
              key={pr}
              type="button"
              aria-pressed={activePrio === pr}
              onClick={() => onPrioFilter?.(activePrio === pr ? null : pr)}
              className={cn(
                "t-body-s inline-flex items-center gap-4 rounded-pill border-0 bg-transparent px-0 hover:text-fg",
                activePrio === pr ? "font-semibold text-fg" : "text-muted",
              )}
            >
              <span aria-hidden className={cn("inline-block h-6 w-12 rounded-pill", PRIO_FILL[pr])} />
              {PRIORITY_LABEL[pr]} <span className="font-mono text-[11.5px]">{num(groupCounts[pr])}</span>
            </button>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <BoardColumn
      fill
      data-stage={s.key}
      label={s.label}
      color={s.color}
      count={cards.length}
      dueCount={s.kind === "lost" || won ? 0 : due}
      total={won ? { amount: total, currency } : null}
      readOnly={readOnly}
      filtered={filtered}
      meaning={STAGE_MEANING[s.key] ?? null}
      dragCount={isDropTarget ? (dragIds?.length ?? 0) : 0}
      isDropTarget={isDropTarget}
      bodyRef={body}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      headerAction={headerAction}
      headerExtra={prioBar}
      headerAside={
        cards.length > 1 ? (
          <Menu
            label={`Sort ${s.label}`}
            align="end"
            minWidth={180}
            trigger={<span aria-hidden>⋯</span>}
            triggerClassName="inline-flex size-24 items-center justify-center rounded-sm border-0 bg-transparent font-normal text-muted hover:bg-line/50 hover:text-fg"
            items={[
              { type: "label", label: "Sort by" },
              ...BOARD_SORTS.map((o) => ({ label: o.label, selected: sort === o.value, onSelect: () => onSortChange(o.value) })),
            ]}
          />
        ) : null
      }
    >
      {stuck ? <div className="sticky top-0 z-10 -mx-2 h-0 overflow-visible px-2">{groupHeader(stuck, true)}</div> : null}
      {v.padTop > 0 ? <div aria-hidden className="shrink-0" style={{ height: v.padTop }} /> : null}
      {rows.slice(v.start, v.end).map((r) => {
        if (r.kind === "group") {
          return (
            <div key={`g-${r.priority}`} className="shrink-0 pt-2" style={{ height: GROUP_H }}>
              {groupHeader(r)}
            </div>
          );
        }
        const cell = ({ p }: { p: Participant; idx: number }) => {
        const id = p.investor.id;
        const isSel = selected.has(id);
        return (
          <div key={id} className="group/card relative min-w-0" style={{ height: cardH, paddingBottom: CARD_GAP }}>
            {selectable ? (
              <input
                type="checkbox"
                tabIndex={-1}
                checked={isSel}
                onChange={() => onToggle(id)}
                aria-label={`Select ${p.investor.name}`}
                className={cn(
                  "absolute top-[11px] left-10 z-[1] size-14 accent-[var(--accent)]",
                  !anySelected && "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
                )}
              />
            ) : null}
            <BoardCard
              data-investor={id}
              name={p.investor.name}
              title={p.investor.title}
              firm={p.investor.firm}
              fit={p.fit}
              rightSlot={cardSlot(p, today, currency)}
              nextStep={p.next_step}
              showNextStep={showNextStep}
              won={won}
              hidePips={hidePips || (grouped && priorityFromFit(p.fit) !== "low")}
              current={openId === id}
              selected={isSel}
              inset={anySelected}
              className={selectable && !anySelected ? "group-hover/card:pl-32 group-focus-within/card:pl-32" : undefined}
              tabIndex={tabStop === id ? 0 : -1}
              agentMark={agentMarks[id] ? { tip: agentMarks[id].tip } : null}
              dragging={dragIds?.includes(id)}
              draggable={canWrite}
              hint={canWrite ? undefined : "View only"}
              aria-current={openId === id || undefined}
              aria-label={`${p.investor.name}${p.investor.firm ? `, ${p.investor.firm}` : ""}. ${s.label}.${isSel ? " Selected." : ""}`}
              onFocus={() => onCardFocus(id)}
              onClick={(e) => onCardClick(e, id)}
              onKeyDown={(e) => onCardKey(e, p)}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", id);
                e.dataTransfer.effectAllowed = "move";
                onDragStart(id);
              }}
              onDragEnd={onDragEnd}
            />
            {renderMenu(p)}
          </div>
        );
        };
        return (
          <div
            key={`r-${r.items[0]!.p.investor.id}`}
            className="grid shrink-0"
            style={{ gridTemplateColumns: `repeat(${grouped ? perRow : 1}, minmax(0, 1fr))`, columnGap: GRID_GAP }}
          >
            {r.items.map(cell)}
          </div>
        );
      })}
      {v.padBottom > 0 ? <div aria-hidden className="shrink-0" style={{ height: v.padBottom }} /> : null}
    </BoardColumn>
  );
}
