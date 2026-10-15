"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { AgentMarker, FitMeter, FollowUpChip, StagePill, Table, TableScroll, TBody, Td, Th, THead, Tr } from "@/components/ui";
import { Avatar, shortPersonName } from "@/components/ui/Avatar";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import type { PipelineExtra } from "@/lib/api/rounds";
import type { Member, Participant, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL, PRIORITY_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { followUpCellText, formatDate, isoDate, money, moneyCompact, priorityFromFit, relativeTime } from "@/lib/format";
import { isApple } from "@/lib/hotkeys";
import { fitColumns, quietColumns, visibleIndustries } from "@/lib/pipeline";

import type { AgentMark } from "./PipelineBoard";
import { personName, useMediaQuery } from "./util";

export type TableCol =
  | "investor"
  | "title"
  | "firm"
  | "stage"
  | "fit"
  | "type"
  | "industry"
  | "follow_up"
  | "soft"
  | "committed"
  | "owner"
  | "last_activity"
  | "next_step"
  | "email"
  | "links";

export type Density = "compact" | "comfortable";

/** Column widths are fixed so windowed rows never change the layout while scrolling. */
export const TABLE_COLS: { key: TableCol; label: string; width: number; required?: boolean; num?: boolean; unsortable?: boolean }[] = [
  { key: "investor", label: "Investor", width: 240, required: true },
  { key: "title", label: "Title", width: 160 },
  { key: "firm", label: "Firm", width: 180 },
  { key: "stage", label: "Stage", width: 132 },
  { key: "fit", label: "Fit", width: 72 },
  { key: "type", label: "Type", width: 112 },
  { key: "industry", label: "Industry", width: 160, unsortable: true },
  { key: "follow_up", label: "Follow-up", width: 150 },
  { key: "soft", label: "Soft", width: 84, num: true },
  { key: "committed", label: "Committed", width: 100, num: true },
  { key: "owner", label: "Owner", width: 128 },
  { key: "last_activity", label: "Last activity", width: 112 },
  { key: "next_step", label: "Next step", width: 220 },
  { key: "email", label: "Email", width: 240 },
  { key: "links", label: "LinkedIn", width: 92, unsortable: true },
];

/**
 * When the columns do not fit, these go first (first in the list, first dropped); the
 * Investor, Firm, Stage, Fit, Follow-up, money and Next step columns stay longest.
 */
// For people not contacted yet the contact columns matter more than Type (critique 2), so
// Type and Industry leave first and Email stays longest (Firm moves next to the name).
// Committed is empty on all but a handful of rows until the round closes, so it leaves before
// Next step, the column that says what to do (critique 3); Email leaves before Next step too.
const DROP_ORDER: TableCol[] = ["title", "last_activity", "type", "industry", "owner", "links", "soft", "committed", "firm", "email", "next_step", "follow_up", "stage"];
/** Only these may hide for holding one value on every row (Stage: "New" ×411). */
const CONSTANT_HIDES: TableCol[] = ["stage", "last_activity"];

export type SortDir = "asc" | "desc";

/** Default direction when a column is first clicked: numbers and fit high-first. */
export const DEFAULT_DIR: Record<TableCol, SortDir> = {
  investor: "asc",
  title: "asc",
  firm: "asc",
  stage: "asc",
  fit: "desc",
  type: "asc",
  follow_up: "asc",
  soft: "desc",
  committed: "desc",
  owner: "asc",
  last_activity: "desc",
  next_step: "asc",
  industry: "asc",
  email: "asc",
  links: "asc",
};

const ROW_H: Record<Density, number> = { compact: 32, comfortable: 44 };
const PHONE_ROW_H = 62;
const SELECT_W = 36;
/** Column widths on a tablet-wide table (the Investor column takes what is left). */
const TIGHT_W: Partial<Record<TableCol, number>> = { investor: 220, stage: 116, fit: 64, follow_up: 116, next_step: 180, firm: 150, type: 96, owner: 112 };

function sortValue(p: Participant, col: TableCol): string | number | null {
  switch (col) {
    case "investor":
      return p.investor.name.toLowerCase();
    case "title":
      return p.investor.title?.toLowerCase() ?? null;
    case "firm":
      return p.investor.firm?.toLowerCase() ?? null;
    case "stage":
      return p.stage.position;
    case "fit":
      return p.fit;
    case "type":
      return p.investor.type === "other" ? null : INVESTOR_TYPE_LABEL[p.investor.type];
    case "follow_up":
      return p.follow_up_on ?? null;
    case "soft":
      return p.amount_soft ?? null;
    case "committed":
      return p.amount_committed ?? null;
    case "owner":
      return p.owner ? personName(p.owner).toLowerCase() : null;
    case "last_activity":
      return p.last_activity_at ?? null;
    case "next_step":
      return p.next_step?.toLowerCase() ?? null;
    case "email":
      return p.investor.email?.toLowerCase() ?? null;
    case "industry":
    case "links":
      return null;
  }
}

export function sortParticipants(rows: Participant[], col: TableCol, dir: SortDir): Participant[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, col);
    const vb = sortValue(b, col);
    // Empty values always last, highest fit first among them.
    if (va === null && vb === null) return b.fit - a.fit || a.investor.name.localeCompare(b.investor.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return b.fit - a.fit || a.investor.name.localeCompare(b.investor.name);
  });
}

