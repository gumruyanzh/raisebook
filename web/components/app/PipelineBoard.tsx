"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Board, BoardCard, BoardColumn, Menu, StageDot } from "@/components/ui";
import { boardCardHeight, boardCardLines, CARD_GAP } from "@/components/ui/Board";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import type { PipelineExtra } from "@/lib/api/rounds";
import type { Participant, Round, Stage } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";

import type { Density } from "./PipelineTable";
import { byFit, useMediaQuery } from "./util";

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
      return out.sort(
        (a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") || byFit(a, b),
      );
    case "name":
      return out.sort((a, b) => a.investor.name.localeCompare(b.investor.name));
    default:
      return out.sort(byFit);
  }
}

interface ColumnApi {
  scrollToIndex: (i: number) => boolean;
}

/**
 * The pipeline board (SYSTEM §4.2, §4.3; UX pass 1 P1-3). One column per stage; empty
 * columns and the lost stage fold into 44px rails. The board fills the viewport and only the
 * columns scroll, each windowed (cards have exact heights). Pointer users drag cards; the
 * board is one tab stop for the keyboard: arrows move between cards and columns, Enter opens,
 * Alt+→ / Alt+← moves a card one stage (skipping the lost stage), M opens "Move to…".
 */
export function PipelineBoard({
  round,
  stages,
  columns,
  sorts,
  onSortChange,
  extras,
  agentMarks,
  today,
  canWrite,
  density,
  filtered,
  height,
  openId,
  focusReq,
  onOpen,
  onMove,
}: {
  round: Round;
  stages: Stage[];
  /** Filtered cards per stage, already sorted. */
  columns: { stage: Stage; cards: Participant[] }[];
  sorts: Record<string, BoardSort>;
  onSortChange: (stageKey: string, sort: BoardSort) => void;
  extras: Record<string, PipelineExtra>;
  agentMarks: Record<string, AgentMark>;
  today: string;
  canWrite: boolean;
  density: Density;
  /** Filters or search are applied (the empty-column copy changes). */
  filtered: boolean;
  /** Fill height in px. */
  height: number | null;
  openId?: string | null;
  focusReq: { id: string; n: number } | null;
  onOpen: (investorId: string) => void;
  /** Returns false when the move failed (the card snaps back). */
  onMove: (investorId: string, stageKey: string) => Promise<boolean>;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const apis = useRef<Record<string, ColumnApi>>({});
  const wide = useMediaQuery("(min-width: 640px)") ?? true;
  const variant = density === "compact" ? "compact" : "standard";

  // The lost stage and empty columns start as rails from 640px up, so the stages that matter
  // get the width. A rail opens on click (and stays open while this board is mounted).
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [lostClosed, setLostClosed] = useState(true);
  const collapsed = useCallback(
    (s: Stage, count: number) => {
      if (!wide || opened.has(s.key)) return false;
      if (s.kind === "lost") return lostClosed;
      return count === 0;
    },
    [wide, opened, lostClosed],
  );
  const template = wide
    ? columns.map((c) => (collapsed(c.stage, c.cards.length) ? "44px" : "minmax(var(--col-min), 1fr)")).join(" ")
    : undefined;

  const [fade, setFade] = useState(false);
  const updateFade = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    setFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  }, []);
  useEffect(() => {
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [updateFade, template]);

  // Phones: open on the first column that has cards.
  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (wide || scrolledOnce.current) return;
    scrolledOnce.current = true;
    const i = columns.findIndex((c) => c.cards.length > 0);
    const el = boardRef.current?.children[i] as HTMLElement | undefined;
    if (el && i > 0) boardRef.current!.scrollLeft = el.offsetLeft - 16;
  }, [wide, columns]);

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
          if (el) el.focus({ preventScroll: true });
          else if (n > 0) tryFocus(n - 1);
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
      setOpened((o) => (o.has(key) ? o : new Set(o).add(key)));
      await onMove(investorId, key);
      focusCard(investorId);
    },
    [where, columns, onMove, focusCard],
  );

  // Keyboard path skips the lost stage (reachable only through the menu).
  const keyPath = useMemo(() => stages.filter((s) => s.kind !== "lost"), [stages]);

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
    const go = (colIdx: number, idx: number) => {
      const c = columns[colIdx];
      const target = c?.cards[Math.max(0, Math.min(c.cards.length - 1, idx))];
      if (target) {
        e.preventDefault();
        focusCard(target.investor.id);
      }
    };
    const sideways = (dir: 1 | -1) => {
      for (let c = at.col + dir; c >= 0 && c < columns.length; c += dir) {
        const cc = columns[c]!;
        if (cc.cards.length && !collapsed(cc.stage, cc.cards.length)) return go(c, at.idx);
      }
    };
    switch (e.key) {
      case "ArrowDown":
      case "j":
        return go(at.col, at.idx + 1);
      case "ArrowUp":
      case "k":
        return go(at.col, at.idx - 1);
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
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setOverKey(null);
    setDragId(null);
    if (id) void move(id, key);
  };

  // One tab stop: the active card, else the first card on the board.
  const firstId = columns.find((c) => c.cards.length && !collapsed(c.stage, c.cards.length))?.cards[0]?.investor.id ?? null;
  const tabStop = activeId && where.has(activeId) ? activeId : firstId;

  return (
    <div className="relative">
      <Board
        ref={boardRef}
        role="group"
        aria-label={`${round.name} board`}
        aria-keyshortcuts={canWrite ? "ArrowUp ArrowDown ArrowLeft ArrowRight Enter Alt+ArrowRight Alt+ArrowLeft M" : undefined}
        columns={template}
        onScroll={updateFade}
        className="min-h-0! grid-rows-[100%] pb-6!"
        style={{ height: height ?? "70vh" }}
      >
        {columns.map(({ stage: s, cards }) => {
          const isCollapsed = collapsed(s, cards.length);
          const sort = sorts[s.key] ?? "fit";
          return (
            <StageColumn
              key={s.key}
              stage={s}
              cards={cards}
              collapsed={isCollapsed}
              onExpand={() => {
                if (s.kind === "lost") setLostClosed(false);
                setOpened((o) => new Set(o).add(s.key));
              }}
              onCollapse={
                wide && !isCollapsed && (s.kind === "lost" || cards.length === 0)
                  ? () => {
                      if (s.kind === "lost") setLostClosed(true);
                      setOpened((o) => {
                        const n = new Set(o);
                        n.delete(s.key);
                        return n;
                      });
                    }
                  : undefined
              }
              sort={sort}
              onSortChange={(v) => onSortChange(s.key, v)}
              currency={round.currency}
              readOnly={!canWrite}
              filtered={filtered}
              variant={variant}
              extras={extras}
              agentMarks={agentMarks}
              today={today}
              canWrite={canWrite}
              tabStop={tabStop}
              openId={openId ?? null}
              dragId={dragId}
              isDropTarget={overKey === s.key && dragId !== null}
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
              renderMenu={(p) =>
                menuFor === p.investor.id ? (
                  <Menu
                    label={`Move ${p.investor.name} to`}
                    open
                    onOpenChange={(o) => {
                      if (!o) {
                        setMenuFor(null);
                        focusCard(p.investor.id);
                      }
                    }}
                    className="absolute! inset-x-0 top-full h-0"
                    items={[
                      { type: "label", label: "Move to" },
                      ...stages.map((st) => ({
                        label: st.label,
                        icon: <StageDot color={st.color} />,
                        selected: st.key === p.stage.key,
                        onSelect: () => {
                          setMenuFor(null);
                          void move(p.investor.id, st.key);
                        },
                      })),
                    ]}
                  />
                ) : null
              }
              onCardFocus={setActiveId}
              onCardKey={onCardKey}
              onOpen={onOpen}
              onDragStart={(id) => setDragId(id)}
              onDragEnd={() => {
                setDragId(null);
                setOverKey(null);
              }}
            />
          );
        })}
      </Board>
      {fade ? (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 right-0 bottom-8 w-48 bg-linear-to-l from-canvas to-transparent"
        />
      ) : null}
      {canWrite ? (
        <p className="sr-only">
          Use the arrow keys to move between cards and columns, Enter to open a file, Alt with the left or right arrow to
          move a card one stage, and M for Move to.
        </p>
      ) : null}
    </div>
  );
}

