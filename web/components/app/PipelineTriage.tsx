"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

import {
  Button,
  Chip,
  DateField,
  EmptyState,
  FitMeter,
  Input,
  Kbd,
  Menu,
  Sheet,
  Skeleton,
  StageDot,
  useToast,
  useToastLift,
  type MenuEntry,
} from "@/components/ui";
import { FilterMenu, type FilterField } from "@/components/ui/FilterBar";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import { activitySentence } from "@/components/ui/Timeline";
import { importRunOf, importSentence, listActivities } from "@/lib/api/activities";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { importRunsCached, type ImportRun } from "@/lib/api/data";
import { getInvestor, updateInvestor, type InvestorUpdate } from "@/lib/api/investors";
import { acceptAllSuggestions, type AiSettings, type RoundResearchRow, type Suggestion } from "@/lib/api/research";
import {
  bulkUpdateParticipants,
  getParticipant,
  moveStage,
  setFollowUp,
  updateParticipant,
  type BulkInput,
  type BulkItem,
} from "@/lib/api/rounds";
import type { Activity, Investor, Participant, Priority, Round, Stage } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { quickPicks } from "@/lib/dates";
import { followUpState, formatDate, isoDate, num, priorityFromFit, stageFocusLabel } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import { useOptionalSession, useWorkspace } from "@/lib/session";
import {
  breakdown,
  cardSlot,
  claimsContact,
  cursorAfterMove,
  followOptions,
  formatDuration,
  formatEach,
  formatElapsed,
  formatRest,
  GROUP_LABEL,
  inSlice,
  nextCursor,
  paceEstimate,
  pressedOption,
  PRIORITY_ORDER,
  queuePosition,
  sharedValue,
  SLICE_LABEL,
  START_SECONDS,
  TRIAGE_MEANING,
  triageTargets,
  visibleIndustries,
  type FollowOption,
  type TriageSlice,
  type TriageTarget,
} from "@/lib/pipeline";

import { checkSize } from "./InvestorSheet";
import { useViewerTimeZone } from "./meetings/useViewerTimeZone";
import { FromResearch } from "./research/FromResearch";
import { forgetInvestorResearch } from "./research/hooks";
import { TriageResearch } from "./research/TriageResearch";
import { draftHref, ReachOut, type ReachPerson } from "./ReachOut";
import { useCompact, useMediaQuery } from "./util";

/** The store hooks the round page lends to Triage (optimistic writes, newer `updated_at` wins). */
export interface TriageStore {
  /** Apply `fn` to these investors now and hold them as pending until `commit` or `rollback`. */
  apply: (ids: string[], fn: (p: Participant) => Participant) => void;
  commit: (rows: Participant[]) => void;
  rollback: (prev: Participant[]) => void;
  afterWrite: () => void;
  announce: (msg: string) => void;
}

interface Snapshot {
  investor_id: string;
  name: string;
  stage: string;
  fit: number;
  follow_up_on: string | null;
  follow_up_note: string | null;
  next_step: string | null;
}

/**
 * One entry on the Undo stack. `move`: a stage decision (one investor or a bulk selection);
 * Undo restores the snapshot taken when the investor's turn began (stage, fit, follow-up,
 * next step) and goes back to them. `edit`: a follow-up, fit or next-step change that did not
 * advance; Undo puts that value back. U always undoes the latest entry.
 */
interface Decision {
  kind: "move" | "edit";
  ids: string[];
  snaps: Snapshot[];
  /** The stage moved to (moves only). */
  to: string | null;
  at: number;
  /** What an edit changed ("follow-up", "fit", "next step"). */
  what?: string;
  /** A move of a selection (one keypress for many: not part of the pace). */
  bulk?: boolean;
  /** Where the cursor was when a bulk move was made: Undo goes back there, not to the
   * first id of the selection (critique 4: Undo of "Select 86 → 7" landed on the last fit-0 row). */
  cursor?: string | null;
  /** Puts back what the entry changed outside the participant (investor fields from research). */
  revert?: () => Promise<void>;
}

interface FullInvestor {
  investor?: Investor;
  acts?: Activity[];
  error?: string;
}

const LRU = 10;
const ROW_H = 38;
const GROUP_H = 32;

