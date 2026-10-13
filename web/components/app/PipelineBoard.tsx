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

import { Board, BoardColumn, DealCard, Menu, StageDot } from "@/components/ui";
import { CARD_GAP, dealCardHeight, type DealCardRows } from "@/components/ui/Board";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import type { PipelineExtra } from "@/lib/api/rounds";
import type { Participant, Round, Stage } from "@/lib/api/types";
import { PRIORITY_LABEL } from "@/lib/api/types";
import { cardMeta, cardPriority, checkRange, closeLikelihood, fitMeta, lastTouch } from "@/lib/boardCard";
import { cn } from "@/lib/cn";
import { formatDateTime, moneyCompact, num } from "@/lib/format";
import { boardTrack, cardSlot, defaultColumnSort, triageTargets } from "@/lib/pipeline";

import { byFit } from "./util";

export interface AgentMark {
  label: string;
  tip: string;
}

export type BoardSort = "fit" | "due" | "amount" | "recent" | "activity" | "name";

export const BOARD_SORTS: { value: BoardSort; label: string }[] = [
  { value: "fit", label: "Fit" },
  { value: "due", label: "Due first" },
  { value: "amount", label: "Amount" },
  { value: "recent", label: "Recently moved" },
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
    case "amount":
      return out.sort(
        (a, b) =>
          (b.amount_committed ?? 0) - (a.amount_committed ?? 0) || (b.amount_soft ?? 0) - (a.amount_soft ?? 0) || byFit(a, b),
      );
    case "recent":
      return out.sort((a, b) => (b.stage_changed_at ?? "").localeCompare(a.stage_changed_at ?? "") || byFit(a, b));
    case "activity":
      return out.sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") || byFit(a, b));
    case "name":
      return out.sort((a, b) => a.investor.name.localeCompare(b.investor.name));
    default:
      return out.sort(byFit);
  }
}


interface ColumnApi {
  scrollToIndex: (cardIndex: number) => boolean;
}