function StageColumn({
  stage: s,
  cards,
  collapsed,
  onExpand,
  onCollapse,
  sort,
  onSortChange,
  currency,
  readOnly,
  filtered,
  variant,
  extras,
  agentMarks,
  today,
  canWrite,
  tabStop,
  openId,
  dragId,
  isDropTarget,
  registerApi,
  onDragOver,
  onDragLeave,
  onDrop,
  renderMenu,
  onCardFocus,
  onCardKey,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  stage: Stage;
  cards: Participant[];
  collapsed: boolean;
  onExpand: () => void;
  onCollapse?: () => void;
  sort: BoardSort;
  onSortChange: (s: BoardSort) => void;
  currency: string;
  readOnly: boolean;
  filtered: boolean;
  variant: "standard" | "compact";
  extras: Record<string, PipelineExtra>;
  agentMarks: Record<string, AgentMark>;
  today: string;
  canWrite: boolean;
  tabStop: string | null;
  openId: string | null;
  dragId: string | null;
  isDropTarget: boolean;
  registerApi: (api: ColumnApi | null) => void;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  renderMenu: (p: Participant) => ReactNode;
  onCardFocus: (id: string) => void;
  onCardKey: (e: KeyboardEvent<HTMLButtonElement>, p: Participant) => void;
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const won = s.kind === "won";
  const props = useMemo(
    () =>
      cards.map((p) => {
        const industries = extras[p.investor.id]?.industries ?? [];
        const amount =
          won && p.amount_committed
            ? { value: p.amount_committed, currency }
            : p.amount_soft
              ? { value: p.amount_soft, currency, soft: true }
              : null;
        const c = {
          title: p.investor.title,
          firm: p.investor.firm,
          nextStep: p.next_step,
          won,
          typeLabel: p.investor.type === "other" ? null : INVESTOR_TYPE_LABEL[p.investor.type],
          industry: industries[0] ?? null,
          extraTagCount: Math.max(0, industries.length - 1 + (p.investor.tags?.length ?? 0)),
          followUpOn: p.follow_up_on,
          followUpState: p.follow_up_state,
          amount,
        };
        const h = variant === "compact" ? boardCardHeight("compact", boardCardLines(c)) : boardCardHeight("standard", boardCardLines(c));
        return { c, slot: h + CARD_GAP };
      }),
    [cards, extras, won, currency, variant],
  );
  const heightAt = useCallback((i: number) => props[i]?.slot ?? 0, [props]);
  const v = useVirtualRows({ scrollRef: body, count: cards.length, height: heightAt, offset: 2, initial: 14 });
  const { scrollToIndex } = v;
  useEffect(() => {
    registerApi({ scrollToIndex });
    return () => registerApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);

  const total = won ? cards.reduce((sum, p) => sum + (p.amount_committed ?? 0), 0) : 0;
  const due = cards.filter((p) => p.follow_up_state === "overdue" || p.follow_up_state === "today").length;

  return (
    <BoardColumn
      fill
      collapsed={collapsed}
      onExpand={onExpand}
      onCollapse={onCollapse}
      label={s.label}
      color={s.color}
      count={cards.length}
      dueCount={s.kind === "lost" || won ? 0 : due}
      total={won ? { amount: total, currency } : null}
      readOnly={readOnly || filtered}
      isDropTarget={isDropTarget}
      bodyRef={body}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
        const i = v.start + k;
        const id = p.investor.id;
        const { c, slot } = props[i]!;
        return (
          <div key={id} className="relative shrink-0" style={{ height: slot, paddingBottom: CARD_GAP }}>
            <BoardCard
              data-investor={id}
              name={p.investor.name}
              fit={p.fit}
              {...c}
              today={today}
              variant={variant}
              current={openId === id}
              tabIndex={tabStop === id ? 0 : -1}
              agentMark={agentMarks[id] ? { tip: agentMarks[id].tip } : null}
              dragging={dragId === id}
              draggable={canWrite}
              hint={canWrite ? undefined : "View only"}
              aria-current={openId === id || undefined}
              aria-label={`${p.investor.name}${p.investor.firm ? `, ${p.investor.firm}` : ""}. ${s.label}.`}
              onFocus={() => onCardFocus(id)}
              onClick={() => onOpen(id)}
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