function snap(p: Participant): Snapshot {
  return {
    investor_id: p.investor.id,
    name: p.investor.name,
    stage: p.stage.key,
    fit: p.fit,
    follow_up_on: p.follow_up_on ?? null,
    follow_up_note: p.follow_up_note ?? null,
    next_step: p.next_step ?? null,
  };
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** The reach-out row's person: the queue row, filled in from the full investor once it came. */
function reachPerson(p: Participant, inv: Investor | undefined): ReachPerson {
  return {
    name: p.investor.name,
    firm: inv?.firm ?? p.investor.firm,
    fit: p.fit,
    email: inv?.email ?? p.investor.email ?? null,
    linkedin_url: inv?.linkedin_url ?? p.investor.linkedin_url ?? null,
    website_url: inv?.website_url ?? null,
    x_url: inv?.x_url ?? null,
  };
}

/**
 * Triage (DECISION §4): a keyboard-first queue for the open stage. One key files the current
 * investor (optimistic, with Undo) and opens the next one in the same frame; the next two are
 * prefetched. Desktop: queue · investor · rail. Under 1024px the queue folds into a sheet;
 * phones get a full-screen takeover with the three primary stages in a bottom bar.
 */
export function PipelineTriage({
  round,
  stages,
  rows: allRows,
  matches,
  extras,
  agentMarks,
  today,
  timeZone,
  client,
  wsSlug,
  canWrite,
  openKey,
  slice,
  at,
  active,
  filterFields,
  filterActive,
  onFilterChange,
  onSlice,
  onCursor,
  onOpenFile,
  onOpenBoard,
  onExit,
  store,
  keysEnabled,
  squeezed = false,
  fileId = null,
  onOrder,
  research,
}: {
  round: Round;
  stages: Stage[];
  rows: Participant[];
  /** The page filters minus stage (search, type, industry…). */
  matches: (p: Participant) => boolean;
  extras: Record<string, { industries: string[]; source?: string }>;
  agentMarks: Record<string, { tip: string }>;
  today: string;
  timeZone: string;
  client: ApiClient;
  wsSlug: string;
  canWrite: boolean;
  openKey: string;
  slice: TriageSlice;
  at: string | null;
  active: number;
  filterFields: FilterField[];
  filterActive: Record<string, string | undefined>;
  onFilterChange: (key: string, value: string | null) => void;
  onSlice: (s: TriageSlice) => void;
  onCursor: (id: string | null) => void;
  onOpenFile: (id: string) => void;
  onOpenBoard: () => void;
  /** Phones: ✕ back to the list. */
  onExit: () => void;
  store: TriageStore;
  /** False while the investor sheet is open (its keys win). */
  keysEnabled: boolean;
  /** The split sheet takes the right of the page: a narrower queue, and the pane keeps only
   * the decision panel (the file beside it already shows the investor; critique 3). */
  squeezed?: boolean;
  /** The investor whose file is open in the sheet (it follows the queue while open). */
  fileId?: string | null;
  /** The queue's order (the slice on screen), for the sheet's "3 of 190" and ↑ ↓. */
  onOrder?: (ids: string[]) => void;
  /** The round's research rows and settings (RESEARCH-PLAN §8.4); absent hides research. */
  research?: {
    rows: Map<string, RoundResearchRow>;
    settings: AiSettings | null | undefined;
    onChange: () => void;
    /** Offer a refresh when someone lands in Meeting with an old dossier (R10). */
    refreshOffer: (investorId: string) => { label: string; onClick: () => void } | null;
    /** Research or match the selection (the estimate dialog). */
    onBulk: (kind: "identity" | "dossier", ids: string[]) => void;
  };
}) {
  const toast = useToast();
  const { workspace } = useWorkspace();
  const workspaceName = workspace.name;
  const me = useOptionalSession()?.user;
  // A phone, portrait or on its side (under 500px tall): the takeover.
  const phone = useCompact();
  const wide = useMediaQuery("(min-width: 1024px)") !== false;
  const viewportWide = useMediaQuery("(min-width: 1280px)") !== false;
  const roomy = viewportWide && !squeezed;
  // Under 1280px the open file leaves no room for the queue beside the decision panel: the
  // pane alone stays, so digits still file and the next file opens (critique 4: a modal over
  // the panel at 1024 meant filing blind).
  const showQueue = wide && !(squeezed && !viewportWide);
  const openStage = stages.find((s) => s.key === openKey)!;
  const targets = useMemo(() => triageTargets(stages), [stages]);
  const byKey = useMemo(() => new Map(stages.map((s) => [s.key, s])), [stages]);

  /* ---------- the session queue ---------- */
  // Every investor seen in New this session stays in the queue (decided rows stay in place),
  // ordered by the fit they had when first seen, so a fit change never makes a row jump.
  const seen = useRef(new Map<string, number>());
  for (const p of allRows) if (p.stage.key === openKey && !seen.current.has(p.investor.id)) seen.current.set(p.investor.id, p.fit);
  const [decided, setDecided] = useState<Map<string, string>>(new Map());
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The queue shows only the selection ("86 selected" with none of them on screen read as broken). */
  const [showSel, setShowSel] = useState(false);
  const [scrollReq, setScrollReq] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!selected.size) setShowSel(false);
  }, [selected.size]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  /** When each single decision was made (bulk moves are not a pace; critique 3). */
  const [times, setTimes] = useState<number[]>([]);
  /** Investors moved by bulk moves this session. */
  const [bulkN, setBulkN] = useState(0);
  const sessionStart = useRef(Date.now());
  const undoStack = useRef<Decision[]>([]);
  const turnSnap = useRef(new Map<string, Snapshot>());

  const queue = useMemo(() => {
    const fitOf = (p: Participant) => seen.current.get(p.investor.id) ?? p.fit;
    return allRows
      .filter((p) => seen.current.has(p.investor.id) && matches(p))
      .sort((a, b) => {
        const fa = fitOf(a);
        const fb = fitOf(b);
        if (fb !== fa) return fb - fa;
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.investor.name.localeCompare(b.investor.name);
      });
  }, [allRows, matches]);
  const fitAtSeen = (p: Participant) => seen.current.get(p.investor.id) ?? p.fit;
  const isOpen = useCallback((p: Participant) => p.stage.key === openKey, [openKey]);

  const sliceRows = useMemo(
    () => (showSel && selected.size ? queue.filter((p) => selected.has(p.investor.id)) : queue.filter((p) => inSlice(fitAtSeen(p), slice))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, slice, showSel, showSel ? selected : null],
  );
  const order = useMemo(() => sliceRows.map((p) => p.investor.id), [sliceRows]);
  const rowById = useMemo(() => new Map(queue.map((p) => [p.investor.id, p])), [queue]);
  const done = useCallback(
    (id: string) => {
      const p = rowById.get(id);
      return !p || !isOpen(p) || skipped.has(id);
    },
    [rowById, isOpen, skipped],
  );
  // One population everywhere (critique 3): the segment, the pills, the group headers and the
  // pane header all count who is still New. Skipped investors are still New; they show as
  // "1 skipped" beside the count instead of quietly leaving it.
  const sliceCount = (s: TriageSlice) => queue.filter((p) => isOpen(p) && inSlice(fitAtSeen(p), s)).length;
  const openCount = allRows.filter((p) => p.stage.key === openKey).length;
  const stageCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of allRows) c[p.stage.key] = (c[p.stage.key] ?? 0) + 1;
    return c;
  }, [allRows]);
  const total = allRows.length;
  const sorted = total - openCount;

  // The cursor: the URL's investor when it is in this slice, else the next undecided one.
  const cursor = useMemo(() => {
    if (at && order.includes(at)) return at;
    return nextCursor(order, null, done);
  }, [at, order, done]);
  const current = cursor ? rowById.get(cursor) : undefined;
  useEffect(() => {
    if (cursor !== at) onCursor(cursor);
  }, [cursor, at, onCursor]);
  // The sheet walks who is still New in this slice, the population every count here uses
  // (critique 4: the file said "15 of 411" beside "312 in New").
  const walkOrder = useMemo(
    () => order.filter((id) => id === cursor || Boolean(rowById.get(id) && isOpen(rowById.get(id)!))),
    [order, cursor, rowById, isOpen],
  );
  useEffect(() => onOrder?.(walkOrder), [walkOrder, onOrder]);
  // The snapshot Undo restores: what the investor looked like when their turn began.
  if (current && !turnSnap.current.has(current.investor.id)) turnSnap.current.set(current.investor.id, snap(current));

  const go = (id: string | null) => onCursor(id);
  // The open file follows the queue: a decision opens the next investor's file, and walking
  // the file with J / K moves the queue's cursor with it.
  const fileOpen = squeezed && Boolean(fileId);
  const lastFile = useRef(fileId);
  useEffect(() => {
    if (fileId === lastFile.current) return;
    lastFile.current = fileId;
    if (fileId && fileId !== cursor && order.includes(fileId)) onCursor(fileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);
  useEffect(() => {
    if (fileOpen && cursor && cursor !== fileId) onOpenFile(cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);
  const advanceFrom = (id: string, extraDone: Set<string> = new Set()) =>
    nextCursor(order, id, (x) => extraDone.has(x) || done(x));

  /* ---------- full investor: fetch the current one, prefetch the next two (LRU 10) ---------- */
  const cache = useRef(new Map<string, FullInvestor>());
  const inflight = useRef(new Map<string, Promise<void>>());
  const [, bump] = useState(0);
  const fetchFull = useCallback(
    (id: string) => {
      if (cache.current.has(id) || inflight.current.has(id)) return;
      const job = Promise.all([getInvestor(client, id), listActivities(client, { investor_id: id, limit: 8 })])
        .then(([investor, acts]) => {
          cache.current.set(id, { investor, acts: acts.data });
        })
        .catch((err) => {
          cache.current.set(id, { error: errorMessage(err) });
        })
        .finally(() => {
          inflight.current.delete(id);
          while (cache.current.size > LRU) cache.current.delete(cache.current.keys().next().value!);
          bump((n) => n + 1);
        });
      inflight.current.set(id, job);
    },
    [client],
  );
  useEffect(() => {
    if (!cursor) return;
    fetchFull(cursor);
    const a = nextCursor(order, cursor, done);
    const b = a ? nextCursor(order, a, (x) => x === a || done(x)) : null;
    for (const id of [a, b]) if (id && id !== cursor) fetchFull(id);
  }, [cursor, order, done, fetchFull]);
  const full = cursor ? cache.current.get(cursor) : undefined;
  // Once an investor's stage moves, their timeline is stale.
  const refreshFull = (id: string) => {
    cache.current.delete(id);
  };

  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  useEffect(() => {
    let live = true;
    void importRunsCached(client).then((r) => live && setRuns(r));
    return () => {
      live = false;
    };
  }, [client]);

  /* ---------- writes ---------- */
  /** "Draft intro email" was clicked for this investor: Contacted needs no confirm. */
  const [drafted, setDrafted] = useState<string | null>(null);
  const [nextStepFocus, setNextStepFocus] = useState(0);
  const [followPick, setFollowPick] = useState<string | null | undefined>(undefined);

  /**
   * What just happened, with Undo. On desktop it is a line in the decision panel, beside the
   * buttons it answers, instead of a toast over the investor (critique 3); phones keep the
   * toast above the bottom bar. Failures are always toasts.
   */
  const [notice, setNotice] = useState<{ id: number; text: string; undo?: () => void; extra?: { label: string; onClick: () => void } } | null>(null);
  const noticeSeq = useRef(0);
  const notify = useCallback(
    (text: string, undoFn?: () => void, extra?: { label: string; onClick: () => void }) => {
      if (phone) {
        const acts = [...(extra ? [extra] : []), ...(undoFn ? [{ label: "Undo", onClick: undoFn }] : [])];
        toast.show(text, acts.length ? acts : undefined);
        return;
      }
      noticeSeq.current += 1;
      setNotice({ id: noticeSeq.current, text, undo: undoFn, extra });
    },
    [phone, toast],
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), 12_000);
    return () => clearTimeout(t);
  }, [notice]);

  // A selection is a new subject: the last single-investor notice ("Bram is back in New. Undo")
  // leaves with it (critique 4).
  const selecting = selected.size > 0;
  useEffect(() => {
    if (selecting) setNotice(null);
  }, [selecting]);

  const undo = useCallback(
    async (d?: Decision) => {
      const entry = d ?? undoStack.current[undoStack.current.length - 1];
      if (!entry) return;
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      const items: BulkItem[] = entry.snaps.map((s) => ({
        investor_id: s.investor_id,
        stage: s.stage,
        fit: s.fit,
        follow_up_on: s.follow_up_on,
        follow_up_note: s.follow_up_note,
        next_step: s.next_step,
      }));
      const prev = entry.ids.map((id) => rowById.get(id)).filter(Boolean) as Participant[];
      const snaps = new Map(entry.snaps.map((s) => [s.investor_id, s]));
      store.apply(entry.ids, (p) => {
        const s = snaps.get(p.investor.id)!;
        return {
          ...p,
          stage: byKey.get(s.stage) ?? p.stage,
          fit: s.fit,
          priority: priorityFromFit(s.fit),
          follow_up_on: s.follow_up_on,
          follow_up_note: s.follow_up_note,
          follow_up_state: followUpState(s.follow_up_on, today),
          next_step: s.next_step,
        };
      });
      if (entry.kind === "move") {
        setDecided((m) => {
          const n = new Map(m);
          for (const id of entry.ids) n.delete(id);
          return n;
        });
        if (entry.to) setCounts((c) => ({ ...c, [entry.to!]: Math.max(0, (c[entry.to!] ?? 0) - entry.ids.length) }));
        if (entry.bulk) setBulkN((n) => Math.max(0, n - entry.ids.length));
        else setTimes((t) => t.filter((x) => x !== entry.at));
      }
      if (entry.revert) {
        void entry.revert().catch((err) => toast.show(`Couldn't put the research changes back. ${errorMessage(err)}`));
      }
      const back = entry.bulk && entry.cursor ? entry.cursor : entry.ids[0]!;
      go(back);
      if (entry.bulk) setScrollReq((r) => ({ id: back, n: (r?.n ?? 0) + 1 }));
      try {
        const r = await bulkUpdateParticipants(client, round.id, { op: "restore", items });
        store.commit(r.participants);
        for (const id of entry.ids) refreshFull(id);
        const who = entry.snaps[0]!.name;
        const msg =
          entry.kind === "edit"
            ? `Undid the ${entry.what ?? "change"} for ${who}.`
            : entry.ids.length === 1
              ? `${who} is back in ${openStage.label}.`
              : `${num(entry.ids.length)} investors are back in ${openStage.label}.`;
        store.announce(msg);
        notify(msg);
        store.afterWrite();
      } catch (err) {
        store.rollback(prev);
        toast.show(`Couldn't undo. ${errorMessage(err)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowById, byKey, client, round.id, store, toast, notify, today, openStage.label],
  );

  /** Push onto the Undo stack (20 kept). A move replaces this investor's earlier edits: its
   * snapshot already puts them back. */
  const pushUndo = (entry: Decision) => {
    const ids = new Set(entry.ids);
    const keep = entry.kind === "move" ? undoStack.current.filter((x) => !(x.kind === "edit" && x.ids.some((id) => ids.has(id)))) : undoStack.current;
    undoStack.current = [...keep.slice(-19), entry];
  };

  const decideOne = async (p: Participant, to: Stage) => {
    if (!canWrite || p.stage.key === to.key) {
      if (p.stage.key === to.key) go(advanceFrom(p.investor.id));
      return;
    }
    const id = p.investor.id;
    const snapshot = turnSnap.current.get(id) ?? snap(p);
    const entry: Decision = { kind: "move", ids: [id], snaps: [snapshot], to: to.key, at: Date.now() };
    const prev = p;
    store.apply([id], (x) => ({ ...x, stage: to }));
    setDecided((m) => new Map(m).set(id, to.key));
    setCounts((c) => ({ ...c, [to.key]: (c[to.key] ?? 0) + 1 }));
    setTimes((t) => [...t, entry.at]);
    pushUndo(entry);
    go(advanceFrom(id, new Set([id])));
    try {
      const res = await moveStage(client, round.id, id, to.key);
      store.commit([res.participant]);
      refreshFull(id);
      const msg = `${p.investor.name} moved to ${to.label}.`;
      store.announce(msg);
      const offer = research?.refreshOffer(id) ?? null;
      notify(offer ? `${msg} Refresh the dossier before the meeting?` : msg, () => void undo(entry), offer ?? undefined);
      store.afterWrite();
    } catch (err) {
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      store.rollback([prev]);
      setDecided((m) => {
        const n = new Map(m);
        n.delete(id);
        return n;
      });
      setCounts((c) => ({ ...c, [to.key]: Math.max(0, (c[to.key] ?? 0) - 1) }));
      setTimes((t) => t.filter((x) => x !== entry.at));
      go(id);
      const code = (err as { code?: string }).code;
      toast.show(`Couldn't move ${p.investor.name}.${code ? ` ${code}` : ""}`, { label: "Retry", onClick: () => void decideOne(prev, to) });
    }
  };

  const decideMany = async (ids: string[], to: Stage) => {
    const rows = ids.map((id) => rowById.get(id)).filter(Boolean) as Participant[];
    if (!rows.length || !canWrite) return;
    const entry: Decision = {
      kind: "move",
      ids: rows.map((p) => p.investor.id),
      snaps: rows.map(snap),
      to: to.key,
      at: Date.now(),
      bulk: true,
      cursor,
    };
    const set = new Set(entry.ids);
    store.apply(entry.ids, (x) => ({ ...x, stage: to }));
    setDecided((m) => {
      const n = new Map(m);
      for (const id of entry.ids) n.set(id, to.key);
      return n;
    });
    setCounts((c) => ({ ...c, [to.key]: (c[to.key] ?? 0) + entry.ids.length }));
    setBulkN((n) => n + entry.ids.length);
    setSelected(new Set());
    setShowSel(false);
    pushUndo(entry);
    // The cursor stays on an undecided row the selection did not include (critique 1: a bulk
    // move must never skip Ada).
    const nextId = cursorAfterMove(order, cursor, set, done);
    go(nextId);
    // Bring the cursor back into view (the list may still show the moved selection).
    if (nextId) setScrollReq((r) => ({ id: nextId, n: (r?.n ?? 0) + 1 }));
    const pick = followPick;
    setFollowPick(undefined);
    try {
      const body: BulkInput = { op: "stage", investor_ids: entry.ids, stage: to.key };
      const r = await bulkUpdateParticipants(client, round.id, body);
      store.commit(r.participants);
      if (pick !== undefined) {
        const f = await bulkUpdateParticipants(client, round.id, { op: "follow_up", investor_ids: entry.ids, follow_up_on: pick });
        store.commit(f.participants);
      }
      const msg = `Moved ${num(r.changed)} ${r.changed === 1 ? "investor" : "investors"} to ${to.label}.`;
      store.announce(msg);
      notify(msg, () => void undo(entry));
      store.afterWrite();
    } catch (err) {
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      store.rollback(rows);
      setDecided((m) => {
        const n = new Map(m);
        for (const id of entry.ids) n.delete(id);
        return n;
      });
      setCounts((c) => ({ ...c, [to.key]: Math.max(0, (c[to.key] ?? 0) - entry.ids.length) }));
      setBulkN((n) => Math.max(0, n - entry.ids.length));
      toast.show(`Nothing was moved. ${errorMessage(err)}`);
    }
  };

  /**
   * "Contacted" and later stages say you are already talking. Filing someone there from a
   * fresh import asks once (press the key again to confirm), unless the intro email was just
   * drafted or the founder said not to ask again this session (critique 2).
   */
  const [confirm, setConfirm] = useState<{ to: Stage; n: number } | null>(null);
  const [trustContact, setTrustContact] = useState(false);
  useEffect(() => setConfirm(null), [cursor, selected.size]);
  const decide = (to: Stage) => {
    const n = selected.size || (current ? 1 : 0);
    if (!n) return;
    const asked = confirm?.to.key === to.key;
    setConfirm(null);
    const draftedThis = !selected.size && current && drafted === current.investor.id;
    if (!asked && !trustContact && !draftedThis && claimsContact(to)) {
      setConfirm({ to, n });
      store.announce(
        n === 1
          ? `${to.label} means you reached out. Press ${targets.find((t) => t.stage.key === to.key)?.key ?? "it"} again to confirm.`
          : `${to.label} means you reached out to all ${num(n)}. Press again to confirm.`,
      );
      return;
    }
    if (selected.size) return void decideMany([...selected], to);
    if (current) void decideOne(current, to);
  };

  const skip = () => {
    if (!current) return;
    const id = current.investor.id;
    setSkipped((s) => new Set(s).add(id));
    go(advanceFrom(id, new Set([id])));
  };

  const setFollow = async (iso: string | null) => {
    if (selected.size) {
      setFollowPick(iso);
      notify(iso ? `Follow-up ${formatDate(iso, today)} goes with the next move.` : "No follow-up with the next move.");
      return;
    }
    if (!current || !canWrite) return;
    const p = current;
    if ((p.follow_up_on ?? null) === iso) return;
    const entry: Decision = { kind: "edit", ids: [p.investor.id], snaps: [snap(p)], to: null, at: Date.now(), what: "follow-up" };
    store.apply([p.investor.id], (x) => ({ ...x, follow_up_on: iso, follow_up_state: followUpState(iso, today) }));
    pushUndo(entry);
    try {
      const r = await setFollowUp(client, round.id, p.investor.id, iso ? { on: iso } : { clear: true });
      store.commit([r.participant]);
      const msg = iso ? `Follow up with ${p.investor.name} ${formatDate(iso, today)}.` : `Follow-up cleared for ${p.investor.name}.`;
      store.announce(msg);
      notify(msg, () => void undo(entry));
      store.afterWrite();
    } catch (err) {
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      store.rollback([p]);
      toast.show(`Couldn't set the follow-up. ${errorMessage(err)}`);
    }
  };

  const changeFit = async (delta: number) => {
    if (!current || !canWrite) return;
    const p = current;
    const fit = Math.max(0, Math.min(5, p.fit + delta));
    if (fit === p.fit) return;
    const entry: Decision = { kind: "edit", ids: [p.investor.id], snaps: [snap(p)], to: null, at: Date.now(), what: "fit change" };
    store.apply([p.investor.id], (x) => ({ ...x, fit, priority: priorityFromFit(fit) }));
    pushUndo(entry);
    try {
      const r = await updateParticipant(client, round.id, p.investor.id, { fit });
      store.commit([r]);
      store.announce(`Fit ${fit} of 5 for ${p.investor.name}.`);
    } catch (err) {
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      store.rollback([p]);
      toast.show(`Couldn't change the fit. ${errorMessage(err)}`);
    }
  };

  /**
   * `A`: accept every pending research suggestion for the current investor (R7). One entry on
   * the Undo stack: U restores the fit from the turn's snapshot and puts the investor fields
   * research changed back to what they were.
   */
  const acceptResearch = async (pending: Suggestion[]) => {
    if (!current || !canWrite || !pending.length) return;
    const p = current;
    const id = p.investor.id;
    const before: InvestorUpdate = {};
    for (const sg of pending) if (sg.field !== "fit") (before as Record<string, unknown>)[sg.field] = sg.current_value ?? null;
    const entry: Decision = {
      kind: "edit",
      ids: [id],
      snaps: [snap(p)],
      to: null,
      at: Date.now(),
      what: "research suggestions",
      revert: Object.keys(before).length
        ? async () => {
            await updateInvestor(client, id, before);
            forgetInvestorResearch(id);
            refreshFull(id);
            research?.onChange();
          }
        : undefined,
    };
    pushUndo(entry);
    try {
      const r = await acceptAllSuggestions(client, { investorIds: [id] });
      forgetInvestorResearch(id);
      refreshFull(id);
      research?.onChange();
      store.afterWrite();
      // An accepted fit changes the participant: read it back so the queue shows it.
      if (pending.some((x) => x.field === "fit")) {
        const fresh = await getParticipant(client, round.id, id).catch(() => null);
        if (fresh) store.commit([fresh]);
      }
      notify(`Accepted ${r.accepted === 1 ? "1 research suggestion" : `${num(r.accepted)} research suggestions`} for ${firstName(p.investor.name)}.`, () => void undo(entry));
    } catch (err) {
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      toast.show(`Couldn't accept the suggestions. ${errorMessage(err)}`);
    }
  };

  const saveNextStep = async (text: string): Promise<boolean> => {
    if (!current || !canWrite) return false;
    const p = current;
    const value = text.trim() || null;
    if ((p.next_step ?? null) === value) return false;
    const entry: Decision = { kind: "edit", ids: [p.investor.id], snaps: [snap(p)], to: null, at: Date.now(), what: "next step" };
    store.apply([p.investor.id], (x) => ({ ...x, next_step: value }));
    pushUndo(entry);
    try {
      const r = await updateParticipant(client, round.id, p.investor.id, { next_step: value });
      store.commit([r]);
      return true;
    } catch (err) {
      undoStack.current = undoStack.current.filter((x) => x !== entry);
      store.rollback([p]);
      toast.show(`Couldn't save the next step. ${errorMessage(err)}`);
      return false;
    }
  };

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectIds = (ids: string[]) => setSelected((s) => new Set([...s, ...ids]));
  /** "Select 86": select them and bring the first of them into view. */
  const selectGroup = (ids: string[]) => {
    selectIds(ids);
    const first = order.find((id) => ids.includes(id));
    if (first) setScrollReq((r) => ({ id: first, n: (r?.n ?? 0) + 1 }));
  };

  // J / K walk the rows still in New (filed rows fold into "12 sorted" in the queue).
  const step = (dir: 1 | -1, extend = false) => {
    const walk = order.filter((id) => id === cursor || (rowById.get(id) && isOpen(rowById.get(id)!)));
    if (!walk.length) return;
    const i = cursor ? walk.indexOf(cursor) : -1;
    const j = Math.max(0, Math.min(walk.length - 1, i + dir));
    if (extend && cursor) selectIds([cursor, walk[j]!]);
    go(walk[j]!);
  };

  const linkedin = () => {
    const inv = full?.investor;
    const url =
      inv?.linkedin_url ??
      (current
        ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([current.investor.name, current.investor.firm].filter(Boolean).join(" "))}`
        : null);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  /* ---------- keys (DECISION §6), all through useHotkey ---------- */
  const on = keysEnabled && canWrite;
  // With the file open beside the queue, the digits, S and U still decide (the sheet has no
  // keys of its own for them); its J, K, N and F win.
  const decideOn = (keysEnabled || squeezed) && canWrite;
  const hk = { blockedByModals: true, group: "Triage" } as const;
  for (let i = 0; i < 9; i++) {
    const t = targets[i];
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useHotkey(String(i + 1), () => t && decide(t.stage), {
      ...hk,
      enabled: decideOn && Boolean(t),
      description: i === 0 ? "File in a stage (1–9), then the next investor" : undefined,
    });
  }
  useHotkey("s", skip, { ...hk, enabled: decideOn, description: "Skip for now" });
  // With a selection on screen, U would undo something the screen is no longer about
  // (critique 4); Esc first.
  useHotkey("u", () => void undo(), { ...hk, enabled: decideOn && !selected.size, description: "Undo the last change (a move, follow-up, fit or next step)" });
  useHotkey("[", () => void changeFit(-1), { ...hk, enabled: on, description: "Fit −1" });
  useHotkey("]", () => void changeFit(1), { ...hk, enabled: on, description: "Fit +1" });
  useHotkey("n", () => setNextStepFocus((n) => n + 1), { ...hk, enabled: on, description: "Next step" });
  useHotkey("x", () => cursor && toggleSel(cursor), { ...hk, enabled: on, description: "Select the row" });
  useHotkey("enter", () => cursor && onOpenFile(cursor), { ...hk, enabled: keysEnabled && Boolean(cursor), description: "Open the full file" });
  useHotkey("l", linkedin, { ...hk, enabled: keysEnabled && Boolean(current), description: "Open LinkedIn" });
  useHotkey("j", () => step(1), { ...hk, enabled: keysEnabled, description: "Next in the queue" });
  useHotkey("k", () => step(-1), { ...hk, enabled: keysEnabled, description: "Previous in the queue" });
  useHotkey("arrowdown", () => step(1), { ...hk, enabled: keysEnabled });
  useHotkey("arrowup", () => step(-1), { ...hk, enabled: keysEnabled });
  useHotkey("shift+j", () => step(1, true), { ...hk, enabled: on });
  useHotkey("shift+k", () => step(-1, true), { ...hk, enabled: on });
  useHotkey("shift+arrowdown", () => step(1, true), { ...hk, enabled: on });
  useHotkey("shift+arrowup", () => step(-1, true), { ...hk, enabled: on });
  useHotkey("escape", () => (confirm ? setConfirm(null) : setSelected(new Set())), {
    ...hk,
    enabled: selected.size > 0 || Boolean(confirm),
    description: "Clear the selection",
  });
  const picks = quickPicks("followup", today);
  const pickIso = (k: string) => picks.find((p) => p.kbd === k)?.iso ?? null;
  const follows = followOptions(picks);
  // Only the chords the follow-up row shows (critique 4: "?" listed F 7 on a Monday, when the
  // row offers In 2 weeks instead).
  const offers = (k: string) => follows.some((f) => f.kbd === k);
  useHotkey("f 1", () => void setFollow(pickIso("1")), { ...hk, enabled: on && offers("1"), description: "Follow up tomorrow" });
  useHotkey("f m", () => void setFollow(pickIso("m")), { ...hk, enabled: on && offers("m"), description: "Follow up next Monday" });
  useHotkey("f 7", () => void setFollow(pickIso("7")), { ...hk, enabled: on && offers("7"), description: "Follow up in 1 week" });
  useHotkey("f 2", () => void setFollow(pickIso("2")), { ...hk, enabled: on && offers("2"), description: "Follow up in 2 weeks" });
  const pickRef = useRef<HTMLDivElement>(null);
  useHotkey(
    "f d",
    () => pickRef.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.click(),
    { ...hk, enabled: on, description: "Follow up on a date" },
  );

  /* ---------- layout ---------- */
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (phone) return;
    const measure = () => {
      const el = rootRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(480, Math.floor(window.innerHeight - top - 14)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [phone]);
  const [queueOpen, setQueueOpen] = useState(false);

  // Still to decide here and not skipped: what the done states need.
  const place = queuePosition(order, cursor, (id) => {
    const p = rowById.get(id);
    return Boolean(p && isOpen(p) && !skipped.has(id));
  });
  const sliceLeft = place.left;
  const sliceSkipped = sliceRows.filter((p) => isOpen(p) && skipped.has(p.investor.id)).length;
  /** Everyone still New in the slice on screen (skipped ones included): the header's count. */
  const sliceOpen = sliceRows.filter(isOpen).length;

  const pace = paceEstimate(times);
  const hwLeft = sliceCount("hw");
  const fit0 = queue.filter((p) => isOpen(p) && fitAtSeen(p) === 0 && !skipped.has(p.investor.id)).map((p) => p.investor.id);
  const sessionLine = (() => {
    const n = Object.values(counts).reduce((x, y) => x + y, 0);
    if (!n) {
      // Before the first decision: where to start, the time labelled as the guess it is.
      const first = hwLeft ? "hw" : (["maybe", "low"] as const).find((k) => sliceCount(k) > 0);
      if (!first) return null;
      const k = first === "hw" ? hwLeft : sliceCount(first);
      const who = first === "hw" ? (k === 1 ? "Hot or Warm investor" : "Hot and Warm") : SLICE_LABEL[first];
      return `Start with the ${num(k)} ${who}: about ${formatDuration(k * START_SECONDS * 1000)} at ${START_SECONDS}s each.`;
    }
    // Only real single decisions make a pace; a bulk move is said as one (critique 3).
    const head = `${num(n)} sorted in ${formatElapsed(Date.now() - sessionStart.current)}${bulkN ? `, ${num(bulkN)} of them in bulk` : ""}.`;
    if (!pace.perMs || !openCount) return head;
    // Faster than the floor, plan at the floor and say so (critique 4: "1s each … 10 min").
    if (pace.floored) return `${head} Planning at 10s each, the rest of ${openStage.label} takes ${formatRest(openCount * pace.perMs)}.`;
    return `${head} At ${formatEach(pace.perMs)}, the rest of ${openStage.label} takes ${formatRest(openCount * pace.perMs)}.`;
  })();

  const sel = selected.size ? queue.filter((p) => selected.has(p.investor.id)) : [];
  // A source every investor in the queue shares ("SF Tech Week" on all 411) is not shown.
  const sharedSource = useMemo(() => sharedValue(queue.map((p) => extras[p.investor.id]?.source)), [queue, extras]);

  // Who comes after this one (phones only: on desktop the queue beside the pane shows them).
  const upNext = useMemo(() => {
    const out: Participant[] = [];
    const seenIds = new Set<string>();
    let from = cursor;
    while (from && out.length < 3) {
      const id = nextCursor(order, from, (x) => x === cursor || seenIds.has(x) || done(x));
      if (!id) break;
      seenIds.add(id);
      out.push(rowById.get(id)!);
      from = id;
    }
    return out;
  }, [cursor, order, done, rowById]);
  // Others from the same firm anywhere in the round (a second partner changes the decision).
  const sameFirm = useMemo(() => {
    const firm = current?.investor.firm?.trim().toLowerCase();
    if (!firm) return [];
    return allRows
      .filter((p) => p.investor.id !== current!.investor.id && p.investor.firm?.trim().toLowerCase() === firm)
      .sort((a, b) => b.stage.position - a.stage.position || b.fit - a.fit);
  }, [allRows, current]);
  const goTo = (id: string) => (order.includes(id) ? go(id) : onOpenFile(id));

  const panelRef = useRef<HTMLDivElement>(null);
  useToastLift(panelRef, !phone && Boolean(current || sel.length));

  const allFit0Selected = fit0.length > 0 && fit0.every((id) => selected.has(id));
  // Research shows in the panel when it can run here or the round already has some (an
  // agent's dossiers need no key); the same for every investor, so the panel never jumps.
  const showResearch = Boolean(
    research && (research.settings?.research_available || [...research.rows.values()].some((r) => r.verdict || r.identity_status === "needs_pick")),
  );
  const researchFor = (onPhone: boolean) =>
    research && showResearch && current && !sel.length ? (
      <TriageResearch
        key={current.investor.id}
        investorId={current.investor.id}
        name={current.investor.name}
        row={research.rows.get(current.investor.id) ?? full?.investor?.research ?? null}
        settings={research.settings}
        client={client}
        wsSlug={wsSlug}
        round={round.id}
        today={today}
        currency={round.currency}
        canWrite={canWrite}
        keysEnabled={keysEnabled && !confirm && !onPhone}
        onChanged={() => {
          refreshFull(current.investor.id);
          research.onChange();
          store.afterWrite();
        }}
        onAcceptAll={acceptResearch}
        onOpenDossier={() => onOpenFile(current.investor.id)}
      />
    ) : null;

  const decisionPanel = (
    <DecisionPanel
      ref={panelRef}
      who={sel.length ? null : current ? firstName(current.investor.name) : null}
      bulk={sel.length}
      targets={targets}
      counts={stageCounts}
      currentStage={sel.length ? null : (current?.stage.key ?? null)}
      followUp={sel.length ? (followPick ?? null) : (current?.follow_up_on ?? null)}
      follows={follows}
      today={today}
      timeZone={timeZone}
      disabled={!canWrite || (!current && !sel.length)}
      focusKey={sel.length ? "sel" : (cursor ?? "")}
      pickRef={pickRef}
      fileOpen={fileOpen}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      drafted={Boolean(current && drafted === current.investor.id)}
      contacted={(() => {
        const t = targets.find((x) => x.stage.kind === "active" && x.key);
        return t ? { key: t.key!, label: t.stage.label } : null;
      })()}
      confirm={
        confirm
          ? {
              to: confirm.to,
              n: confirm.n,
              key: targets.find((t) => t.stage.key === confirm.to.key)?.key ?? null,
              shortlist: targets.find((t) => t.stage.kind === "open") ?? null,
            }
          : null
      }
      onCancelConfirm={() => setConfirm(null)}
      onTrust={() => {
        setTrustContact(true);
        if (confirm) {
          const to = confirm.to;
          setConfirm(null);
          if (selected.size) void decideMany([...selected], to);
          else if (current) void decideOne(current, to);
        }
      }}
      onDecide={decide}
      onFollow={(iso) => void setFollow(iso)}
      research={!fileOpen ? researchFor(false) : null}
    />
  );

  const pane = sel.length ? (
    <SelectionPane
      rows={sel}
      openLabel={openStage.label}
      onClear={() => setSelected(new Set())}
      onResearch={research && canWrite ? (kind) => research.onBulk(kind, sel.map((p) => p.investor.id)) : undefined}
    />
  ) : current && fileOpen ? (
    // The file beside the queue already shows who this is: the pane keeps only the decision.
    <p className="t-body-s px-20 pt-14 pb-10 text-muted">
      <b className="font-semibold text-fg">{current.investor.name}</b>&apos;s file is open on the right. A stage below files them and
      opens the next file; <Kbd>Esc</Kbd> closes it.
    </p>
  ) : current ? (
    <InvestorPane
      key={current.investor.id}
      p={current}
      full={full}
      runs={runs}
      round={round}
      wsSlug={wsSlug}
      workspaceName={workspaceName}
      senderName={me?.name ?? null}
      today={today}
      timeZone={timeZone}
      industries={extras[current.investor.id]?.industries ?? []}
      canWrite={canWrite}
      nextStepFocus={nextStepFocus}
      onSaveNextStep={saveNextStep}
      decidedStage={!isOpen(current) ? current.stage : null}
      sameFirm={sameFirm}
      sharedSource={sharedSource}
      onGo={goTo}
      onDrafted={() => setDrafted(current.investor.id)}
    />
  ) : null;

  const doneState = !current && !sel.length ? (
    openCount === 0 ? (
      <EmptyState
        className="m-24"
        title={`Everyone in ${round.name} is sorted.`}
        actions={<Button variant="primary" onClick={onOpenBoard}>Open board</Button>}
      >
        {num(total)} sorted.{" "}
        {(() => {
          const c = stages.find((s) => s.kind === "active");
          const n = c ? allRows.filter((p) => p.stage.key === c.key).length : 0;
          return c && n ? `${num(n)} are ${c.label}.` : null;
        })()}
      </EmptyState>
    ) : sliceSkipped > 0 && sliceLeft === 0 ? (
      <EmptyState
        className="m-24"
        title={`You skipped ${num(sliceSkipped)}.`}
        actions={
          <>
            <Button variant="primary" onClick={() => setSkipped(new Set())}>
              Go through them
            </Button>
            <Button onClick={onOpenBoard}>Open board</Button>
          </>
        }
      >
        Everything else in {SLICE_LABEL[slice]} is sorted.
      </EmptyState>
    ) : (
      <EmptyState
        className="m-24"
        title={`${slice === "all" ? "Everyone" : SLICE_LABEL[slice]} ${slice === "hw" ? "are" : "is"} sorted.`}
        actions={
          <>
            {(() => {
              const nextSlice = (["hw", "maybe", "low"] as TriageSlice[]).find((s) => s !== slice && sliceCount(s) > 0);
              return nextSlice ? (
                <Button variant="primary" onClick={() => onSlice(nextSlice)}>
                  Continue with {SLICE_LABEL[nextSlice]}
                </Button>
              ) : null;
            })()}
            <Button onClick={onOpenBoard}>Open board</Button>
          </>
        }
      >
        {num(openCount)} are still {openStage.label}. Keep going, or open the board.
      </EmptyState>
    )
  ) : null;

  const queuePanel = (
    <TriageQueue
      rows={sliceRows}
      openKey={openKey}
      fitAtSeen={fitAtSeen}
      cursor={cursor}
      selected={selected}
      skipped={skipped}
      decided={decided}
      byKey={byKey}
      agentMarks={agentMarks}
      slice={slice}
      sliceCounts={{ all: sliceCount("all"), hw: hwLeft, maybe: sliceCount("maybe"), low: sliceCount("low") }}
      sorted={sorted}
      total={total}
      skippedCount={skipped.size}
      sessionLine={wide ? sessionLine : null}
      fit0={allFit0Selected ? [] : fit0}
      canWrite={canWrite}
      filter={<FilterMenu fields={filterFields} active={filterActive} onChange={onFilterChange} />}
      active={active}
      showSel={showSel}
      onShowSel={setShowSel}
      scrollReq={scrollReq}
      onSlice={(sl) => {
        setShowSel(false);
        onSlice(sl);
      }}
      onPick={(id, e) => {
        if (e?.shiftKey && canWrite) {
          const a = cursor ? order.indexOf(cursor) : -1;
          const b = order.indexOf(id);
          if (a >= 0 && b >= 0) selectIds(order.slice(Math.min(a, b), Math.max(a, b) + 1));
        }
        go(id);
        setQueueOpen(false);
      }}
      onToggle={toggleSel}
      onSelectIds={selectGroup}
      height={height}
    />
  );

  if (phone) {
    return (
      <TriagePhone
        round={round}
        current={current ?? null}
        full={full}
        extras={extras}
        today={today}
        timeZone={timeZone}
        targets={targets}
        slice={slice}
        openLabel={openStage.label}
        inSlice={sliceOpen}
        sorted={sorted}
        total={total}
        upNext={upNext}
        sameFirm={sameFirm}
        doneState={doneState}
        canWrite={canWrite}
        draftHref={current ? draftHref(reachPerson(current, full?.investor), { workspaceName, round, sender: me?.name ?? null }) : null}
        filter={<FilterMenu fields={filterFields} active={filterActive} onChange={onFilterChange} />}
        onExit={onExit}
        confirm={confirm ? { to: confirm.to, shortlist: targets.find((t) => t.stage.kind === "open") ?? null } : null}
        onTrust={() => {
          setTrustContact(true);
          if (confirm && current) {
            const to = confirm.to;
            setConfirm(null);
            void decideOne(current, to);
          }
        }}
        onDecide={decide}
        onSkip={skip}
        onGo={goTo}
        onFollow={(iso) => void setFollow(iso)}
        onSaveNextStep={saveNextStep}
        onDrafted={() => current && setDrafted(current.investor.id)}
        research={researchFor(true)}
      />
    );
  }

  const where = `${openStage.label}${showSel && sel.length ? " · selection" : slice === "all" ? "" : ` · ${SLICE_LABEL[slice]}`}`;
  // The pane runs the queue's full height with the decision panel pinned to its foot, so the
  // panel never moves between investors (critique 4: "Also at" blocks moved it 100px under the
  // pointer) and no dead canvas sits under it. With the file open beside it, the pane is only
  // the panel and a line, as tall as that.
  const fullPane = !fileOpen;
  return (
    <div
      ref={rootRef}
      className={cn(
        "grid min-h-0 items-start gap-16",
        showQueue ? (squeezed ? "grid-cols-[288px_minmax(0,1fr)]" : roomy ? "grid-cols-[360px_minmax(0,1fr)]" : "grid-cols-[320px_minmax(0,1fr)]") : "grid-cols-1",
      )}
      style={{ height: height ?? "calc(100vh - 200px)" }}
    >
      {showQueue ? queuePanel : null}
      <section
        aria-label={current ? `Triage: ${current.investor.name}` : "Triage"}
        className="flex min-h-0 min-w-0 flex-col overflow-clip rounded-md border border-line bg-surface"
        style={fullPane ? { height: height ?? undefined } : { maxHeight: height ?? undefined }}
      >
        <header className="flex h-44 shrink-0 items-center gap-8 border-b border-line px-16">
          {!wide ? (
            <Button size="sm" onClick={() => setQueueOpen(true)}>
              Queue <span className="font-mono text-[11.5px] text-muted">{num(sliceOpen)}</span>
            </Button>
          ) : null}
          <span className="t-micro min-w-0 truncate text-muted" aria-live="polite">
            {sel.length
              ? "Bulk move"
              : `${num(sliceOpen)} in ${where}${sliceSkipped ? ` · ${num(sliceSkipped)} skipped` : ""}${
                  current && !isOpen(current) ? ` · this one is in ${current.stage.label}` : " · highest fit first"
                }`}
          </span>
          {sel.length ? null : (
            <span className="flex shrink-0 items-center gap-4">
              <button type="button" className={NAV} onClick={() => step(-1)} aria-label="Previous investor" title="Previous (K)">
                ↑
              </button>
              <button type="button" className={NAV} onClick={() => step(1)} aria-label="Next investor" title="Next (J)">
                ↓
              </button>
            </span>
          )}
          {current && !sel.length ? (
            <Link
              href={`/w/${encodeURIComponent(wsSlug)}/investors/${current.investor.id}`}
              target="_blank"
              rel="noopener"
              prefetch={false}
              className="link t-body-s ml-auto whitespace-nowrap"
            >
              Open full page ↗
            </Link>
          ) : null}
        </header>
        <div className={cn("relative min-h-0 overflow-y-auto", fullPane ? "flex-1" : "shrink")}>
          {doneState ?? pane}
          {/* A soft edge where a long file scrolls under the decision panel. */}
          {doneState ? null : <div aria-hidden className="pointer-events-none sticky bottom-0 -mt-24 h-24 bg-linear-to-t from-surface to-transparent" />}
        </div>
        {doneState ? null : decisionPanel}
      </section>
      {!wide ? (
        <Sheet open={queueOpen} onClose={() => setQueueOpen(false)} title="Triage queue" width={400}>
          {queuePanel}
        </Sheet>
      ) : null}
    </div>
  );
}

const NAV =
  "inline-flex size-24 items-center justify-center rounded-sm border border-line bg-surface text-[12px] text-muted hover:text-fg";

/* ---------- queue ---------- */

type QRow =
  | { kind: "group"; priority: Priority; left: number; ids: string[]; sorted: number; summary: string; open: boolean }
  /** The rows of a group that were filed this session, folded into one line (critique 2). */
  | { kind: "done"; priority: Priority; n: number; summary: string; parts: { stage: Stage; n: number }[]; open: boolean }
  | { kind: "row"; p: Participant };

function TriageQueue({
  rows,
  openKey,
  fitAtSeen,
  cursor,
  selected,
  skipped,
  decided,
  byKey,
  agentMarks,
  slice,
  sliceCounts,
  sorted,
  total,
  skippedCount,
  sessionLine,
  fit0,
  canWrite,
  filter,
  active,
  showSel,
  onShowSel,
  scrollReq,
  onSlice,
  onPick,
  onToggle,
  onSelectIds,
  height,
}: {
  rows: Participant[];
  openKey: string;
  fitAtSeen: (p: Participant) => number;
  cursor: string | null;
  selected: Set<string>;
  skipped: Set<string>;
  decided: Map<string, string>;
  byKey: Map<string, Stage>;
  agentMarks: Record<string, { tip: string }>;
  slice: TriageSlice;
  sliceCounts: Record<TriageSlice, number>;
  sorted: number;
  total: number;
  skippedCount: number;
  sessionLine: string | null;
  fit0: string[];
  canWrite: boolean;
  filter: ReactNode;
  active: number;
  showSel: boolean;
  onShowSel: (on: boolean) => void;
  /** Bring this row into view (after "Select 86"). */
  scrollReq: { id: string; n: number } | null;
  onSlice: (s: TriageSlice) => void;
  onPick: (id: string, e?: { shiftKey: boolean }) => void;
  onToggle: (id: string) => void;
  onSelectIds: (ids: string[]) => void;
  height: number | null;
}) {
  const body = useRef<HTMLDivElement>(null);
  // Filed rows fold into "12 sorted · 8 Contacted, 4 Passed" per group, so the current row
  // stays near the top instead of under a block of finished names. "Show" unfolds them.
  const [unfolded, setUnfolded] = useState<Set<Priority>>(new Set());
  const toggleFold = (pr: Priority) =>
    setUnfolded((u) => {
      const n = new Set(u);
      if (n.has(pr)) n.delete(pr);
      else n.add(pr);
      return n;
    });
  const list = useMemo(() => {
    const by: Record<Priority, Participant[]> = { hot: [], warm: [], maybe: [], low: [] };
    for (const p of rows) by[priorityFromFit(fitAtSeen(p))].push(p);
    const cursorGroup = (() => {
      const c = rows.find((p) => p.investor.id === cursor);
      return c && c.stage.key !== openKey ? priorityFromFit(fitAtSeen(c)) : null;
    })();
    const out: QRow[] = [];
    for (const pr of PRIORITY_ORDER) {
      if (!by[pr].length) continue;
      // Still New, skipped ones included ("1 left" while a skipped row sits there; critique 3).
      const open = by[pr].filter((p) => p.stage.key === openKey);
      const moved = by[pr].filter((p) => p.stage.key !== openKey);
      const isOpen = unfolded.has(pr) || cursorGroup === pr;
      const summary = breakdown(moved.map((p) => byKey.get(p.stage.key)?.label ?? p.stage.label), 9);
      const partsM = new Map<string, { stage: Stage; n: number }>();
      for (const p of moved) {
        const st = byKey.get(p.stage.key) ?? p.stage;
        const cur = partsM.get(st.key);
        if (cur) cur.n++;
        else partsM.set(st.key, { stage: st, n: 1 });
      }
      const parts = [...partsM.values()].sort((a, b) => a.stage.position - b.stage.position);
      const allDone = moved.length > 0 && moved.length === by[pr].length;
      out.push({ kind: "group", priority: pr, left: open.length, ids: open.map((p) => p.investor.id), sorted: allDone ? moved.length : 0, summary, open: isOpen });
      if (moved.length && !allDone) out.push({ kind: "done", priority: pr, n: moved.length, summary, parts, open: isOpen });
      for (const p of by[pr]) if (isOpen || p.stage.key === openKey) out.push({ kind: "row", p });
    }
    return out;
  }, [rows, fitAtSeen, openKey, unfolded, cursor, byKey]);
  const heightAt = useCallback((i: number) => (list[i]?.kind === "row" ? ROW_H : GROUP_H), [list]);
  const v = useVirtualRows({ scrollRef: body, count: list.length, height: heightAt, initial: 24 });
  const { topOf } = v;
  // Scroll a row into view below the sticky group header (it covers the top 32px).
  const reveal = useCallback(
    (i: number, start: boolean) => {
      const el = body.current;
      if (!el || i < 0) return;
      const top = topOf(i);
      const h = heightAt(i);
      if (start || top < el.scrollTop + GROUP_H) el.scrollTop = Math.max(0, top - GROUP_H);
      else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight;
    },
    [topOf, heightAt],
  );
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const cursorRow = useMemo(() => list.findIndex((r) => r.kind === "row" && r.p.investor.id === cursor), [list, cursor]);
  // Only when the cursor row changes (not on every render: that would undo "Select 86"'s scroll).
  useEffect(() => {
    if (cursorRow >= 0) revealRef.current(cursorRow, false);
  }, [cursorRow]);
  useEffect(() => {
    if (!scrollReq) return;
    revealRef.current(
      list.findIndex((r) => r.kind === "row" && r.p.investor.id === scrollReq.id),
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollReq]);
  const anySel = selected.size > 0;
  const pills: TriageSlice[] = ["all", "hw", "maybe", "low"];
  // The pills stay on one line (critique 4: "Low fit 276" alone on a second line pushed the
  // queue down at 1024 and beside the file): shorter words first, then All loses its count
  // (the pane header says it).
  const pillRow = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(0);
  useLayoutEffect(() => {
    const el = pillRow.current;
    if (el && compact < 2 && el.scrollWidth > el.clientWidth + 1) setCompact((c) => c + 1);
  }, [compact, sliceCounts, anySel]);
  useEffect(() => {
    const el = pillRow.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        setCompact(0);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [anySel]);
  const pillLabel = (sl: TriageSlice) => (compact && sl === "hw" ? "Hot+Warm" : compact && sl === "low" ? "Low" : SLICE_LABEL[sl]);
  const groupRow = (r: Extract<QRow, { kind: "group" }>, stuck = false) => {
    const allSel = r.ids.length > 0 && r.ids.every((id) => selected.has(id));
    return (
      <div
        key={`g-${r.priority}${stuck ? "-stuck" : ""}`}
        className="group/qg sticky top-0 z-[1] flex items-center gap-8 border-b border-line bg-sunk px-14"
        style={{ height: GROUP_H }}
      >
        <span className="t-label shrink-0">{GROUP_LABEL[r.priority]}</span>
        {r.sorted ? (
          <>
            <span className="t-micro min-w-0 truncate text-muted" title={r.summary}>
              · {r.sorted === 1 ? "1 sorted" : `all ${num(r.sorted)} sorted`}
            </span>
            <button type="button" onClick={() => toggleFold(r.priority)} aria-expanded={r.open} className="link t-body-s ml-auto shrink-0 border-0 bg-transparent p-0">
              {r.open ? "Hide" : "Show"}
            </button>
          </>
        ) : (
          <span className="t-micro ml-auto text-muted">{num(r.left)} left</span>
        )}
        {canWrite && r.left > 0 ? (
          <button
            type="button"
            onClick={() => onSelectIds(r.ids)}
            className={cn(
              "t-body-s border-0 bg-transparent p-0 text-accent hover:underline",
              !anySel && "sr-only group-hover/qg:not-sr-only group-focus-within/qg:not-sr-only",
            )}
            disabled={allSel}
          >
            Select {num(r.left)}
          </button>
        ) : null}
      </div>
    );
  };
  // The group of the first visible row stays pinned even when its header row is windowed out.
  const stuckGroup = (() => {
    for (let i = Math.min(v.start, list.length - 1); i >= 0; i--) {
      const r = list[i];
      if (r?.kind === "group") return i < v.start ? r : null;
    }
    return null;
  })();

  return (
    // Not clipped: the Filter menu hangs out of the queue over the pane instead of dragging the
    // queue sideways (critique 3). The bottom rows round their own corners.
    <section
      aria-label="Triage queue"
      className="flex min-h-0 min-w-0 flex-col rounded-md border border-line bg-surface"
      style={height ? { height } : undefined}
    >
      <div className="flex shrink-0 flex-col gap-10 border-b border-line px-14 pt-12 pb-10">
        <div className="flex items-center gap-8">
          <span className="t-label whitespace-nowrap">Triage queue</span>
          <span className="ml-auto [&_kbd]:hidden" title={active ? `${active} filters` : "Filter"}>
            {filter}
          </span>
        </div>
        <div className="flex items-center gap-10">
          <div
            role="meter"
            aria-label="Sorted"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={sorted}
            className="h-4 flex-1 overflow-hidden rounded-pill bg-sunk"
          >
            <i className="block h-full bg-good not-italic transition-[width] duration-[400ms]" style={{ width: `${total ? (sorted / total) * 100 : 0}%` }} />
          </div>
          <span className="t-micro shrink-0 text-muted" aria-live="polite">
            {num(sorted)} of {num(total)} sorted{skippedCount ? ` · ${num(skippedCount)} skipped` : ""}
          </span>
        </div>
        {sessionLine ? <p className="t-body-s text-muted">{sessionLine}</p> : null}
        {selected.size ? (
          <div className="flex items-center gap-8">
            <button
              type="button"
              aria-pressed={showSel}
              onClick={() => onShowSel(!showSel)}
              className={cn(
                "inline-flex h-26 items-center gap-6 rounded-pill border px-10 text-[12.5px] whitespace-nowrap",
                showSel ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg hover:border-muted",
              )}
            >
              {showSel ? "Showing" : "Show"} the {num(selected.size)} selected
            </button>
            {showSel ? (
              <button type="button" className="link t-body-s border-0 bg-transparent p-0" onClick={() => onShowSel(false)}>
                Back to {SLICE_LABEL[slice]}
              </button>
            ) : null}
          </div>
        ) : (
          <div ref={pillRow} role="group" aria-label="Slice" className="flex flex-nowrap gap-4 overflow-hidden">
            {pills.map((s) => {
              const on = s === slice;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSlice(s)}
                  title={SLICE_LABEL[s]}
                  className={cn(
                    "inline-flex h-26 shrink-0 items-center gap-4 rounded-pill border text-[12.5px] whitespace-nowrap",
                    compact ? "px-6" : "px-8",
                    on ? "border-fg bg-fg text-canvas" : "border-line bg-surface text-fg hover:border-muted",
                  )}
                >
                  {pillLabel(s)}
                  {compact >= 2 && s === "all" ? null : (
                    <span className={cn("font-mono text-[11px]", on ? "text-canvas" : "text-muted")}>{num(sliceCounts[s])}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div ref={body} className={cn("relative min-h-0 flex-1 overflow-y-auto scrollbar-thin", !(canWrite && fit0.length >= 20) && "rounded-b-md")} role="listbox" aria-label="Investors in the queue" aria-multiselectable>
        {v.padTop > 0 ? <div aria-hidden style={{ height: v.padTop }} /> : null}
        {stuckGroup ? <div className="sticky top-0 z-[2] h-0 overflow-visible">{groupRow(stuckGroup, true)}</div> : null}
        {list.slice(v.start, v.end).map((r) => {
          if (r.kind === "group") return groupRow(r);
          if (r.kind === "done") {
            return (
              <button
                key={`d-${r.priority}`}
                type="button"
                aria-expanded={r.open}
                onClick={() => toggleFold(r.priority)}
                className="flex w-full min-w-0 items-center gap-8 border-0 border-b border-line bg-canvas px-14 text-left hover:bg-sunk"
                style={{ height: GROUP_H }}
              >
                <span aria-hidden className="text-good-ink">
                  ✓
                </span>
                {/* Dots and counts per stage: never cut mid-word ("1 Contac…"); the words are in the title. */}
                <span className="t-body-s flex min-w-0 flex-1 items-center gap-10 overflow-hidden text-muted" title={r.summary}>
                  <b className="shrink-0 font-semibold text-fg">{num(r.n)} sorted</b>
                  {r.parts.map((x) => (
                    <span key={x.stage.key} className="inline-flex shrink-0 items-center gap-4">
                      <StageDot color={x.stage.color} />
                      <span className="sr-only">{x.stage.label}</span>
                      <span className="font-mono text-[11.5px] tnum">{num(x.n)}</span>
                    </span>
                  ))}
                </span>
                <span className="link t-body-s shrink-0">{r.open ? "Hide" : "Show"}</span>
              </button>
            );
          }
          const p = r.p;
          const id = p.investor.id;
          const isCur = id === cursor;
          const moved = p.stage.key !== openKey;
          const mine = decided.get(id);
          return (
            <div
              key={id}
              role="option"
              aria-selected={isCur}
              className={cn(
                "group/qr relative flex cursor-pointer items-center gap-8 border-b border-line px-14",
                isCur ? "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-canvas",
              )}
              style={{ height: ROW_H }}
              onClick={(e) => onPick(id, e)}
            >
              {canWrite ? (
                <input
                  type="checkbox"
                  tabIndex={-1}
                  aria-label={`Select ${p.investor.name}`}
                  checked={selected.has(id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onToggle(id)}
                  className={cn(
                    "size-14 shrink-0 accent-[var(--accent)]",
                    !anySel && !isCur && "opacity-0 group-hover/qr:opacity-100",
                  )}
                />
              ) : null}
              <span className="flex min-w-0 flex-1 items-baseline gap-6 truncate">
                <span className={cn("shrink-0 font-medium", moved ? "text-muted" : "text-fg")}>{p.investor.name}</span>
                {p.investor.firm ? <span className="t-body-s truncate text-muted">{p.investor.firm}</span> : null}
              </span>
              {moved ? (
                <span className="t-body-s inline-flex shrink-0 items-center gap-6">
                  {!mine && agentMarks[id] ? <span className="agent-diamond" role="img" aria-label={agentMarks[id].tip} /> : null}
                  <StageDot color={p.stage.color} />
                  {byKey.get(p.stage.key)?.label ?? p.stage.label}
                </span>
              ) : skipped.has(id) ? (
                <span className="t-micro shrink-0 text-muted">Skipped</span>
              ) : priorityFromFit(fitAtSeen(p)) === "low" ? (
                // Only Low fit (0–2) varies inside its group; Hot, Warm and Maybe headers already say it.
                <FitMeter value={p.fit} className="shrink-0" />
              ) : null}
            </div>
          );
        })}
        {v.padBottom > 0 ? <div aria-hidden style={{ height: v.padBottom }} /> : null}
      </div>
      {canWrite && fit0.length >= 20 ? (
        <div className="flex shrink-0 items-center gap-10 rounded-b-md border-t border-line bg-sunk px-14 py-10">
          <p className="t-body-s min-w-0 flex-1 text-muted">
            <b className="font-semibold text-fg">{num(fit0.length)} have fit 0.</b> Select them to move them in one go.
          </p>
          <Button size="sm" onClick={() => onSelectIds(fit0)}>
            Select {num(fit0.length)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/* ---------- the investor pane ---------- */

/** The latest three, an import worded once ("imported Calla from x.csv with 410 others"). */
function historyLines(acts: Activity[], runs: ImportRun[] | null, name: string): { at: string; who: string; text: string; imported: boolean }[] {
  const out: { at: string; who: string; text: string; imported: boolean }[] = [];
  const seenRuns = new Set<string>();
  for (const a of acts) {
    const run = importRunOf(a);
    if (run) {
      if (seenRuns.has(run)) continue;
      seenRuns.add(run);
      out.push({ at: a.occurred_at, who: a.actor.label, text: importSentence(firstName(name), runs?.find((x) => x.id === run)), imported: true });
    } else {
      out.push({ at: a.occurred_at, who: a.actor.label, text: activitySentence(a), imported: false });
    }
    if (out.length >= 3) break;
  }
  return out;
}

function InvestorPane({
  p,
  full,
  runs,
  round,
  wsSlug,
  workspaceName,
  senderName,
  today,
  timeZone,
  industries: rowIndustries,
  canWrite,
  nextStepFocus,
  onSaveNextStep,
  decidedStage,
  sameFirm,
  sharedSource,
  onGo,
  onDrafted,
}: {
  p: Participant;
  full: FullInvestor | undefined;
  runs: ImportRun[] | null;
  round: Round;
  wsSlug: string;
  workspaceName: string;
  senderName: string | null;
  today: string;
  timeZone: string;
  industries: string[];
  canWrite: boolean;
  nextStepFocus: number;
  onSaveNextStep: (text: string) => Promise<boolean>;
  decidedStage: Stage | null;
  sameFirm: Participant[];
  sharedSource: string | null;
  onGo: (id: string) => void;
  onDrafted: () => void;
}) {
  const inv = full?.investor;
  const source = inv?.source && inv.source.trim().toLowerCase() !== sharedSource?.toLowerCase() ? inv.source : null;
  const history = full?.acts ? historyLines(full.acts, runs, p.investor.name) : null;
  // Only the import that every investor here shares says nothing: the section hides.
  const historyShown = !history || history.some((h) => !h.imported);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, []);
  const industries = visibleIndustries(inv?.industries ?? rowIndustries);
  const type = p.investor.type !== "other" ? INVESTOR_TYPE_LABEL[p.investor.type] : null;
  const otherRounds = (inv?.rounds ?? []).filter((r) => r.round_id !== round.id);
  // Source is a chip above, so it is not repeated as a fact row.
  const filled = inv?.research?.from_research;
  const marked = (v: ReactNode, fields: string[]): ReactNode =>
    v ? (
      <>
        {v}
        <FromResearch fields={filled} of={fields} />
      </>
    ) : null;
  const facts: [string, ReactNode][] = inv
    ? (
        [
          ["Invests at", marked(inv.stage_focus.map(stageFocusLabel).join(", "), ["stage_focus"])],
          ["Check size", marked(checkSize(inv, round.currency), ["check_min", "check_max"])],
          ["Location", marked(inv.location, ["location"])],
          ["Warm intro by", inv.warm_intro_by],
          [
            "Other rounds",
            otherRounds.length
              ? otherRounds.map((r) => `${r.round_name} · ${r.stage.label}`).join(", ")
              : null,
          ],
        ] as [string, ReactNode][]
      ).filter(([, v]) => Boolean(v))
    : [];
  const notes = inv?.notes?.trim() ?? "";
  const [showAll, setShowAll] = useState(false);
  const who = [p.investor.title, p.investor.firm].filter(Boolean).join(" · ");
  const person = reachPerson(p, inv);
  const draft = draftHref(person, { workspaceName, round, sender: senderName });
  // A scheduled meeting shows as a chip under the name (the same words as the board card).
  const viewerTz = useViewerTimeZone(timeZone);
  const meetSlot = p.next_meeting ? cardSlot({ ...p, follow_up_on: null, follow_up_state: null }, today, round.currency, { timeZone: viewerTz }) : null;

  return (
    <div className="flex flex-col gap-16 px-32 pt-22 pb-24 max-xl:px-20">
      <div>
        <h2 className="font-display text-[28px] leading-[1.1] font-bold tracking-[-0.02em]">{p.investor.name}</h2>
        {who ? <p className="mt-4 text-lg text-muted">{who}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-6">
        {/* Fit is the pips alone (no Hot chip, no "5/5": one encoding). */}
        <span className="mr-4 inline-flex items-center gap-6" title={`Fit ${p.fit} of 5 ([ and ] change it)`}>
          <span className="t-label">Fit</span>
          <FitMeter value={p.fit} />
        </span>
        {type ? <Chip tone="type">{type}</Chip> : null}
        {industries.slice(0, 3).map((i) => (
          <Chip key={i} tone="type">
            {i}
          </Chip>
        ))}
        {industries.length > 3 ? <span className="t-micro text-muted">+{industries.length - 3}</span> : null}
        {source ? <Chip tone="tag">{source}</Chip> : null}
        {meetSlot?.kind === "meeting" ? (
          <Chip tone={meetSlot.today ? "soon" : "type"} title={meetSlot.title}>
            {meetSlot.text}
          </Chip>
        ) : null}
        {decidedStage ? (
          <span className="t-body-s ml-auto inline-flex items-center gap-6 text-muted">
            <StageDot color={decidedStage.color} />
            Now in {decidedStage.label}
          </span>
        ) : null}
      </div>

      {/* Reach out: the actions that come before "Contacted", one style and one order. */}
      <ReachOut person={person} draft={draft} onDrafted={onDrafted} kbd fromResearch={inv?.research?.from_research} />
      {full?.error ? <p className="t-body-s text-bad">{full.error}</p> : null}

      {inv ? (
        facts.length || notes ? (
          <div className="grid grid-cols-1 gap-18 min-[1280px]:grid-cols-2">
            {facts.length ? (
              <section aria-label="Facts">
                <p className="t-label mb-8">Facts</p>
                <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-12 gap-y-6">
                  {facts.map(([k, val]) => (
                    <div key={k} className="contents">
                      <dt className="t-body-s text-muted">{k}</dt>
                      <dd className="m-0 min-w-0 text-base">{val}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}
            {notes ? (
              <section aria-label="Notes">
                <p className="t-label mb-8">Notes</p>
                <p className={cn("rounded-md border border-line bg-canvas p-12 whitespace-pre-wrap", !showAll && "line-clamp-[8]")}>{notes}</p>
                {!showAll && notes.split("\n").length > 8 ? (
                  <button type="button" className="link t-body-s mt-4 border-0 bg-transparent p-0" onClick={() => setShowAll(true)}>
                    Show all
                  </button>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : (
          <p className="t-body-s text-muted">Only the basics so far. LinkedIn is the quickest way to size them up.</p>
        )
      ) : full?.error ? null : (
        <div className="flex flex-col gap-8" aria-hidden>
          {slow ? <p className="t-body-s text-muted">Loading…</p> : null}
          <Skeleton lines={2} />
        </div>
      )}

      <NextStepField
        key={p.investor.id}
        value={p.next_step ?? ""}
        canWrite={canWrite}
        focusReq={nextStepFocus}
        onSave={onSaveNextStep}
      />

      {historyShown ? (
      <section aria-label="History" className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-x-12">
        <p className="t-label">History</p>
        {history ? (
          history.length ? (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {history.map((h, i) => (
                <li key={i} className="t-body-s min-w-0">
                  <span className="mr-8 font-mono text-[11.5px] text-muted">{formatDate(isoDate(h.at, timeZone), today)}</span>
                  <b className="font-semibold">{h.who}</b> {h.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-body-s text-muted">Nothing yet.</p>
          )
        ) : (
          <Skeleton width="70%" />
        )}
      </section>
      ) : null}

      {sameFirm.length ? (
        <section aria-label={`Also at ${p.investor.firm}`} className="border-t border-line pt-14">
          <p className="t-label mb-6">
            Also at {p.investor.firm} <span className="font-mono normal-case">{num(sameFirm.length)}</span>
          </p>
          <ul className="m-0 grid list-none grid-cols-1 gap-x-24 p-0 min-[1180px]:grid-cols-2">
            {sameFirm.slice(0, 4).map((x) => (
              <li key={x.investor.id}>
                <button type="button" onClick={() => onGo(x.investor.id)} className={ROW_BTN}>
                  <span className="min-w-0 truncate font-medium">{x.investor.name}</span>
                  <span className="t-body-s min-w-0 flex-1 truncate text-muted">{x.investor.title ?? ""}</span>
                  <span className="t-body-s inline-flex shrink-0 items-center gap-6 text-muted">
                    <StageDot color={x.stage.color} />
                    {x.stage.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {sameFirm.length > 4 ? <p className="t-body-s text-muted">and {num(sameFirm.length - 4)} more</p> : null}
        </section>
      ) : null}
      <p className="sr-only">
        Open the full page at /w/{wsSlug}/investors/{p.investor.id}
      </p>
    </div>
  );
}

const ROW_BTN = "flex h-28 w-full min-w-0 items-center gap-8 border-0 bg-transparent px-0 text-left hover:text-accent";

function NextStepField({
  value,
  canWrite,
  focusReq,
  onSave,
}: {
  value: string;
  canWrite: boolean;
  focusReq: number;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const first = useRef(focusReq);
  useEffect(() => {
    if (focusReq !== first.current) ref.current?.focus();
  }, [focusReq]);
  const save = async () => {
    if (await onSave(text)) setSaved(true);
  };
  return (
    <section aria-label="Next step" className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-12">
      <label htmlFor="triage-next-step" className="t-label">
        Next step
      </label>
      <div className="relative flex items-center">
        <Input
          ref={ref}
          id="triage-next-step"
          value={text}
          disabled={!canWrite}
          maxLength={500}
          placeholder="e.g. Ask Harper for an intro"
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          className="w-full pr-60"
        />
        <span className="pointer-events-none absolute right-8 flex items-center gap-6">
          {saved ? <span className="t-micro text-good-ink">Saved</span> : null}
          <Kbd>N</Kbd>
        </span>
      </div>
    </section>
  );
}

function SelectionPane({
  rows,
  openLabel,
  onClear,
  onResearch,
}: {
  rows: Participant[];
  openLabel: string;
  onClear: () => void;
  onResearch?: (kind: "identity" | "dossier") => void;
}) {
  const fits = new Map<number, number>();
  for (const p of rows) fits.set(p.fit, (fits.get(p.fit) ?? 0) + 1);
  const fitKeys = [...fits.keys()].sort((a, b) => a - b);
  const fitText =
    fitKeys.length === 1 ? `${num(rows.length)} at fit ${fitKeys[0]}` : `fit ${fitKeys[0]}–${fitKeys[fitKeys.length - 1]}`;
  // The parts add up: the three largest types, then "and 19 more" for the rest (critique 2).
  // The table's words ("Corporate VC", not "CVC"; critique 4).
  const typeText = breakdown(rows.map((p) => (p.investor.type !== "other" ? INVESTOR_TYPE_LABEL[p.investor.type] : null)));
  const SHOW = 36;
  return (
    <div className="flex flex-col gap-12 px-32 py-24 max-xl:px-20">
      <h2 className="font-display text-[28px] leading-[1.1] font-bold tracking-[-0.02em]">{num(rows.length)} selected</h2>
      <p className="text-lg text-muted">{[fitText, typeText].filter(Boolean).join(" · ")}</p>
      <p className="t-body-s text-muted">
        One key moves all of them in one go, with Undo. They are all still {openLabel} until you pick a stage below.{" "}
        <button type="button" className="link border-0 bg-transparent p-0" onClick={onClear}>
          Clear selection
        </button>{" "}
        <Kbd>Esc</Kbd>
      </p>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-24 border-t border-line p-0 pt-8 min-[1180px]:grid-cols-2">
        {rows.slice(0, SHOW).map((p) => (
          <li key={p.investor.id} className="flex h-26 min-w-0 items-baseline gap-8">
            <span className="shrink-0 truncate font-medium">{p.investor.name}</span>
            <span className="t-body-s min-w-0 truncate text-muted">{p.investor.firm ?? ""}</span>
          </li>
        ))}
      </ul>
      {rows.length > SHOW ? <p className="t-body-s text-muted">and {num(rows.length - SHOW)} more</p> : null}
      {onResearch ? (
        <p className="flex flex-wrap items-center gap-8 border-t border-line pt-10">
          <span className="t-label mr-4">Research</span>
          <Button size="sm" onClick={() => onResearch("identity")}>
            Match identities
          </Button>
          <Button size="sm" onClick={() => onResearch("dossier")}>
            Research selected
          </Button>
          <span className="t-body-s text-muted">See the cost before anything runs.</span>
        </p>
      ) : null}
    </div>
  );
}

/* ---------- decision panel ---------- */

function DecisionPanel({
  ref,
  who,
  bulk,
  targets,
  counts,
  currentStage,
  followUp,
  follows,
  today,
  timeZone,
  disabled,
  focusKey,
  pickRef,
  fileOpen,
  notice,
  onDismissNotice,
  drafted,
  contacted,
  confirm,
  onCancelConfirm,
  onTrust,
  onDecide,
  onFollow,
  research,
}: {
  ref?: Ref<HTMLDivElement>;
  /** The investor's research (Brief, "Is this them?", Research), fixed height. */
  research?: ReactNode;
  who: string | null;
  /** How many are selected (0: one investor). */
  bulk: number;
  targets: TriageTarget[];
  /** Investors per stage now (a quiet count on each button: where everyone went). */
  counts: Record<string, number>;
  currentStage: string | null;
  followUp: string | null;
  follows: FollowOption[];
  today: string;
  timeZone: string;
  disabled: boolean;
  focusKey: string;
  pickRef: React.RefObject<HTMLDivElement | null>;
  /** The file is open beside the queue (fewer key hints: the sheet's keys win). */
  fileOpen: boolean;
  /** The last change, with Undo (desktop says it here instead of a toast). */
  notice: { id: number; text: string; undo?: () => void; extra?: { label: string; onClick: () => void } } | null;
  onDismissNotice: () => void;
  /** "Draft intro email" was clicked for this investor: point at Contacted. */
  drafted: boolean;
  /** The first talking stage and its key ("2", Contacted). */
  contacted: { key: string; label: string } | null;
  /** A move to a talking stage waiting for its second press. */
  confirm: { to: Stage; n: number; key: string | null; shortlist: TriageTarget | null } | null;
  onCancelConfirm: () => void;
  /** "Don't ask again this session": file now and stop asking. */
  onTrust: () => void;
  onDecide: (s: Stage) => void;
  onFollow: (iso: string | null) => void;
}) {
  const primary = targets.filter((t) => t.primary);
  const secondary = targets.filter((t) => !t.primary && t.key);
  const overflow = targets.filter((t) => !t.key);
  const firstBtn = useRef<HTMLButtonElement>(null);
  // No stage is preselected (critique 2: a ring on Researching read as the suggested answer).
  // Once someone Tabs into the panel, each new investor puts focus back on the first button.
  const keyboardUser = useRef(false);
  useEffect(() => {
    if (!keyboardUser.current) return;
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.closest("[role=dialog]"))) return;
    firstBtn.current?.focus({ preventScroll: true });
  }, [focusKey]);
  const btn = (t: TriageTarget, big: boolean, i: number) => {
    const asking = confirm?.to.key === t.stage.key;
    const meaning = big ? (TRIAGE_MEANING[t.stage.key] ?? null) : null;
    const n = counts[t.stage.key] ?? 0;
    return (
      <button
        key={t.stage.key}
        ref={big && i === 0 ? firstBtn : undefined}
        type="button"
        disabled={disabled}
        aria-keyshortcuts={t.key ?? undefined}
        aria-pressed={currentStage === t.stage.key || undefined}
        title={`${t.stage.label}${n ? ` (${num(n)} there now)` : ""}${t.key ? `, key ${t.key}` : ""}`}
        onClick={() => onDecide(t.stage)}
        className={cn(
          "flex min-w-0 items-center gap-8 rounded-sm border bg-surface text-left hover:border-accent disabled:opacity-55",
          asking
            ? "border-warm bg-warm-soft"
            : currentStage === t.stage.key || (drafted && t.key === contacted?.key)
              ? "border-fg"
              : "border-line",
          big ? cn("px-12 @[680px]/dp:px-14", meaning ? "h-44 @[680px]/dp:h-52" : "h-44") : "h-36 px-10 text-base",
        )}
      >
        <StageDot color={t.stage.color} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", big && "text-[15px] leading-[20px] font-medium")}>{t.stage.label}</span>
          {/* The meaning needs room; a narrow panel keeps the label whole instead. */}
          {meaning ? <span className="t-body-s hidden truncate leading-[16px] text-muted @[680px]/dp:block">{meaning}</span> : null}
        </span>
        {n ? <span className="hidden shrink-0 font-mono text-[11.5px] text-muted tnum @[560px]/dp:inline">{num(n)}</span> : null}
        {/* A narrow panel (the file open beside it) keeps every label whole: the secondary keys
            step aside there, and the hint line says "1–7". */}
        {t.key ? (
          big ? (
            <Kbd>{t.key}</Kbd>
          ) : (
            <span className="hidden @[560px]/dp:inline-flex">
              <Kbd>{t.key}</Kbd>
            </span>
          )
        ) : null}
      </button>
    );
  };
  // Follow-up picks: None + three different dates; one pressed button per value.
  const options = [{ label: "None", iso: null as string | null, hint: null as string | null }, ...follows.map((f) => ({ label: f.label, iso: f.iso as string | null, hint: `f ${f.kbd}` }))];
  const pressed = pressedOption(options, followUp);
  const sub = bulk
    ? `one key moves all ${num(bulk)}, with Undo`
    : drafted && contacted
      ? `Sent it? Press ${contacted.key} to file ${who ?? "them"} in ${contacted.label}.`
      : "one key, then the next investor opens";
  const smallBtn = "inline-flex h-28 shrink-0 items-center gap-6 rounded-sm border border-line bg-surface px-10 text-sm text-fg hover:border-muted";
  return (
    <div
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Tab") keyboardUser.current = true;
      }}
      className="@container/dp flex shrink-0 flex-col gap-10 border-t border-line bg-sunk px-20 pt-14 pb-12"
    >
      {research ? <div className="-mx-20 -mt-14 mb-2 border-b border-line bg-surface px-20 pt-10 pb-10">{research}</div> : null}
      {confirm ? (
        <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-10 gap-y-6 rounded-sm border border-warm bg-warm-soft px-12 py-8">
          <p className="t-body-s min-w-0 flex-1 text-warm-ink">
            <b className="font-semibold">
              {confirm.n === 1 ? `Has ${who ?? "this investor"} heard from you?` : `Have all ${num(confirm.n)} heard from you?`}
            </b>{" "}
            {confirm.to.label} means you reached out.
          </p>
          {confirm.shortlist ? (
            <button type="button" className={smallBtn} onClick={() => onDecide(confirm.shortlist!.stage)}>
              Shortlist in {confirm.shortlist.stage.label} {confirm.shortlist.key ? <Kbd>{confirm.shortlist.key}</Kbd> : null}
            </button>
          ) : null}
          <button type="button" className={smallBtn} onClick={() => onDecide(confirm.to)}>
            Yes, {confirm.to.label} {confirm.key ? <Kbd>{confirm.key}</Kbd> : null}
          </button>
          <button type="button" className="t-body-s border-0 bg-transparent p-0 text-warm-ink underline-offset-2 hover:underline" onClick={onTrust}>
            Yes, and don&apos;t ask again
          </button>
          <button type="button" className="sr-only" onClick={onCancelConfirm}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex min-h-20 min-w-0 items-baseline gap-10">
          <span className="t-label shrink-0">{who ? `Where does ${who} go?` : `Where do the ${num(bulk)} go?`}</span>
          {notice ? (
            // The last change, where the eye already is: beside the buttons it answers.
            <span key={notice.id} className="anim-fade t-body-s ml-auto inline-flex min-w-0 items-baseline gap-8" role="status">
              <span aria-hidden className="text-good-ink">
                ✓
              </span>
              <span className="min-w-0 truncate text-fg">{notice.text}</span>
              {notice.extra ? (
                <button
                  type="button"
                  className="link shrink-0 border-0 bg-transparent p-0 whitespace-nowrap"
                  onClick={() => {
                    notice.extra!.onClick();
                    onDismissNotice();
                  }}
                >
                  {notice.extra.label}
                </button>
              ) : null}
              {notice.undo ? (
                <button
                  type="button"
                  className="link inline-flex shrink-0 items-center gap-4 border-0 bg-transparent p-0"
                  onClick={() => {
                    notice.undo!();
                    onDismissNotice();
                  }}
                >
                  Undo <Kbd>U</Kbd>
                </button>
              ) : null}
            </span>
          ) : (
            <span className={cn("t-micro min-w-0 truncate", drafted ? "text-accent" : "text-muted", !bulk && !(drafted && contacted) && "touch:hidden")}>{sub}</span>
          )}
        </div>
      )}
      <div className="grid grid-cols-3 gap-8">{primary.map((t, i) => btn(t, true, i))}</div>
      {secondary.length || overflow.length ? (
        <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(104px, 1fr))` }}>
          {secondary.map((t, i) => btn(t, false, i))}
          {overflow.length ? (
            <Menu
              label="Other stage"
              trigger="Other stage…"
              triggerClassName="h-36 w-full rounded-sm border border-line bg-surface px-10 text-left hover:border-accent"
              items={overflow.map((t) => ({ label: t.stage.label, icon: <StageDot color={t.stage.color} />, onSelect: () => onDecide(t.stage) }))}
            />
          ) : null}
        </div>
      ) : null}
      {/* One line at every width: the chord hints step aside before anything wraps. */}
      <div className="flex min-w-0 items-center gap-4 @[640px]/dp:gap-6" ref={pickRef}>
        <span className="t-label mr-4 shrink-0 @[640px]/dp:mr-6">Follow up</span>
        {options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            disabled={disabled}
            aria-pressed={i === pressed}
            onClick={() => onFollow(o.iso)}
            className={cn(
              "inline-flex h-32 shrink-0 items-center gap-4 rounded-sm border px-8 text-base whitespace-nowrap disabled:opacity-55 @[640px]/dp:gap-6 @[640px]/dp:px-10",
              i === pressed ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:border-muted",
            )}
            title={o.iso ? `${formatDate(o.iso, today)}${o.hint ? ` (${o.hint})` : ""}` : "No follow-up"}
          >
            {o.label}
            {o.hint ? (
              <span className="hidden @[700px]/dp:inline-flex">
                <Kbd>{o.hint}</Kbd>
              </span>
            ) : null}
          </button>
        ))}
        <DateField
          value={followUp && pressed < 0 ? followUp : null}
          onChange={(v) => onFollow(v)}
          timeZone={timeZone}
          quickPicks="followup"
          placeholder="Pick…"
          placeholderTone="muted"
          tone="toolbar"
          disabled={disabled}
          aria-label="Follow up on a date"
          className="w-auto shrink-0"
        />
      </div>
      {/* The key legend means nothing without a keyboard. */}
      <p className="t-micro flex flex-wrap items-center gap-x-12 gap-y-4 text-muted touch:hidden">
        {(
          (bulk
            ? [
                // A selection has its own keys (critique 4: it listed Skip, Fit and LinkedIn).
                [`1–${Math.min(9, targets.filter((t) => t.key).length)}`, `Move all ${num(bulk)}`],
                ["F", "Follow-up with the move"],
                ["X", "Add or drop the row"],
                ["Esc", "Clear the selection"],
              ]
            : fileOpen
            ? [
                [`1–${Math.min(9, targets.filter((t) => t.key).length)}`, "File"],
                ["S", "Skip"],
                ["U", "Undo"],
                ["Esc", "Close the file"],
              ]
            : [
                ["S", "Skip"],
                ["U", "Undo"],
                ["[ ]", "Fit"],
                ["X", "Select"],
                ["↵", "Open file"],
                ["L", "LinkedIn"],
              ]) as [string, string][]
        ).map(([k, l]) => (
          <span key={l} className="inline-flex items-center gap-4">
            <Kbd>{k}</Kbd>
            {l}
          </span>
        ))}
        {bulk ? null : <span className="ml-auto hidden @[720px]/dp:inline">Every change saves at once.</span>}
      </p>
    </div>
  );
}