/**
 * The pipeline table (SYSTEM §4.2, UX pass 1 P1-2): fixed column widths, one-line cells with
 * the full value in `title`, a sticky header and a sticky Investor column, windowed rows
 * (only what is on screen is in the DOM), and roving focus: the body is one tab stop, ↑/↓ or
 * j/k move, Enter opens, Space or x selects, Shift extends, ⌘A selects every filtered row,
 * Home/End jump. Phones get a stacked list instead of a sideways grid.
 */
export function PipelineTable({
  round,
  rows,
  extras,
  agentMarks,
  members,
  visible,
  density,
  sort,
  dir,
  onSort,
  onOpen,
  onFocusMove,
  openId,
  selected,
  onSelectedChange,
  height,
  focusReq,
  today,
  timeZone,
  onShown,
}: {
  round: Round;
  /** Already filtered and sorted. */
  rows: Participant[];
  extras: Record<string, PipelineExtra>;
  agentMarks: Record<string, AgentMark>;
  members: Member[];
  visible: Set<TableCol>;
  density: Density;
  sort: TableCol;
  dir: SortDir;
  onSort: (col: TableCol) => void;
  onOpen: (investorId: string) => void;
  /** With the split sheet open, keyboard moves open the row they land on. */
  onFocusMove?: (investorId: string) => void;
  openId?: string | null;
  /** `null` hides the selection column (viewers). */
  selected: Set<string> | null;
  onSelectedChange: (next: Set<string>) => void;
  /** Fill height in px, or a CSS length (the page stops; rows scroll). */
  height: number | string | null;
  /** Focus this investor's row (after the sheet closes). */
  focusReq: { id: string; n: number } | null;
  today: string;
  timeZone: string;
  /** The columns actually on screen (the Display menu marks the ones left out and why). */
  onShown?: (shown: Set<TableCol>) => void;
}) {
  const isPhone = useMediaQuery("(max-width: 639px), (max-height: 499px)");
  const scroll = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(1392);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const industriesOf = useCallback((p: Participant) => visibleIndustries(extras[p.investor.id]?.industries), [extras]);
  // Columns with nothing to say for these rows are left out (an import has no follow-ups,
  // money or owners yet), then the rest is fitted to the width the page has.
  const quiet = useMemo(
    () =>
      quietColumns(
        TABLE_COLS.map((c) => c.key),
        rows,
        (p: Participant, k: TableCol) =>
          k === "industry"
            ? industriesOf(p).join(", ")
            : k === "links"
              ? (p.investor.linkedin_url ?? null)
              : k === "fit"
                ? 1
                : k === "investor"
                  ? p.investor.name
                  : (sortValue(p, k) as string | number | null),
        TABLE_COLS.map((c) => c.key).filter((k) => !CONSTANT_HIDES.includes(k)),
      ),
    [rows, industriesOf],
  );
  const selectableW = selected !== null ? SELECT_W : 0;
  // Tablets (under 900px of table): tighter Stage, Fit and Follow-up columns, so the name
  // gets the room (it was "Sofia Bren…" beside half-empty columns) and Next step fits.
  // (Tablet screens only: a desktop squeezed by the split sheet keeps its layout.)
  const tabletScreen = useMediaQuery("(max-width: 1023px)") === true;
  const tight = availW < 900 && tabletScreen;
  const cols = useMemo(() => {
    const wanted = TABLE_COLS.filter((c) => c.required || (visible.has(c.key) && !quiet.has(c.key))).map((c) =>
      tight && TIGHT_W[c.key] ? { ...c, width: TIGHT_W[c.key]! } : c,
    );
    const keep = new Set(fitColumns(wanted, DROP_ORDER, availW - selectableW));
    return wanted.filter((c) => keep.has(c.key));
  }, [visible, quiet, availW, selectableW, tight]);
  const shownKey = cols.map((c) => c.key).join();
  useEffect(() => {
    onShown?.(new Set(cols.map((c) => c.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);
  const titleCol = cols.some((c) => c.key === "title");
  // No room for Firm: it goes next to the name instead of the title.
  const firmCol = cols.some((c) => c.key === "firm");
  const cur = round.currency;
  const now = useMemo(() => new Date(), []);
  const me = useMemo(() => new Set(members.filter((m) => m.is_you).map((m) => m.user_id)), [members]);
  const selectable = selected !== null;
  const tableWidth = cols.reduce((s, c) => s + c.width, 0) + (selectable ? SELECT_W : 0);
  const rowH = ROW_H[density];

  const thead = useRef<HTMLTableSectionElement>(null);
  const [headH, setHeadH] = useState(33);
  useLayoutEffect(() => {
    if (thead.current) setHeadH(thead.current.offsetHeight);
  }, [density]);
  const v = useVirtualRows({ scrollRef: scroll, count: rows.length, height: rowH, offset: headH, initial: 40 });

  /* ---------- roving focus ---------- */
  const [activeId, setActiveId] = useState<string | null>(null);
  const indexOf = useMemo(() => new Map(rows.map((p, i) => [p.investor.id, i])), [rows]);
  const activeIdx = activeId !== null ? (indexOf.get(activeId) ?? -1) : -1;
  const pendingFocus = useRef<string | null>(null);
  const anchor = useRef<number | null>(null);
  /** The row the keyboard is on, updated synchronously (keys can repeat faster than focus). */
  const cursor = useRef<string | null>(null);

  const focusRow = useCallback((id: string) => {
    const el = scroll.current?.querySelector<HTMLElement>(`tr[data-investor="${CSS.escape(id)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      pendingFocus.current = null;
    } else pendingFocus.current = id;
  }, []);
  // A row scrolled in after a jump gets the focus it was waiting for.
  useEffect(() => {
    if (pendingFocus.current) focusRow(pendingFocus.current);
  });

  const goTo = useCallback(
    (i: number) => {
      const p = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!p) return;
      cursor.current = p.investor.id;
      setActiveId(p.investor.id);
      v.scrollToIndex(indexOf.get(p.investor.id) ?? 0);
      requestAnimationFrame(() => focusRow(p.investor.id));
    },
    [rows, v, indexOf, focusRow],
  );

  useEffect(() => {
    if (!focusReq) return;
    const i = indexOf.get(focusReq.id);
    if (i === undefined) return;
    // After the sheet's own focus restore.
    requestAnimationFrame(() => goTo(i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq]);

  /* ---------- selection ---------- */
  const setSel = (next: Set<string>) => onSelectedChange(next);
  const toggle = (id: string) => {
    if (!selected) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next);
  };
  const selectRange = (from: number, to: number, on = true) => {
    if (!selected) return;
    const next = new Set(selected);
    const [a, b] = from < to ? [from, to] : [to, from];
    for (let i = a; i <= b; i++) {
      const id = rows[i]?.investor.id;
      if (!id) continue;
      if (on) next.add(id);
      else next.delete(id);
    }
    setSel(next);
  };
  const allSelected = selectable && rows.length > 0 && rows.every((p) => selected!.has(p.investor.id));
  const someSelected = selectable && !allSelected && rows.some((p) => selected!.has(p.investor.id));
  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someSelected;
  }, [someSelected]);

  const onBodyKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "TR") return;
    const id = cursor.current && indexOf.has(cursor.current) ? cursor.current : target.dataset.investor;
    const i = id ? (indexOf.get(id) ?? 0) : 0;
    const mod = isApple() ? e.metaKey : e.ctrlKey;
    const page = Math.max(1, Math.floor((scroll.current?.clientHeight ?? 400) / rowH) - 2);
    const step = (d: number) => {
      e.preventDefault();
      const j = Math.max(0, Math.min(rows.length - 1, i + d));
      if (e.shiftKey && selectable) {
        if (anchor.current === null) anchor.current = i;
        selectRange(anchor.current, j);
      } else anchor.current = null;
      goTo(j);
      const to = rows[j]?.investor.id;
      if (to && !e.shiftKey && onFocusMove) onFocusMove(to);
    };
    if (e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
      case "j":
      case "J":
        if (mod) return;
        return step(1);
      case "ArrowUp":
      case "k":
      case "K":
        if (mod) return;
        return step(-1);
      case "PageDown":
        return step(page);
      case "PageUp":
        return step(-page);
      case "Home":
        e.preventDefault();
        return goTo(0);
      case "End":
        e.preventDefault();
        return goTo(rows.length - 1);
      case "Enter":
        e.preventDefault();
        if (id) onOpen(id);
        return;
      case " ":
      case "x":
      case "X":
        if (!selectable || !id || mod) return;
        e.preventDefault();
        anchor.current = i;
        toggle(id);
        return;
      case "a":
      case "A":
        if (!selectable || !mod) return;
        e.preventDefault();
        setSel(new Set([...(selected ?? []), ...rows.map((p) => p.investor.id)]));
        return;
    }
  };

  const lastClicked = useRef<number | null>(null);
  const onBox = (e: MouseEvent<HTMLInputElement>, i: number, id: string) => {
    e.stopPropagation();
    if (e.shiftKey && lastClicked.current !== null) {
      selectRange(lastClicked.current, i, !selected?.has(id));
    } else toggle(id);
    lastClicked.current = i;
    setActiveId(id);
  };

  // The active row, or the first row on screen, is the body's one tab stop.
  const tabStop = activeIdx >= v.start && activeIdx < v.end ? activeId : (rows[v.start]?.investor.id ?? null);

  const ownerCell = (p: Participant) => {
    if (!p.owner) return null;
    const name = personName(p.owner);
    return (
      <span className="flex min-w-0 items-center gap-6" title={p.owner.email}>
        <Avatar name={name} />
        <span className="truncate">{shortPersonName(p.owner, me.has(p.owner.user_id))}</span>
      </span>
    );
  };

  const cell = (p: Participant, key: TableCol, mark: AgentMark | undefined) => {
    const one = "truncate whitespace-nowrap";
    switch (key) {
      case "investor":
        return (
          <span className="flex min-w-0 items-center gap-6">
            {/* The name gives way last: the firm beside it truncates first. */}
            <span className={cn(one, "font-semibold", tight && "min-w-48 shrink-[0.1]")} title={p.investor.name}>
              {p.investor.name}
            </span>
            {!firmCol && p.investor.firm ? (
              <span className={cn(one, "t-body-s min-w-0 shrink text-muted")} title={p.investor.firm}>
                {p.investor.firm}
              </span>
            ) : !titleCol && p.investor.title ? (
              <span className={cn(one, "t-body-s min-w-0 shrink text-muted")} title={p.investor.title}>
                {p.investor.title}
              </span>
            ) : null}
            {mark ? <AgentMarker label={mark.tip} /> : null}
          </span>
        );
      case "title":
        return (
          <span className={cn(one, "block text-muted")} title={p.investor.title ?? undefined}>
            {p.investor.title ?? ""}
          </span>
        );
      case "firm":
        return p.investor.firm ? (
          <span className={cn(one, "block")} title={p.investor.firm}>
            {p.investor.firm}
          </span>
        ) : (
          <span className="text-muted" aria-label="No firm">
            —
          </span>
        );
      case "stage":
        return (
          <span className="block truncate">
            <StagePill color={p.stage.color} label={p.stage.label} />
          </span>
        );
      case "fit":
        return (
          <span title={`${PRIORITY_LABEL[priorityFromFit(p.fit)]} · fit ${p.fit}/5`}>
            <FitMeter value={p.fit} />
          </span>
        );
      case "type":
        return p.investor.type === "other" ? (
          <span className="text-muted" aria-label="Type not set">
            —
          </span>
        ) : (
          <span className={cn(one, "block text-muted")}>{INVESTOR_TYPE_LABEL[p.investor.type]}</span>
        );
      case "follow_up": {
        const st = p.follow_up_state;
        return p.follow_up_on ? (
          <span
            className={cn(
              one,
              "t-data block",
              st === "overdue" || st === "today" ? "text-bad" : st === "soon" ? "text-warm-ink" : "text-muted",
            )}
            title={[formatDate(p.follow_up_on, today), p.follow_up_note].filter(Boolean).join(" · ")}
          >
            {followUpCellText(p.follow_up_on, today)}
          </span>
        ) : null;
      }
      case "soft":
        return p.amount_soft ? <span title={money(p.amount_soft, cur)}>{moneyCompact(p.amount_soft, cur)}</span> : null;
      case "committed":
        return p.amount_committed ? (
          <span className="text-good-ink" title={money(p.amount_committed, cur)}>
            {moneyCompact(p.amount_committed, cur)}
          </span>
        ) : null;
      case "owner":
        return ownerCell(p);
      case "last_activity":
        return p.last_activity_at ? (
          <span className="t-data text-muted" title={relativeTime(p.last_activity_at, now, timeZone)}>
            {formatDate(isoDate(p.last_activity_at, timeZone), today)}
          </span>
        ) : null;
      case "next_step":
        return (
          <span className={cn(one, "block text-muted")} title={p.next_step ?? undefined}>
            {p.next_step ?? ""}
          </span>
        );
      case "industry": {
        const list = industriesOf(p);
        // "Other" is never shown; an em dash says "nothing specific" instead of looking lost.
        return list.length ? (
          <span className={cn(one, "block text-muted")} title={list.join(", ")}>
            {list.join(", ")}
          </span>
        ) : (
          <span className="text-muted" title="No specific industry">
            —
          </span>
        );
      }
      case "email":
        return p.investor.email ? (
          <span className={cn(one, "t-body-s block text-muted")} title={p.investor.email}>
            {p.investor.email}
          </span>
        ) : null;
      case "links":
        return p.investor.linkedin_url ? (
          <a
            href={p.investor.linkedin_url}
            target="_blank"
            rel="noopener noreferrer"
            className="link t-body-s"
            onClick={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            Profile ↗
          </a>
        ) : null;
    }
  };

  const fillStyle = height ? height : "70vh";

  if (isPhone) return <PhoneList rows={rows} agentMarks={agentMarks} openId={openId} onOpen={onOpen} today={today} height={height} focusReq={focusReq} />;

  const stickyLeft = (k: TableCol) => (k === "investor" ? (selectable ? SELECT_W : 0) : null);

  return (
    <TableScroll ref={scroll} height={fillStyle} className={cn("overscroll-contain scrollbar-thin", isPhone === null && "max-sm:hidden")}>
      <Table className="table-fixed" style={{ width: "100%", minWidth: tableWidth }} aria-rowcount={rows.length + 1}>
        <colgroup>
          {selectable ? <col style={{ width: SELECT_W }} /> : null}
          {cols.map((c) => (
            <col key={c.key} style={{ width: tight && c.key === "investor" ? undefined : c.width }} />
          ))}
        </colgroup>
        <THead ref={thead}>
          <Tr>
            {selectable ? (
              <Th className="left-0 z-[3]! px-0! text-center!" aria-label="Select">
                <input
                  ref={headerBox}
                  type="checkbox"
                  aria-label={allSelected ? "Clear selection" : `Select all ${rows.length} shown`}
                  checked={allSelected}
                  onChange={() => {
                    const next = new Set(selected);
                    if (allSelected) for (const p of rows) next.delete(p.investor.id);
                    else for (const p of rows) next.add(p.investor.id);
                    setSel(next);
                  }}
                  className="size-16 align-middle accent-[var(--accent)]"
                />
              </Th>
            ) : null}
            {cols.map((c) => {
              const left = stickyLeft(c.key);
              return (
                <Th
                  key={c.key}
                  align={c.num ? "right" : "left"}
                  sort={sort === c.key ? dir : null}
                  onSort={c.unsortable ? undefined : () => onSort(c.key)}
                  className={cn(left !== null && "z-[3]! shadow-[inset_-1px_0_0_var(--line)]")}
                  style={left !== null ? { left } : undefined}
                >
                  {c.label}
                </Th>
              );
            })}
          </Tr>
        </THead>
        <TBody onKeyDown={onBodyKey}>
          {v.padTop > 0 ? (
            <tr aria-hidden style={{ height: v.padTop }}>
              <td colSpan={cols.length + (selectable ? 1 : 0)} className="p-0" />
            </tr>
          ) : null}
          {rows.slice(v.start, v.end).map((p, k) => {
            const i = v.start + k;
            const id = p.investor.id;
            const mark = agentMarks[id];
            const isSel = selected?.has(id) ?? false;
            return (
              <Tr
                key={id}
                data-investor={id}
                tabIndex={tabStop === id ? 0 : -1}
                aria-rowindex={i + 2}
                aria-selected={selectable ? isSel : undefined}
                aria-current={openId === id ? "true" : undefined}
                aria-label={p.investor.name}
                onActivate={() => onOpen(id)}
                onFocus={() => {
                  cursor.current = id;
                  setActiveId(id);
                }}
                selected={isSel || openId === id}
                agent={Boolean(mark)}
                style={{ height: rowH }}
              >
                {selectable ? (
                  <Td className="sticky left-0 z-[1] bg-surface px-0! py-0! text-center align-middle!">
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      aria-label={`Select ${p.investor.name}`}
                      checked={isSel}
                      onChange={() => {}}
                      onClick={(e) => onBox(e, i, id)}
                      className="size-16 align-middle accent-[var(--accent)]"
                    />
                  </Td>
                ) : null}
                {cols.map((c) => {
                  const left = stickyLeft(c.key);
                  return (
                    <Td
                      key={c.key}
                      variant={c.num ? "num" : "default"}
                      className={cn(
                        "overflow-hidden py-0! align-middle!",
                        left !== null && "sticky z-[1] bg-surface shadow-[inset_-1px_0_0_var(--line)]",
                      )}
                      style={left !== null ? { left } : undefined}
                    >
                      {cell(p, c.key, mark)}
                    </Td>
                  );
                })}
              </Tr>
            );
          })}
          {v.padBottom > 0 ? (
            <tr aria-hidden style={{ height: v.padBottom }}>
              <td colSpan={cols.length + (selectable ? 1 : 0)} className="p-0" />
            </tr>
          ) : null}
        </TBody>
      </Table>
    </TableScroll>
  );
}

/** Phones: a stacked, windowed list (who on the left; stage and follow-up on the right). */
function PhoneList({
  rows,
  agentMarks,
  openId,
  onOpen,
  today,
  height,
  focusReq,
}: {
  rows: Participant[];
  agentMarks: Record<string, AgentMark>;
  openId?: string | null;
  onOpen: (id: string) => void;
  today: string;
  height: number | string | null;
  focusReq: { id: string; n: number } | null;
}) {
  const scroll = useRef<HTMLUListElement>(null);
  const v = useVirtualRows({ scrollRef: scroll, count: rows.length, height: PHONE_ROW_H, initial: 14 });
  useEffect(() => {
    if (!focusReq) return;
    const i = rows.findIndex((p) => p.investor.id === focusReq.id);
    if (i < 0) return;
    v.scrollToIndex(i);
    requestAnimationFrame(() =>
      scroll.current?.querySelector<HTMLElement>(`[data-investor="${CSS.escape(focusReq.id)}"]`)?.focus(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq]);
  return (
    <ul
      ref={scroll}
      className="m-0 list-none overflow-y-auto overscroll-contain rounded-md border border-line bg-surface p-0"
      style={{ height: height ?? "70vh" }}
    >
      {v.padTop > 0 ? <li aria-hidden style={{ height: v.padTop }} /> : null}
      {rows.slice(v.start, v.end).map((p) => {
        const id = p.investor.id;
        const mark = agentMarks[id];
        const who = [p.investor.firm, p.investor.title].filter(Boolean).join(" · ");
        return (
          <li key={id} className={cn("border-b border-line", mark && "shadow-[inset_2px_0_0_var(--agent)]")} style={{ height: PHONE_ROW_H }}>
            <button
              type="button"
              data-investor={id}
              onClick={() => onOpen(id)}
              aria-current={openId === id || undefined}
              className={cn(
                "flex h-full w-full items-center gap-10 border-0 bg-transparent px-12 text-left focus-visible:-outline-offset-2",
                openId === id ? "bg-accent-soft" : "active:bg-sunk",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="flex items-center gap-6 font-semibold">
                  <span className="truncate">{p.investor.name}</span>
                  {mark ? <AgentMarker label={mark.tip} /> : null}
                </span>
                {who ? <span className="t-body-s truncate text-muted">{who}</span> : null}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-4">
                <StagePill color={p.stage.color} label={p.stage.label} />
                <FollowUpChip on={p.follow_up_on} state={p.follow_up_state} today={today} />
              </span>
            </button>
          </li>
        );
      })}
      {v.padBottom > 0 ? <li aria-hidden style={{ height: v.padBottom }} /> : null}
    </ul>
  );
}