/**
 * The pipeline board as a classic kanban (DECISION §14, the prototype's board): every stage is
 * its own equal-width column side by side, empty ones included, and the board scrolls sideways
 * when they do not fit (a pill in the toolbar reaches the end stages). The board fills the
 * viewport and only the columns scroll, each windowed (rich cards of DECISION §15, each with a
 * known height), so 411 cards in New cost about 15 mounted cards. Drag a card (or the selection) onto another column to move it.
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
  onTriage,
  selected,
  onSelectedChange,
  onOpen,
  onFocusMove,
  onMove,
  onMoveMany,
  extras,
  timeZone,
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
  /** "Triage →" in the New header (writers, while New has investors and no other way in shows). */
  onTriage?: () => void;
  selected: Set<string> | null;
  onSelectedChange: (next: Set<string>) => void;
  onOpen: (investorId: string) => void;
  /** With the split sheet open, keyboard moves open the card they land on. */
  onFocusMove?: (investorId: string) => void;
  /** Returns false when the move failed (the card snaps back). */
  onMove: (investorId: string, stageKey: string) => Promise<boolean>;
  /** One bulk request (dragging or "Move to…" with several selected). */
  onMoveMany: (investorIds: string[], stageKey: string) => void;
  /** Investor facts the cards show (stage focus, check size, industries), by investor id. */
  extras?: Record<string, PipelineExtra>;
  /** The workspace timezone (the cards' "3d ago"). */
  timeZone?: string;
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

  const colByKey = useMemo(() => new Map(columns.map((c, i) => [c.stage.key, { c, i }])), [columns]);

  /* ---------- the right edge: fade and the end-stage pill ---------- */
  const [fade, setFade] = useState(false);
  const [offEnds, setOffEnds] = useState<string[]>([]);
  const endKeys = useMemo(
    () => columns.filter((c) => c.stage.kind === "won" || c.stage.kind === "lost").map((c) => c.stage.key),
    [columns],
  );
  // Equal-width columns: all of them when they fit at COL_MIN, else as many whole columns as
  // fit with the next one peeking out at the right edge (never a 2px sliver that reads as the
  // board's end).
  const [colW, setColW] = useState<string | null>(null);
  const n = columns.length;
  const updateEdge = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const next = boardTrack(w, n);
    setColW((prev) => (prev === next ? prev : next));
    const right = el.scrollLeft + el.clientWidth;
    setFade(el.scrollWidth - right > 4);
    const off: string[] = [];
    for (const key of endKeys) {
      if (!colByKey.get(key)?.c.cards.length) continue;
      const col = el.querySelector<HTMLElement>(`[data-stage="${CSS.escape(key)}"]`);
      if (col && col.offsetLeft + 40 > right) off.push(key);
    }
    setOffEnds((prev) => (prev.join() === off.join() ? prev : off));
  }, [endKeys, colByKey, n]);
  useEffect(() => {
    updateEdge();
    window.addEventListener("resize", updateEdge);
    const ro = typeof ResizeObserver !== "undefined" && boardRef.current ? new ResizeObserver(updateEdge) : null;
    if (ro && boardRef.current) ro.observe(boardRef.current);
    return () => {
      window.removeEventListener("resize", updateEdge);
      ro?.disconnect();
    };
  }, [updateEdge, columns.length]);

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

  // The open card stays in view beside the split sheet: opening the file narrows the board,
  // so its column scrolls fully into view, never left half under the sheet (critique 3).
  useEffect(() => {
    if (!openId) return;
    let frame = 0;
    const t = setTimeout(() => {
      frame = requestAnimationFrame(() => {
        const board = boardRef.current;
        const card = board?.querySelector<HTMLElement>(`[data-investor="${CSS.escape(openId)}"]`);
        const col = card?.closest<HTMLElement>("[data-stage]");
        if (!board || !col) return;
        const b = board.getBoundingClientRect();
        const c = col.getBoundingClientRect();
        // 48px of fade sits on the right edge of a board that scrolls on.
        const pad = 56;
        let left: number | null = null;
        if (c.right > b.right - 8) left = board.scrollLeft + c.right - b.right + pad;
        else if (c.left < b.left) left = board.scrollLeft + c.left - b.left - 8;
        if (left !== null) {
          // Land on a track's left edge (critique 4: a 90px sliver of Researching showed blank
          // card shells at the board's edge): the first track that starts at or after the
          // needed offset, as long as the open card's column stays in view.
          const colLeft = c.left - b.left + board.scrollLeft;
          const starts = Array.from(board.children)
            .map((el) => (el as HTMLElement).getBoundingClientRect().left - b.left + board.scrollLeft)
            .filter((x) => x >= left! - 1 && x <= colLeft + 1)
            .sort((x, y) => x - y);
          if (starts.length) left = starts[0]!;
          board.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
        }
        const body = card!.closest<HTMLElement>(".overflow-y-auto");
        if (body) {
          const r = card!.getBoundingClientRect();
          const br = body.getBoundingClientRect();
          if (r.top < br.top || r.bottom > br.bottom) card!.scrollIntoView({ block: "nearest" });
        }
      });
    }, 60);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(frame);
    };
  }, [openId]);

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
      for (let c = at.col + dir; c >= 0 && c < columns.length; c += dir) {
        if (columns[c]!.cards.length) return go(c, Math.min(at.idx, columns[c]!.cards.length - 1));
      }
    };
    const vertical = (dir: 1 | -1) => go(at.col, at.idx + dir, e.shiftKey);
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
        onScroll={updateEdge}
        className="min-h-0! grid-rows-[100%] pb-6!"
        // No hit-testing (so no :hover) until the pointer moves again.
        style={{
          height: height ?? "70vh",
          ...(colW ? { gridAutoColumns: colW } : null),
          ...(hoverOff ? { pointerEvents: "none" } : null),
        }}
      >
        {columns.map(({ stage: s, cards }) => {
          const sort = sorts[s.key] ?? defaultColumnSort(s);
          const isOpen = s.key === openKey;
          return (
            <StageColumn
              key={s.key}
              stage={s}
              cards={cards}
              sort={sort}
              onSortChange={(v) => onSortChange(s.key, v)}
              currency={round.currency}
              readOnly={!canWrite}
              filtered={filtered}
              showNextStep={showNextStep}
              agentMarks={agentMarks}
              today={today}
              extras={extras ?? NO_EXTRAS}
              timeZone={timeZone}
              canWrite={canWrite}
              selectable={canWrite && Boolean(selected)}
              anySelected={anySelected}
              selected={sel}
              tabStop={tabStop}
              openId={openId ?? null}
              dragIds={dragIds}
              isDropTarget={dragIds !== null && canWrite && overKey === s.key}
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
                      if (!dragIds) return;
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
const NO_EXTRAS: Record<string, PipelineExtra> = {};

/** Everything a rich card shows, worked out once per card (and its height). */
interface CardView {
  rows: DealCardRows;
  meta: string[];
  check: string;
  odds: { value: number; why: string; won: boolean } | null;
  slot: ReturnType<typeof cardSlot>;
  touch: { text: string; tip: string } | null;
}

/** The meta row's width in the narrowest column (250px, less padding and borders). */
const META_WIDTH = 206;

/** A minute after it was added: the import's own activity is not a touch. */
const REAL_TOUCH_MS = 60_000;

function cardView(
  p: Participant,
  stage: Stage,
  extra: PipelineExtra | undefined,
  today: string,
  currency: string,
  showNextStep: boolean,
  timeZone?: string,
): CardView {
  const check = checkRange(extra?.check_min, extra?.check_max, currency);
  const all = cardMeta({ type: p.investor.type, stageFocus: extra?.stage_focus, industries: extra?.industries });
  const meta = fitMeta(all, check, META_WIDTH);
  // The lost stage has no likelihood line: 0% on 230 cards says nothing the column does not.
  const l = stage.kind === "lost" ? null : closeLikelihood({ ...p, stage });
  const odds = l ? { value: l.value, why: `Likelihood to close this round. ${l.why}`, won: stage.kind === "won" } : null;
  const slot = cardSlot(p, today, currency);
  const at = p.last_activity_at;
  const real =
    at && (stage.kind === "active" || stage.kind === "won" || Date.parse(at) - Date.parse(p.created_at) > REAL_TOUCH_MS);
  const text = real ? lastTouch(at, today, timeZone) : "";
  const touch = text
    ? { text: text === "Today" ? "Touched today" : `Touched ${text}`, tip: `Last activity ${formatDateTime(at, timeZone)}` }
    : null;
  return {
    rows: { meta: meta.length > 0 || Boolean(check), odds: Boolean(odds), foot: Boolean(slot || touch), step: showNextStep },
    meta,
    check,
    odds,
    slot,
    touch,
  };
}



function StageColumn({
  stage: s,
  cards,
  sort,
  onSortChange,
  currency,
  readOnly,
  filtered,
  showNextStep,
  agentMarks,
  today,
  extras,
  timeZone,
  canWrite,
  selectable,
  anySelected,
  selected,
  tabStop,
  openId,
  dragIds,
  isDropTarget,
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
  sort: BoardSort;
  onSortChange: (s: BoardSort) => void;
  currency: string;
  readOnly: boolean;
  filtered: boolean;
  showNextStep: boolean;
  agentMarks: Record<string, AgentMark>;
  today: string;
  extras: Record<string, PipelineExtra>;
  timeZone?: string;
  canWrite: boolean;
  selectable: boolean;
  anySelected: boolean;
  selected: Set<string>;
  tabStop: string | null;
  openId: string | null;
  dragIds: string[] | null;
  isDropTarget: boolean;
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
  // Each card's rows (and so its height) are known up front, so the column stays windowed.
  const views = useMemo(
    () => cards.map((p) => cardView(p, s, extras[p.investor.id], today, currency, showNextStep, timeZone)),
    [cards, s, extras, today, currency, showNextStep, timeZone],
  );
  const rowH = useCallback((i: number) => dealCardHeight(views[i]!.rows) + CARD_GAP, [views]);

  // Windowed: a 411-card New column mounts only the cards in view (no "Show more").
  const v = useVirtualRows({ scrollRef: body, count: cards.length, height: rowH, initial: 10 });
  const { scrollToIndex } = v;
  useEffect(() => {
    registerApi({ scrollToIndex: (i) => scrollToIndex(i) });
    return () => registerApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);

  const total = won ? cards.reduce((sum, p) => sum + (p.amount_committed ?? 0), 0) : 0;
  const due = cards.filter((p) => p.follow_up_state === "overdue" || p.follow_up_state === "today").length;

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
      isDropTarget={isDropTarget}
      bodyRef={body}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      headerAction={headerAction}
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
      {v.padTop > 0 ? <div aria-hidden className="shrink-0" style={{ height: v.padTop }} /> : null}
      {cards.slice(v.start, v.end).map((p, k) => {
        const id = p.investor.id;
        const isSel = selected.has(id);
        const view = views[v.start + k]!;
        return (
          <div
            key={id}
            className="group/card relative min-w-0 shrink-0"
            style={{ height: dealCardHeight(view.rows) + CARD_GAP, paddingBottom: CARD_GAP }}
          >
            {selectable ? (
              <input
                type="checkbox"
                tabIndex={-1}
                checked={isSel}
                onChange={() => onToggle(id)}
                aria-label={`Select ${p.investor.name}`}
                className={cn(
                  "absolute top-[15px] left-13 z-[1] size-14 accent-[var(--accent)]",
                  !anySelected && "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
                )}
              />
            ) : null}
            <DealCard
              data-investor={id}
              name={p.investor.name}
              title={p.investor.title}
              firm={p.investor.firm}
              priority={cardPriority(p.fit)}
              meta={view.meta}
              check={view.check}
              odds={view.odds}
              slot={view.slot}
              touch={view.touch}
              nextStep={p.next_step}
              showNextStep={showNextStep}
              current={openId === id}
              selected={isSel}
              checkbox={anySelected ? "shown" : selectable ? "hover" : null}
              tabIndex={tabStop === id ? 0 : -1}
              agentMark={agentMarks[id] ? { tip: agentMarks[id].tip } : null}
              dragging={dragIds?.includes(id)}
              draggable={canWrite}
              hint={canWrite ? undefined : "View only"}
              aria-current={openId === id || undefined}
              aria-label={`${p.investor.name}${p.investor.firm ? `, ${p.investor.firm}` : ""}. ${s.label}. ${(() => { const pr = cardPriority(p.fit); return pr ? PRIORITY_LABEL[pr] : "Not rated"; })()}.${view.odds ? ` Likelihood ${view.odds.value}%.` : ""}${isSel ? " Selected." : ""}`}
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
      })}
      {v.padBottom > 0 ? <div aria-hidden className="shrink-0" style={{ height: v.padBottom }} /> : null}
    </BoardColumn>
  );
}