/* ---------- phone takeover (DECISION §7.2) ---------- */

function TriagePhone({
  round,
  current,
  full,
  extras,
  today,
  timeZone,
  targets,
  slice,
  openLabel,
  inSlice: inSliceN,
  sorted,
  total,
  upNext,
  sameFirm,
  doneState,
  canWrite,
  draftHref: draft,
  filter,
  onExit,
  confirm,
  onTrust,
  onDecide,
  onSkip,
  onGo,
  onFollow,
  onSaveNextStep,
  onDrafted,
  research,
}: {
  /** The investor's research block (the Brief, "Is this them?" or Research). */
  research?: ReactNode;
  round: Round;
  current: Participant | null;
  full: FullInvestor | undefined;
  extras: Record<string, { industries: string[]; source?: string }>;
  today: string;
  timeZone: string;
  targets: TriageTarget[];
  slice: TriageSlice;
  openLabel: string;
  /** Still New in this slice (skipped ones included), as on desktop. */
  inSlice: number;
  sorted: number;
  total: number;
  upNext: Participant[];
  sameFirm: Participant[];
  doneState: ReactNode;
  canWrite: boolean;
  draftHref: string | null;
  filter: ReactNode;
  onExit: () => void;
  /** A tap on a talking stage waiting for "Yes" (see the desktop decision panel). */
  confirm: { to: Stage; shortlist: TriageTarget | null } | null;
  onTrust: () => void;
  onDecide: (s: Stage) => void;
  onSkip: () => void;
  onGo: (id: string) => void;
  onFollow: (iso: string | null) => void;
  onSaveNextStep: (text: string) => Promise<boolean>;
  onDrafted: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [stepOpen, setStepOpen] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  // Over the follow-up sheet the toast sits at the bottom, not where the hidden bar is.
  useToastLift(bar, !followOpen);
  const primary = targets.filter((t) => t.primary);
  const inv = full?.investor;
  const industries = visibleIndustries(inv?.industries ?? (current ? extras[current.investor.id]?.industries : []) ?? []);
  const p = current;
  const type = p && p.investor.type !== "other" ? INVESTOR_TYPE_LABEL[p.investor.type] : null;
  const facts: [string, string][] = inv
    ? ([
        ["Check size", checkSize(inv, round.currency)],
        ["Invests at", inv.stage_focus.map(stageFocusLabel).join(", ")],
        ["Location", inv.location ?? ""],
      ] as [string, string][]).filter(([, v]) => v)
    : [];
  useEffect(() => setStepOpen(Boolean(p?.next_step)), [p?.investor.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const otherItems: MenuEntry[] = targets.map((t) => ({ label: t.stage.label, icon: <StageDot color={t.stage.color} />, onSelect: () => onDecide(t.stage) }));
  // Four different dates (on a Monday "Next Monday" is "In 1 week": it shows once; critique 3).
  const picks = quickPicks("followup", today);
  const phonePicks = (() => {
    const out = followOptions(picks).map((o) => ({ label: o.label === "Next Mon" ? "Next Monday" : o.label, iso: o.iso }));
    const two = picks.find((x) => x.kbd === "2");
    if (two && !out.some((o) => o.iso === two.iso)) out.push({ label: "In 2 weeks", iso: two.iso });
    return out;
  })();
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas" role="region" aria-label="Triage">
      <header className="flex h-56 shrink-0 items-center gap-8 border-b border-line bg-surface px-8 pt-[env(safe-area-inset-top)] short:h-48">
        <button type="button" onClick={onExit} aria-label="Back to the list" className="inline-flex size-44 items-center justify-center rounded-sm border-0 bg-transparent text-lg">
          ✕
        </button>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="font-semibold">
            Triage{" "}
            <span className="font-mono text-[12px] font-normal text-muted">
              {num(inSliceN)} in {openLabel}
              {slice !== "all" ? ` · ${SLICE_LABEL[slice]}` : ""}
            </span>
          </span>
          <span className="t-micro truncate text-muted">
            {num(sorted)} of {num(total)} sorted
          </span>
        </span>
        {filter}
      </header>
      <div
        className="h-4 shrink-0 bg-sunk"
        role="meter"
        aria-label="Sorted"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={sorted}
      >
        {sorted > 0 ? <i className="block h-full min-w-4 bg-good not-italic" style={{ width: `${total ? (sorted / total) * 100 : 0}%` }} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-16 pt-14 pb-[calc(170px+env(safe-area-inset-bottom))] short:px-[max(16px,env(safe-area-inset-left))] short:pb-[calc(72px+env(safe-area-inset-bottom))]">
        {doneState ??
          (p ? (
            <>
              <article className="rounded-md border border-line bg-surface p-16">
                <div className="flex flex-wrap items-center gap-6">
                  <span className="t-label">Fit</span>
                  <FitMeter value={p.fit} />
                  <span className="t-body-s ml-auto inline-flex items-center gap-6 text-muted">
                    <StageDot color={p.stage.color} />
                    {p.stage.label}
                  </span>
                </div>
                <h2 className="mt-10 font-display text-[24px] leading-[1.1] font-bold">{p.investor.name}</h2>
                {[p.investor.title, p.investor.firm].filter(Boolean).length ? (
                  <p className="mt-2 text-muted">{[p.investor.title, p.investor.firm].filter(Boolean).join(" · ")}</p>
                ) : null}
                {type || industries.length ? (
                  <div className="mt-10 flex flex-wrap gap-6">
                    {type ? <Chip tone="type">{type}</Chip> : null}
                    {industries.slice(0, 3).map((i) => (
                      <Chip key={i} tone="type">
                        {i}
                      </Chip>
                    ))}
                  </div>
                ) : null}
                {facts.length ? (
                  <dl className="m-0 mt-12 grid grid-cols-[100px_minmax(0,1fr)] gap-y-6">
                    {facts.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="t-body-s text-muted">{k}</dt>
                        <dd className="m-0">{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {inv ? (
                  <div className="mt-12">
                    <ReachOut person={reachPerson(p, inv)} draft={draft} onDrafted={onDrafted} big fromResearch={inv.research?.from_research} />
                  </div>
                ) : (
                  <Skeleton className="mt-12" width="60%" />
                )}
                {inv && !facts.length && !inv.notes ? (
                  <p className="t-body-s mt-10 text-muted">Only the basics so far.</p>
                ) : null}
              </article>
              {research ? <div className="mt-12 rounded-md border border-line bg-surface px-16 py-12">{research}</div> : null}
              <div className="mt-12">
                {stepOpen ? (
                  <NextStepField key={p.investor.id} value={p.next_step ?? ""} canWrite={canWrite} focusReq={0} onSave={onSaveNextStep} />
                ) : (
                  <button type="button" onClick={() => setStepOpen(true)} className="link border-0 bg-transparent p-0" disabled={!canWrite}>
                    + Next step
                  </button>
                )}
              </div>
              {sameFirm.length ? (
                <section className="mt-18">
                  <p className="t-label mb-2">
                    Also at {p.investor.firm} <span className="font-mono normal-case">{num(sameFirm.length)}</span>
                  </p>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {sameFirm.slice(0, 3).map((x) => (
                      <li key={x.investor.id}>
                        <button type="button" onClick={() => onGo(x.investor.id)} className="flex h-44 w-full min-w-0 items-center gap-8 border-0 bg-transparent px-0 text-left">
                          <span className="min-w-0 flex-1 truncate font-medium">{x.investor.name}</span>
                          <span className="t-body-s inline-flex shrink-0 items-center gap-6 text-muted">
                            <StageDot color={x.stage.color} />
                            {x.stage.label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {upNext.length ? (
                <section className="mt-18">
                  <p className="t-label mb-2">Up next</p>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {upNext.map((x) => (
                      <li key={x.investor.id}>
                        <button type="button" onClick={() => onGo(x.investor.id)} className="flex h-44 w-full min-w-0 items-center gap-8 border-0 border-b border-line bg-transparent px-0 text-left">
                          <span className="shrink-0 font-medium">{x.investor.name}</span>
                          <span className="t-body-s min-w-0 flex-1 truncate text-muted">{x.investor.firm}</span>
                          {new Set([p.fit, ...upNext.map((y) => y.fit)]).size > 1 ? <FitMeter value={x.fit} /> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null)}
      </div>
      {doneState ? null : (
        <div
          ref={bar}
          className="fixed inset-x-0 bottom-0 z-[41] flex flex-col gap-8 border-t border-line bg-surface px-12 pt-10 pb-[calc(10px+env(safe-area-inset-bottom))] short:pt-6 short:pb-[calc(6px+env(safe-area-inset-bottom))] short:pl-[max(12px,env(safe-area-inset-left))] short:pr-[max(12px,env(safe-area-inset-right))]"
        >
          {confirm && p ? (
            <div role="alert" className="flex flex-col gap-8 rounded-sm border border-warm bg-warm-soft p-10">
              <p className="t-body-s text-warm-ink">
                <b className="font-semibold">Has {p.investor.name.split(/\s+/)[0]} heard from you?</b> {confirm.to.label} means you already
                reached out.
              </p>
              <div className="grid grid-cols-2 gap-8">
                {confirm.shortlist ? (
                  <Button onClick={() => onDecide(confirm.shortlist!.stage)}>Shortlist</Button>
                ) : null}
                <Button onClick={() => onDecide(confirm.to)}>Yes, {confirm.to.label}</Button>
              </div>
              <button type="button" className="t-body-s self-start border-0 bg-transparent p-0 text-warm-ink underline" onClick={onTrust}>
                Yes, and don&apos;t ask again
              </button>
            </div>
          ) : null}
          {/* Portrait: the three stages over Skip, Follow up and Other stage. On its side
              (under 500px tall) the six sit in one row, so the investor keeps the screen. */}
          <div className="grid grid-cols-3 gap-8 short:grid-cols-6 short:gap-6">
            {primary.map((t) => (
              <button
                key={t.stage.key}
                type="button"
                disabled={!canWrite || !p}
                onClick={() => onDecide(t.stage)}
                className="flex h-48 min-w-0 items-center justify-center gap-6 rounded-sm border border-line bg-surface px-8 font-medium disabled:opacity-55 short:h-44"
              >
                <StageDot color={t.stage.color} />
                <span className="truncate">{t.stage.label}</span>
              </button>
            ))}
            <button type="button" onClick={onSkip} disabled={!p} className="h-44 rounded-sm border-0 bg-transparent text-muted hover:bg-sunk">
              Skip
            </button>
            <button type="button" onClick={() => setFollowOpen(true)} disabled={!p || !canWrite} className="h-44 rounded-sm border-0 bg-transparent text-muted hover:bg-sunk">
              Follow up
            </button>
            <Menu
              label="Other stage"
              align="end"
              trigger="Other stage"
              triggerClassName="h-44 w-full rounded-sm border-0 bg-transparent whitespace-nowrap text-muted hover:bg-sunk"
              className="w-full"
              items={otherItems}
            />
          </div>
          <p className="t-body-s text-center text-muted short:hidden">Each tap saves, opens the next investor and offers Undo.</p>
        </div>
      )}
      <Sheet open={followOpen} onClose={() => setFollowOpen(false)} bottomOnPhone title={p ? `Follow up with ${firstName(p.investor.name)}` : "Follow up"}>
        <div className="flex flex-col gap-8">
          {p?.follow_up_on ? (
            <p className="t-body-s text-muted">Now: {formatDate(p.follow_up_on, today)}.</p>
          ) : null}
          {phonePicks.map((x) => (
            <Button
              key={x.iso}
              size="lg"
              aria-pressed={p?.follow_up_on === x.iso || undefined}
              onClick={() => {
                onFollow(x.iso);
                setFollowOpen(false);
              }}
            >
              {x.label} · {formatDate(x.iso, today)}
            </Button>
          ))}
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              onFollow(null);
              setFollowOpen(false);
            }}
          >
            No follow-up
          </Button>
          <p className="t-body-s text-muted">Dates are in the workspace time zone ({timeZone}).</p>
        </div>
      </Sheet>
    </div>
  );
}

