"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Button,
  Chip,
  DateField,
  EmptyState,
  FitMeter,
  Input,
  Kbd,
  LinkButtons,
  Menu,
  PriorityChip,
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
import { listActivities } from "@/lib/api/activities";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { listImports, type ImportRun } from "@/lib/api/data";
import { getInvestor } from "@/lib/api/investors";
import {
  bulkUpdateParticipants,
  moveStage,
  setFollowUp,
  updateParticipant,
  type BulkInput,
  type BulkItem,
} from "@/lib/api/rounds";
import type { Activity, Investor, Participant, Priority, Round, Stage } from "@/lib/api/types";
import { INSTRUMENT_LABEL, INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { quickPicks } from "@/lib/dates";
import { followUpState, formatDate, isoDate, money, moneyCompact, num, priorityFromFit, stageFocusLabel } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import {
  formatDuration,
  formatElapsed,
  GROUP_LABEL,
  inSlice,
  nextCursor,
  paceEstimate,
  PRIORITY_ORDER,
  shortType,
  SLICE_LABEL,
  START_SECONDS,
  triageTargets,
  visibleIndustries,
  type TriageSlice,
  type TriageTarget,
} from "@/lib/pipeline";

import { checkSize } from "./InvestorSheet";
import { useMediaQuery } from "./util";

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

interface Decision {
  ids: string[];
  snaps: Snapshot[];
  to: string;
  at: number;
}

interface FullInvestor {
  investor?: Investor;
  acts?: Activity[];
  error?: string;
}

const LRU = 10;
const ROW_H = 38;
const GROUP_H = 32;
const FOLLOW_KEYS = [
  { kbd: "1", label: "Tomorrow" },
  { kbd: "m", label: "Next Mon" },
  { kbd: "7", label: "In 1 week" },
];

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
}: {
  round: Round;
  stages: Stage[];
  rows: Participant[];
  /** The page filters minus stage (search, type, industry…). */
  matches: (p: Participant) => boolean;
  extras: Record<string, { industries: string[] }>;
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
}) {
  const toast = useToast();
  const phone = useMediaQuery("(max-width: 639px)") === true;
  const wide = useMediaQuery("(min-width: 1024px)") !== false;
  const railOn = useMediaQuery("(min-width: 1280px)") !== false;
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
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [times, setTimes] = useState<number[]>([]);
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

  const sliceRows = useMemo(() => queue.filter((p) => inSlice(fitAtSeen(p), slice)), [queue, slice]);
  const order = useMemo(() => sliceRows.map((p) => p.investor.id), [sliceRows]);
  const rowById = useMemo(() => new Map(queue.map((p) => [p.investor.id, p])), [queue]);
  const done = useCallback(
    (id: string) => {
      const p = rowById.get(id);
      return !p || !isOpen(p) || skipped.has(id);
    },
    [rowById, isOpen, skipped],
  );
  const undecided = (list: Participant[]) => list.filter((p) => isOpen(p)).length;
  const sliceCount = (s: TriageSlice) => queue.filter((p) => isOpen(p) && inSlice(fitAtSeen(p), s)).length;
  const openCount = allRows.filter((p) => p.stage.key === openKey).length;
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
  // The snapshot Undo restores: what the investor looked like when their turn began.
  if (current && !turnSnap.current.has(current.investor.id)) turnSnap.current.set(current.investor.id, snap(current));

  const go = (id: string | null) => onCursor(id);
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
    listImports(client)
      .then((r) => live && setRuns(r.data))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [client]);

  /* ---------- writes ---------- */
  const [nextStepFocus, setNextStepFocus] = useState(0);
  const [followPick, setFollowPick] = useState<string | null | undefined>(undefined);

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
      setDecided((m) => {
        const n = new Map(m);
        for (const id of entry.ids) n.delete(id);
        return n;
      });
      setCounts((c) => ({ ...c, [entry.to]: Math.max(0, (c[entry.to] ?? 0) - entry.ids.length) }));
      setTimes((t) => t.slice(0, Math.max(0, t.length - 1)));
      go(entry.ids[0]!);
      try {
        const r = await bulkUpdateParticipants(client, round.id, { op: "restore", items });
        store.commit(r.participants);
        for (const id of entry.ids) refreshFull(id);
        const msg = entry.ids.length === 1 ? `${entry.snaps[0]!.name} is back in ${openStage.label}.` : `${num(entry.ids.length)} investors are back in ${openStage.label}.`;
        store.announce(msg);
        toast.show(msg);
        store.afterWrite();
      } catch (err) {
        store.rollback(prev);
        toast.show(`Couldn't undo. ${errorMessage(err)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowById, byKey, client, round.id, store, toast, today, openStage.label],
  );

  const decideOne = async (p: Participant, to: Stage) => {
    if (!canWrite || p.stage.key === to.key) {
      if (p.stage.key === to.key) go(advanceFrom(p.investor.id));
      return;
    }
    const id = p.investor.id;
    const snapshot = turnSnap.current.get(id) ?? snap(p);
    const entry: Decision = { ids: [id], snaps: [snapshot], to: to.key, at: Date.now() };
    const prev = p;
    store.apply([id], (x) => ({ ...x, stage: to }));
    setDecided((m) => new Map(m).set(id, to.key));
    setCounts((c) => ({ ...c, [to.key]: (c[to.key] ?? 0) + 1 }));
    setTimes((t) => [...t, entry.at]);
    undoStack.current = [...undoStack.current.slice(-19), entry];
    go(advanceFrom(id, new Set([id])));
    try {
      const res = await moveStage(client, round.id, id, to.key);
      store.commit([res.participant]);
      refreshFull(id);
      const msg = `${p.investor.name} moved to ${to.label}.`;
      store.announce(msg);
      toast.show(msg, { label: "Undo", onClick: () => void undo(entry) });
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
      setTimes((t) => t.slice(0, -1));
      go(id);
      const code = (err as { code?: string }).code;
      toast.show(`Couldn't move ${p.investor.name}.${code ? ` ${code}` : ""}`, { label: "Retry", onClick: () => void decideOne(prev, to) });
    }
  };

  const decideMany = async (ids: string[], to: Stage) => {
    const rows = ids.map((id) => rowById.get(id)).filter(Boolean) as Participant[];
    if (!rows.length || !canWrite) return;
    const entry: Decision = { ids: rows.map((p) => p.investor.id), snaps: rows.map(snap), to: to.key, at: Date.now() };
    const set = new Set(entry.ids);
    store.apply(entry.ids, (x) => ({ ...x, stage: to }));
    setDecided((m) => {
      const n = new Map(m);
      for (const id of entry.ids) n.set(id, to.key);
      return n;
    });
    setCounts((c) => ({ ...c, [to.key]: (c[to.key] ?? 0) + entry.ids.length }));
    setTimes((t) => [...t, entry.at]);
    setSelected(new Set());
    undoStack.current = [...undoStack.current.slice(-19), entry];
    go(advanceFrom(cursor ?? entry.ids[0]!, set));
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
      toast.show(msg, { label: "Undo", onClick: () => void undo(entry) });
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
      setTimes((t) => t.slice(0, -1));
      toast.show(`Nothing was moved. ${errorMessage(err)}`);
    }
  };

  const decide = (to: Stage) => {
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
      toast.show(iso ? `Follow-up ${formatDate(iso, today)} goes with the next move.` : "No follow-up with the next move.");
      return;
    }
    if (!current || !canWrite) return;
    const p = current;
    if ((p.follow_up_on ?? null) === iso) return;
    store.apply([p.investor.id], (x) => ({ ...x, follow_up_on: iso, follow_up_state: followUpState(iso, today) }));
    try {
      const r = await setFollowUp(client, round.id, p.investor.id, iso ? { on: iso } : { clear: true });
      store.commit([r.participant]);
      const msg = iso ? `Follow up with ${p.investor.name} ${formatDate(iso, today)}.` : `Follow-up cleared for ${p.investor.name}.`;
      store.announce(msg);
      toast.show(msg);
      store.afterWrite();
    } catch (err) {
      store.rollback([p]);
      toast.show(`Couldn't set the follow-up. ${errorMessage(err)}`);
    }
  };

  const changeFit = async (delta: number) => {
    if (!current || !canWrite) return;
    const p = current;
    const fit = Math.max(0, Math.min(5, p.fit + delta));
    if (fit === p.fit) return;
    store.apply([p.investor.id], (x) => ({ ...x, fit, priority: priorityFromFit(fit) }));
    try {
      const r = await updateParticipant(client, round.id, p.investor.id, { fit });
      store.commit([r]);
      store.announce(`Fit ${fit} of 5 for ${p.investor.name}.`);
    } catch (err) {
      store.rollback([p]);
      toast.show(`Couldn't change the fit. ${errorMessage(err)}`);
    }
  };

  const saveNextStep = async (text: string): Promise<boolean> => {
    if (!current || !canWrite) return false;
    const p = current;
    const value = text.trim() || null;
    if ((p.next_step ?? null) === value) return false;
    store.apply([p.investor.id], (x) => ({ ...x, next_step: value }));
    try {
      const r = await updateParticipant(client, round.id, p.investor.id, { next_step: value });
      store.commit([r]);
      return true;
    } catch (err) {
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

  const step = (dir: 1 | -1, extend = false) => {
    if (!order.length) return;
    const i = cursor ? order.indexOf(cursor) : -1;
    const j = Math.max(0, Math.min(order.length - 1, i + dir));
    if (extend && cursor) selectIds([cursor, order[j]!]);
    go(order[j]!);
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
  const hk = { blockedByModals: true, group: "Triage" } as const;
  for (let i = 0; i < 9; i++) {
    const t = targets[i];
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useHotkey(String(i + 1), () => t && decide(t.stage), {
      ...hk,
      enabled: on && Boolean(t),
      description: i === 0 ? "File in a stage (1–9), then the next investor" : undefined,
    });
  }
  useHotkey("s", skip, { ...hk, enabled: on, description: "Skip for now" });
  useHotkey("u", () => void undo(), { ...hk, enabled: on, description: "Undo the last decision" });
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
  useHotkey("escape", () => setSelected(new Set()), { ...hk, enabled: selected.size > 0 });
  const picks = quickPicks("followup", today);
  const pickIso = (k: string) => picks.find((p) => p.kbd === k)?.iso ?? null;
  useHotkey("f 1", () => void setFollow(pickIso("1")), { ...hk, enabled: on, description: "Follow up tomorrow" });
  useHotkey("f m", () => void setFollow(pickIso("m")), { ...hk, enabled: on, description: "Follow up next Monday" });
  useHotkey("f 7", () => void setFollow(pickIso("7")), { ...hk, enabled: on, description: "Follow up in 1 week" });
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

  const pos = cursor ? order.indexOf(cursor) : -1;
  const sliceLeft = undecided(sliceRows);
  const sliceSkipped = sliceRows.filter((p) => isOpen(p) && skipped.has(p.investor.id)).length;

  const pace = paceEstimate(times);
  const hwLeft = sliceCount("hw");
  const fit0 = queue.filter((p) => isOpen(p) && fitAtSeen(p) === 0 && !skipped.has(p.investor.id)).map((p) => p.investor.id);
  const sessionLine = (() => {
    const n = Object.values(counts).reduce((x, y) => x + y, 0);
    if (!times.length || !n) return null;
    const head = `${num(n)} sorted in ${formatElapsed(Date.now() - sessionStart.current)}.`;
    if (!pace.perMs) return head;
    const rest = openCount ? ` At this pace the rest of ${openStage.label} takes about ${formatDuration(openCount * pace.perMs)}.` : "";
    const hw = hwLeft ? ` The ${num(hwLeft)} left at Hot + Warm take about ${formatDuration(hwLeft * pace.perMs)}.` : "";
    return head + rest + hw;
  })();

  const sel = selected.size ? queue.filter((p) => selected.has(p.investor.id)) : [];

  const decisionPanel = (
    <DecisionPanel
      who={sel.length ? null : current ? firstName(current.investor.name) : null}
      targets={targets}
      currentStage={sel.length ? null : (current?.stage.key ?? null)}
      followUp={sel.length ? (followPick ?? null) : (current?.follow_up_on ?? null)}
      today={today}
      timeZone={timeZone}
      disabled={!canWrite || (!current && !sel.length)}
      focusKey={sel.length ? "sel" : (cursor ?? "")}
      pickRef={pickRef}
      phone={false}
      onDecide={decide}
      onFollow={(iso) => void setFollow(iso)}
    />
  );

  const pane = sel.length ? (
    <SelectionPane rows={sel} openLabel={openStage.label} onClear={() => setSelected(new Set())} />
  ) : current ? (
    <InvestorPane
      key={current.investor.id}
      p={current}
      full={full}
      runs={runs}
      round={round}
      wsSlug={wsSlug}
      today={today}
      timeZone={timeZone}
      industries={extras[current.investor.id]?.industries ?? []}
      canWrite={canWrite}
      nextStepFocus={nextStepFocus}
      onSaveNextStep={saveNextStep}
      decidedStage={!isOpen(current) ? current.stage : null}
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
    ) : sliceSkipped > 0 && sliceLeft === sliceSkipped ? (
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
      all={queue}
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
      sessionLine={!railOn && wide ? sessionLine : null}
      fit0={fit0}
      canWrite={canWrite}
      filter={<FilterMenu fields={filterFields} active={filterActive} onChange={onFilterChange} />}
      active={active}
      onSlice={onSlice}
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
      onSelectIds={selectIds}
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
        pos={pos}
        count={order.length}
        sorted={sorted}
        total={total}
        upNext={(() => {
          const out: Participant[] = [];
          let from = cursor;
          const seenIds = new Set<string>();
          while (out.length < 3) {
            const id = from ? nextCursor(order, from, (x) => x === cursor || seenIds.has(x) || done(x)) : null;
            if (!id) break;
            seenIds.add(id);
            out.push(rowById.get(id)!);
            from = id;
          }
          return out;
        })()}
        doneState={doneState}
        canWrite={canWrite}
        filter={<FilterMenu fields={filterFields} active={filterActive} onChange={onFilterChange} />}
        onExit={onExit}
        onDecide={decide}
        onSkip={skip}
        onFollow={(iso) => void setFollow(iso)}
        onSaveNextStep={saveNextStep}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "grid min-h-0 gap-16",
        wide ? (railOn ? "grid-cols-[360px_minmax(0,1fr)_280px]" : "grid-cols-[320px_minmax(0,1fr)]") : "grid-cols-1",
      )}
      style={{ height: height ?? "calc(100vh - 200px)" }}
    >
      {wide ? queuePanel : null}
      <section
        aria-label={current ? `Triage: ${current.investor.name}` : "Triage"}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface"
      >
        <header className="flex h-44 shrink-0 items-center gap-8 border-b border-line px-16">
          {!wide ? (
            <Button size="sm" onClick={() => setQueueOpen(true)}>
              Queue <span className="font-mono text-[11.5px] text-muted">{num(sliceLeft)}</span>
            </Button>
          ) : null}
          <span className="t-micro min-w-0 truncate text-muted" aria-live="polite">
            {sel.length
              ? `${num(sel.length)} selected`
              : pos >= 0
                ? `${num(pos + 1)} of ${num(order.length)} in ${openStage.label}${slice === "all" ? "" : ` · ${SLICE_LABEL[slice]}`} · highest fit first`
                : `${num(openCount)} in ${openStage.label}`}
          </span>
          <span className="flex items-center gap-4">
            <button type="button" className={NAV} onClick={() => step(-1)} aria-label="Previous investor" title="Previous (K)">
              ↑
            </button>
            <button type="button" className={NAV} onClick={() => step(1)} aria-label="Next investor" title="Next (J)">
              ↓
            </button>
          </span>
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
        {!railOn && wide ? <WhereStrip stages={stages} rows={allRows} counts={counts} /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{doneState ?? pane}</div>
        {doneState ? null : decisionPanel}
      </section>
      {railOn && wide ? (
        <TriageRail
          round={round}
          stages={stages}
          targets={targets}
          rows={allRows}
          counts={counts}
          openKey={openKey}
          today={today}
          sessionLine={sessionLine}
          hwLeft={hwLeft}
          sliceCounts={{ hw: hwLeft, maybe: sliceCount("maybe"), low: sliceCount("low") }}
          canMove={canWrite && Boolean(current || sel.length)}
          onDecide={decide}
        />
      ) : null}
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

type QRow = { kind: "group"; priority: Priority; left: number; ids: string[] } | { kind: "row"; p: Participant };

function TriageQueue({
  rows,
  all,
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
  onSlice,
  onPick,
  onToggle,
  onSelectIds,
  height,
}: {
  rows: Participant[];
  all: Participant[];
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
  onSlice: (s: TriageSlice) => void;
  onPick: (id: string, e?: { shiftKey: boolean }) => void;
  onToggle: (id: string) => void;
  onSelectIds: (ids: string[]) => void;
  height: number | null;
}) {
  void all;
  const body = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const by: Record<Priority, Participant[]> = { hot: [], warm: [], maybe: [], low: [] };
    for (const p of rows) by[priorityFromFit(fitAtSeen(p))].push(p);
    const out: QRow[] = [];
    for (const pr of PRIORITY_ORDER) {
      if (!by[pr].length) continue;
      const open = by[pr].filter((p) => p.stage.key === openKey && !skipped.has(p.investor.id));
      out.push({ kind: "group", priority: pr, left: open.length, ids: open.map((p) => p.investor.id) });
      for (const p of by[pr]) out.push({ kind: "row", p });
    }
    return out;
  }, [rows, fitAtSeen, openKey, skipped]);
  const heightAt = useCallback((i: number) => (list[i]?.kind === "group" ? GROUP_H : ROW_H), [list]);
  const v = useVirtualRows({ scrollRef: body, count: list.length, height: heightAt, initial: 24 });
  const { scrollToIndex } = v;
  const cursorRow = useMemo(() => list.findIndex((r) => r.kind === "row" && r.p.investor.id === cursor), [list, cursor]);
  useEffect(() => {
    if (cursorRow >= 0) scrollToIndex(cursorRow);
  }, [cursorRow, scrollToIndex]);
  const anySel = selected.size > 0;
  const pills: TriageSlice[] = ["all", "hw", "maybe", "low"];
  const groupRow = (r: Extract<QRow, { kind: "group" }>, stuck = false) => {
    const allSel = r.ids.length > 0 && r.ids.every((id) => selected.has(id));
    return (
      <div
        key={`g-${r.priority}${stuck ? "-stuck" : ""}`}
        className="group/qg sticky top-0 z-[1] flex items-center gap-8 border-b border-line bg-sunk px-14"
        style={{ height: GROUP_H }}
      >
        <span className="t-label">{GROUP_LABEL[r.priority]}</span>
        <span className="t-micro ml-auto text-muted">{num(r.left)} left</span>
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
    <section
      aria-label="Triage queue"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface"
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
        <div role="group" aria-label="Slice" className="flex flex-wrap gap-4">
          {pills.map((s) => {
            const on = s === slice;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => onSlice(s)}
                className={cn(
                  "inline-flex h-26 shrink-0 items-center gap-4 rounded-pill border px-8 text-[12.5px] whitespace-nowrap",
                  on ? "border-fg bg-fg text-canvas" : "border-line bg-surface text-fg hover:border-muted",
                )}
              >
                {SLICE_LABEL[s]}
                <span className={cn("font-mono text-[11px]", on ? "text-canvas" : "text-muted")}>{num(sliceCounts[s])}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin" role="listbox" aria-label="Investors in the queue" aria-multiselectable>
        {v.padTop > 0 ? <div aria-hidden style={{ height: v.padTop }} /> : null}
        {stuckGroup ? <div className="sticky top-0 z-[2] h-0 overflow-visible">{groupRow(stuckGroup, true)}</div> : null}
        {list.slice(v.start, v.end).map((r) => {
          if (r.kind === "group") return groupRow(r);
          const p = r.p;
          const id = p.investor.id;
          const isCur = id === cursor;
          const moved = p.stage.key !== openKey;
          const mine = decided.get(id);
          const type = shortType(p.investor.type);
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
              ) : (
                <span className="flex shrink-0 items-center gap-8">
                  {type ? <span className="font-mono text-[11.5px] text-muted">{type}</span> : null}
                  <FitMeter value={p.fit} />
                </span>
              )}
            </div>
          );
        })}
        {v.padBottom > 0 ? <div aria-hidden style={{ height: v.padBottom }} /> : null}
      </div>
      {canWrite && fit0.length >= 20 ? (
        <div className="flex shrink-0 items-center gap-10 border-t border-line bg-sunk px-14 py-10">
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

function historyLines(acts: Activity[], runs: ImportRun[] | null, name: string): { at: string; who: string; text: string }[] {
  const out: { at: string; who: string; text: string }[] = [];
  const seenRuns = new Set<string>();
  for (const a of acts) {
    const run = (a as Activity & { import_run_id?: string | null }).import_run_id ?? (typeof a.data?.import_run_id === "string" ? a.data.import_run_id : null);
    if (run) {
      if (seenRuns.has(run)) continue;
      seenRuns.add(run);
      const r = runs?.find((x) => x.id === run);
      const n = r ? (r.counts.created ?? 0) + (r.counts.updated ?? 0) : 0;
      const file = r?.filename ? ` from ${r.filename}` : "";
      const others = n > 1 ? ` with ${num(n - 1)} others` : "";
      out.push({ at: a.occurred_at, who: a.actor.label, text: `imported ${firstName(name)}${file}${others}` });
    } else {
      out.push({ at: a.occurred_at, who: a.actor.label, text: activitySentence(a) });
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
  today,
  timeZone,
  industries: rowIndustries,
  canWrite,
  nextStepFocus,
  onSaveNextStep,
  decidedStage,
}: {
  p: Participant;
  full: FullInvestor | undefined;
  runs: ImportRun[] | null;
  round: Round;
  wsSlug: string;
  today: string;
  timeZone: string;
  industries: string[];
  canWrite: boolean;
  nextStepFocus: number;
  onSaveNextStep: (text: string) => Promise<boolean>;
  decidedStage: Stage | null;
}) {
  const inv = full?.investor;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, []);
  const industries = visibleIndustries(inv?.industries ?? rowIndustries);
  const type = p.investor.type !== "other" ? INVESTOR_TYPE_LABEL[p.investor.type] : null;
  const otherRounds = (inv?.rounds ?? []).filter((r) => r.round_id !== round.id);
  const facts: [string, ReactNode][] = inv
    ? (
        [
          ["Invests at", inv.stage_focus.map(stageFocusLabel).join(", ")],
          ["Check size", checkSize(inv, round.currency)],
          ["Location", inv.location],
          ["Source", inv.source],
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
  const linkedinSearch = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([p.investor.name, p.investor.firm].filter(Boolean).join(" "))}`;

  return (
    <div className="flex flex-col gap-18 px-32 py-24 max-xl:px-20">
      <div>
        <h2 className="font-display text-[28px] leading-[1.1] font-bold tracking-[-0.02em]">{p.investor.name}</h2>
        {who ? <p className="mt-4 text-lg text-muted">{who}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <PriorityChip fit={p.fit} />
        <FitMeter value={p.fit} showLabel />
        {type ? <Chip tone="type">{type}</Chip> : null}
        {industries.slice(0, 3).map((i) => (
          <Chip key={i} tone="industry">
            {i}
          </Chip>
        ))}
        {industries.length > 3 ? <span className="t-micro text-muted">+{industries.length - 3}</span> : null}
        {inv?.source ? <Chip tone="tag">{inv.source}</Chip> : null}
        {decidedStage ? (
          <span className="t-body-s ml-auto inline-flex items-center gap-6 text-muted">
            <StageDot color={decidedStage.color} />
            Now in {decidedStage.label}
          </span>
        ) : null}
      </div>
      {inv ? (
        <div className="flex flex-wrap gap-6">
          <LinkButtons linkedin={inv.linkedin_url} website={inv.website_url} x={inv.x_url} email={inv.email} />
          {!inv.linkedin_url && !inv.website_url ? (
            <a href={linkedinSearch} target="_blank" rel="noopener noreferrer" className="inline-flex h-28 items-center rounded-sm border border-line bg-surface px-9 text-sm text-accent hover:border-accent">
              Search LinkedIn <span aria-hidden className="ml-4">↗</span>
            </a>
          ) : null}
        </div>
      ) : full?.error ? (
        <p className="t-body-s text-bad">{full.error}</p>
      ) : (
        <Skeleton width="45%" />
      )}

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
          <p className="text-muted">Only the basics came in with the import. Open LinkedIn to look them up.</p>
        )
      ) : full?.error ? null : (
        <div className="flex flex-col gap-8" aria-hidden>
          {slow ? <p className="t-body-s text-muted">Loading…</p> : null}
          <Skeleton lines={3} />
        </div>
      )}

      <NextStepField
        key={p.investor.id}
        value={p.next_step ?? ""}
        canWrite={canWrite}
        focusReq={nextStepFocus}
        onSave={onSaveNextStep}
      />

      <section aria-label="History" className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-x-12">
        <p className="t-label">History</p>
        {full?.acts ? (
          full.acts.length ? (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {historyLines(full.acts, runs, p.investor.name).map((h, i) => (
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
      <p className="sr-only">
        Open the full page at /w/{wsSlug}/investors/{p.investor.id}
      </p>
    </div>
  );
}

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
          placeholder="Optional, e.g. ask Harper for an intro"
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

function SelectionPane({ rows, openLabel, onClear }: { rows: Participant[]; openLabel: string; onClear: () => void }) {
  const fits = new Map<number, number>();
  const types = new Map<string, number>();
  for (const p of rows) {
    fits.set(p.fit, (fits.get(p.fit) ?? 0) + 1);
    const t = p.investor.type === "other" ? null : INVESTOR_TYPE_LABEL[p.investor.type];
    if (t) types.set(t, (types.get(t) ?? 0) + 1);
  }
  const fitText =
    fits.size === 1 ? `${num(rows.length)} at fit ${[...fits.keys()][0]}` : `fit ${Math.min(...fits.keys())}–${Math.max(...fits.keys())}`;
  const typeText = [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${num(n)} ${t}`)
    .join(", ");
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
      <ul className="m-0 flex list-none flex-wrap gap-x-12 gap-y-2 p-0">
        {rows.slice(0, 24).map((p) => (
          <li key={p.investor.id} className="t-body-s text-muted">
            {p.investor.name}
          </li>
        ))}
        {rows.length > 24 ? <li className="t-body-s text-muted">and {num(rows.length - 24)} more</li> : null}
      </ul>
    </div>
  );
}

/* ---------- decision panel ---------- */

function DecisionPanel({
  who,
  targets,
  currentStage,
  followUp,
  today,
  timeZone,
  disabled,
  focusKey,
  pickRef,
  onDecide,
  onFollow,
}: {
  who: string | null;
  targets: TriageTarget[];
  currentStage: string | null;
  followUp: string | null;
  today: string;
  timeZone: string;
  disabled: boolean;
  focusKey: string;
  pickRef: React.RefObject<HTMLDivElement | null>;
  phone: boolean;
  onDecide: (s: Stage) => void;
  onFollow: (iso: string | null) => void;
}) {
  const primary = targets.filter((t) => t.primary);
  const secondary = targets.filter((t) => !t.primary && t.key);
  const overflow = targets.filter((t) => !t.key);
  const firstBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The first primary target takes focus when an investor loads (unless typing elsewhere).
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.closest("[role=dialog]"))) return;
    firstBtn.current?.focus({ preventScroll: true });
  }, [focusKey]);
  const picks = quickPicks("followup", today);
  const iso = (k: string) => picks.find((p) => p.kbd === k)!.iso;
  const btn = (t: TriageTarget, big: boolean, i: number) => (
    <button
      key={t.stage.key}
      ref={big && i === 0 ? firstBtn : undefined}
      type="button"
      disabled={disabled}
      aria-keyshortcuts={t.key ?? undefined}
      aria-pressed={currentStage === t.stage.key || undefined}
      onClick={() => onDecide(t.stage)}
      className={cn(
        "flex min-w-0 items-center gap-8 rounded-sm border bg-surface px-14 text-left hover:border-accent disabled:opacity-55",
        currentStage === t.stage.key ? "border-fg" : "border-line",
        big ? "h-44 text-[15px] font-medium" : "h-36 text-base",
      )}
    >
      <StageDot color={t.stage.color} />
      <span className="min-w-0 flex-1 truncate">{t.stage.label}</span>
      {t.key ? <Kbd>{t.key}</Kbd> : null}
    </button>
  );
  return (
    <div className="flex shrink-0 flex-col gap-10 border-t border-line bg-sunk px-32 pt-14 pb-12 max-xl:px-20">
      <p className="flex items-baseline gap-10">
        <span className="t-label">{who ? `Where does ${who} go?` : "Where do they go?"}</span>
        <span className="t-micro text-muted max-[1100px]:hidden">one key, then the next investor opens</span>
      </p>
      <div className="grid grid-cols-3 gap-8">{primary.map((t, i) => btn(t, true, i))}</div>
      {secondary.length || overflow.length ? (
        <div className="grid gap-8" style={{ gridTemplateColumns: `repeat(${Math.min(5, secondary.length + (overflow.length ? 1 : 0))}, minmax(0, 1fr))` }}>
          {secondary.map((t, i) => btn(t, false, i))}
          {overflow.length ? (
            <Menu
              label="Other stage"
              trigger="Other stage…"
              triggerClassName="h-36 w-full rounded-sm border border-line bg-surface px-14 text-left hover:border-accent"
              items={overflow.map((t) => ({ label: t.stage.label, icon: <StageDot color={t.stage.color} />, onSelect: () => onDecide(t.stage) }))}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-6" ref={pickRef}>
        <span className="t-label mr-6">Follow up</span>
        {[
          { label: "None", value: null as string | null, hint: null as string | null },
          ...FOLLOW_KEYS.map((f) => ({ label: f.label, value: iso(f.kbd), hint: `f ${f.kbd}` })),
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            disabled={disabled}
            aria-pressed={followUp === o.value}
            onClick={() => onFollow(o.value)}
            className={cn(
              "inline-flex h-32 items-center gap-6 rounded-sm border px-10 text-base disabled:opacity-55",
              followUp === o.value ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:border-muted",
            )}
            title={o.value ? formatDate(o.value, today) : "No follow-up"}
          >
            {o.label}
            {o.hint ? <Kbd>{o.hint}</Kbd> : null}
          </button>
        ))}
        <DateField
          value={followUp && !FOLLOW_KEYS.some((f) => iso(f.kbd) === followUp) ? followUp : null}
          onChange={(v) => onFollow(v)}
          timeZone={timeZone}
          quickPicks="followup"
          placeholder="Pick…"
          size="sm"
          tone="toolbar"
          disabled={disabled}
          aria-label="Follow up on a date"
          className="w-auto"
        />
      </div>
      <p className="t-micro flex flex-wrap items-center gap-x-12 gap-y-4 text-muted">
        {(
          [
            ["S", "Skip"],
            ["U", "Undo"],
            ["[ ]", "Fit"],
            ["X", "Select"],
            ["↵", "Open file"],
            ["L", "LinkedIn"],
          ] as const
        ).map(([k, l]) => (
          <span key={l} className="inline-flex items-center gap-4">
            <Kbd>{k}</Kbd>
            {l}
          </span>
        ))}
        <span className="ml-auto">Moves save instantly, with Undo.</span>
      </p>
    </div>
  );
}

/* ---------- rail ---------- */

function WhereStrip({ stages, rows, counts }: { stages: Stage[]; rows: Participant[]; counts: Record<string, number> }) {
  const c: Record<string, number> = {};
  for (const p of rows) c[p.stage.key] = (c[p.stage.key] ?? 0) + 1;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-14 gap-y-4 border-b border-line px-16 py-8">
      {stages.map((s) => (
        <span key={s.key} className="t-body-s inline-flex items-center gap-5">
          <StageDot color={s.color} />
          {s.label}
          <span className="font-mono text-[11.5px] text-muted">{num(c[s.key] ?? 0)}</span>
          {counts[s.key] ? <span className="font-mono text-[11.5px] text-good-ink">+{num(counts[s.key]!)}</span> : null}
        </span>
      ))}
    </div>
  );
}

function TriageRail({
  round,
  stages,
  targets,
  rows,
  counts,
  openKey,
  today,
  sessionLine,
  hwLeft,
  sliceCounts,
  canMove,
  onDecide,
}: {
  round: Round;
  stages: Stage[];
  targets: TriageTarget[];
  rows: Participant[];
  counts: Record<string, number>;
  openKey: string;
  today: string;
  sessionLine: string | null;
  hwLeft: number;
  sliceCounts: { hw: number; maybe: number; low: number };
  canMove: boolean;
  onDecide: (s: Stage) => void;
}) {
  const c: Record<string, number> = {};
  let committed = 0;
  let due = 0;
  let soft = 0;
  for (const p of rows) {
    c[p.stage.key] = (c[p.stage.key] ?? 0) + 1;
    committed += p.amount_committed ?? 0;
    soft += p.amount_soft ?? 0;
    if (p.follow_up_state === "overdue" || p.follow_up_state === "today") due++;
  }
  const keyOf = new Map(targets.map((t) => [t.stage.key, t.key]));
  const days = round.target_close_on ? Math.round((Date.parse(round.target_close_on) - Date.parse(today)) / 86_400_000) : null;
  const terms = [
    INSTRUMENT_LABEL[round.instrument],
    round.valuation_cap ? `${moneyCompact(round.valuation_cap, round.currency)} cap` : null,
    round.target_close_on ? `closes ${formatDate(round.target_close_on, today)}` : null,
    days !== null && days >= 0 ? `${num(days)} days` : null,
  ].filter(Boolean);
  const largest = (["hw", "maybe", "low"] as const).find((k) => sliceCounts[k] > 0);
  const startN = hwLeft || (largest ? sliceCounts[largest] : 0);
  const startLabel = hwLeft ? "are Hot or Warm" : largest === "maybe" ? "are Maybe" : "are Low fit";
  return (
    <aside aria-label="Round and progress" className="flex min-h-0 flex-col gap-18 overflow-y-auto pr-2">
      <section>
        <p className="t-label mb-6">The round</p>
        <p className="t-micro text-muted">
          <span className={committed + soft > 0 ? "text-good-ink" : "text-fg"}>{money(committed, round.currency)}</span> of{" "}
          {money(round.target_amount, round.currency)} · {due ? `${num(due)} due` : "nothing due"}
        </p>
        <p className="t-micro mt-2 text-muted">{terms.join(" · ")}</p>
      </section>
      <section>
        <p className="t-label mb-6 flex">
          Where they go<span className="ml-auto normal-case tracking-normal">key</span>
        </p>
        <ul className="m-0 flex list-none flex-col p-0">
          {stages.map((s) => {
            const k = keyOf.get(s.key);
            const isO = s.key === openKey;
            const add = counts[s.key] ?? 0;
            return (
              <li key={s.key} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  disabled={isO || !canMove}
                  onClick={() => onDecide(s)}
                  className="flex h-32 w-full items-center gap-8 border-0 bg-transparent px-2 text-left enabled:hover:bg-surface disabled:cursor-default"
                  aria-keyshortcuts={k ?? undefined}
                >
                  <span className="inline-flex w-20 justify-center">{k ? <Kbd>{k}</Kbd> : null}</span>
                  <StageDot color={s.color} />
                  <span className={cn("min-w-0 flex-1 truncate", isO && "font-semibold")}>{s.label}</span>
                  {add ? <span className="font-mono text-[11.5px] text-good-ink">+{num(add)}</span> : null}
                  <span className="w-36 text-right font-mono text-[12px] text-muted tnum">{num(c[s.key] ?? 0)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        {sessionLine ? (
          <>
            <p className="t-label mb-6 flex">
              This session
              <span className="ml-auto inline-flex items-center gap-4 normal-case tracking-normal">
                Undo <Kbd>U</Kbd>
              </span>
            </p>
            <p className="t-body-s text-muted">{sessionLine}</p>
          </>
        ) : startN ? (
          <>
            <p className="t-label mb-6">Start here</p>
            <p className="t-body-s text-muted">
              <b className="font-semibold text-fg">
                {num(startN)} {startLabel}.
              </b>{" "}
              Deciding those first takes about {formatDuration(startN * START_SECONDS * 1000)}; the board fills in as you go.
            </p>
          </>
        ) : null}
      </section>
    </aside>
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
  pos,
  count,
  sorted,
  total,
  upNext,
  doneState,
  canWrite,
  filter,
  onExit,
  onDecide,
  onSkip,
  onFollow,
  onSaveNextStep,
}: {
  round: Round;
  current: Participant | null;
  full: FullInvestor | undefined;
  extras: Record<string, { industries: string[] }>;
  today: string;
  timeZone: string;
  targets: TriageTarget[];
  slice: TriageSlice;
  pos: number;
  count: number;
  sorted: number;
  total: number;
  upNext: Participant[];
  doneState: ReactNode;
  canWrite: boolean;
  filter: ReactNode;
  onExit: () => void;
  onDecide: (s: Stage) => void;
  onSkip: () => void;
  onFollow: (iso: string | null) => void;
  onSaveNextStep: (text: string) => Promise<boolean>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useToastLift(bar, true);
  const [stepOpen, setStepOpen] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
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
  const picks = quickPicks("followup", today);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas" role="region" aria-label="Triage">
      <header className="flex h-56 shrink-0 items-center gap-8 border-b border-line bg-surface px-8 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={onExit} aria-label="Back to the list" className="inline-flex size-40 items-center justify-center rounded-sm border-0 bg-transparent text-lg">
          ✕
        </button>
        <span className="font-semibold">Triage</span>
        <span className="t-micro min-w-0 flex-1 truncate text-muted">
          {pos >= 0 ? `${num(pos + 1)} of ${num(count)}` : `${num(sorted)} of ${num(total)} sorted`}
          {slice !== "all" ? ` · ${SLICE_LABEL[slice]}` : ""}
        </span>
        {filter}
      </header>
      <div className="h-3 shrink-0 bg-sunk" aria-hidden>
        <i className="block h-full bg-good not-italic" style={{ width: `${total ? (sorted / total) * 100 : 0}%` }} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-16 pt-14 pb-[calc(170px+env(safe-area-inset-bottom))]">
        {doneState ??
          (p ? (
            <>
              <article className="rounded-md border border-line bg-surface p-16">
                <div className="flex flex-wrap items-center gap-6">
                  <PriorityChip fit={p.fit} />
                  <FitMeter value={p.fit} showLabel />
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
                      <Chip key={i} tone="industry">
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
                  <div className="mt-12 flex flex-wrap gap-6">
                    <LinkButtons linkedin={inv.linkedin_url} website={inv.website_url} x={inv.x_url} email={inv.email} />
                    {!inv.linkedin_url && !inv.website_url ? (
                      <a
                        href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([p.investor.name, p.investor.firm].filter(Boolean).join(" "))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-28 items-center rounded-sm border border-line bg-surface px-9 text-sm text-accent"
                      >
                        Search LinkedIn <span aria-hidden className="ml-4">↗</span>
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <Skeleton className="mt-12" width="60%" />
                )}
                {inv && !facts.length && !inv.notes ? (
                  <p className="t-body-s mt-10 text-muted">Only the basics came in with the import.</p>
                ) : null}
              </article>
              <div className="mt-12">
                {stepOpen ? (
                  <NextStepField key={p.investor.id} value={p.next_step ?? ""} canWrite={canWrite} focusReq={0} onSave={onSaveNextStep} />
                ) : (
                  <button type="button" onClick={() => setStepOpen(true)} className="link border-0 bg-transparent p-0" disabled={!canWrite}>
                    + Next step
                  </button>
                )}
              </div>
              {upNext.length ? (
                <section className="mt-18">
                  <p className="t-label mb-6">Up next</p>
                  <ul className="m-0 flex list-none flex-col gap-4 p-0">
                    {upNext.map((x) => (
                      <li key={x.investor.id} className="flex min-w-0 items-center gap-8">
                        <span className="shrink-0 font-medium">{x.investor.name}</span>
                        <span className="t-body-s min-w-0 flex-1 truncate text-muted">{x.investor.firm}</span>
                        <FitMeter value={x.fit} />
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
          className="fixed inset-x-0 bottom-0 z-[41] flex flex-col gap-8 border-t border-line bg-surface px-12 pt-10 pb-[calc(10px+env(safe-area-inset-bottom))]"
        >
          <div className="grid grid-cols-3 gap-8">
            {primary.map((t) => (
              <button
                key={t.stage.key}
                type="button"
                disabled={!canWrite || !p}
                onClick={() => onDecide(t.stage)}
                className="flex h-48 min-w-0 items-center justify-center gap-6 rounded-sm border border-line bg-surface px-8 font-medium disabled:opacity-55"
              >
                <StageDot color={t.stage.color} />
                <span className="truncate">{t.stage.label}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-8">
            <button type="button" onClick={onSkip} disabled={!p} className="h-40 rounded-sm border-0 bg-transparent text-muted hover:bg-sunk">
              Skip
            </button>
            <button type="button" onClick={() => setFollowOpen(true)} disabled={!p || !canWrite} className="h-40 rounded-sm border-0 bg-transparent text-muted hover:bg-sunk">
              Follow up
            </button>
            <Menu
              label="Other stage"
              align="end"
              trigger="Other stage"
              triggerClassName="h-40 w-full rounded-sm border-0 bg-transparent text-muted hover:bg-sunk"
              className="w-full"
              items={otherItems}
            />
          </div>
          <p className="t-body-s text-center text-muted">Each tap saves, opens the next investor and offers Undo.</p>
        </div>
      )}
      <Sheet open={followOpen} onClose={() => setFollowOpen(false)} title="Follow up">
        <div className="flex flex-col gap-8">
          {picks
            .filter((x) => ["1", "m", "7", "2"].includes(x.kbd ?? ""))
            .map((x) => (
              <Button
                key={x.label}
                size="lg"
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

