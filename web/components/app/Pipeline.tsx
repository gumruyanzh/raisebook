"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Button,
  ButtonLink,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Kbd,
  Menu,
  SearchInput,
  Segmented,
  Select,
  Sheet,
  StageDot,
  useToast,
  useToastLift,
  type MenuEntry,
} from "@/components/ui";
import { Avatar } from "@/components/ui/Avatar";
import { FilterChips, FilterMenu, type FilterField, type FilterMenuHandle } from "@/components/ui/FilterBar";
import { errorMessage } from "@/lib/api/client";
import {
  bulkUpdateParticipants,
  expandPipelineItems,
  getRoundSummary,
  moveStage,
  sortedStages,
  type BulkInput,
  type BulkItem,
  type BulkResult,
  type PipelineExtra,
  type PipelineItem,
} from "@/lib/api/rounds";
import type { ActorType, InvestorType, Member, Participant, Priority, Round, RoundSummary } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL, PRIORITY_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useCommands } from "@/lib/commands";
import { formatDate, num, priorityFromFit, relativeTime } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import {
  countByStage,
  defaultView,
  dominantStage,
  isQuiet,
  moneyExists as hasMoney,
  openStage as findOpenStage,
  PRIORITY_ORDER,
  triageTargets,
  type NextUpBucket,
  type PipelineView,
  type TriageSlice,
} from "@/lib/pipeline";
import { useWorkspace } from "@/lib/session";

import { AddInvestorDialog } from "./AddInvestorDialog";
import { InvestorSheet } from "./InvestorSheet";
import { quickPicks } from "@/lib/dates";
import { PipelineBoard, sortCards, type AgentMark, type BoardSort } from "./PipelineBoard";
import { ledgerFacts, LedgerDesk, LedgerStrip } from "./PipelineLedger";
import { PipelinePhone } from "./PipelinePhone";
import { PipelineTriage, type TriageStore } from "./PipelineTriage";
import { RoundHeader } from "./RoundHeader";
import {
  DEFAULT_DIR,
  PipelineTable,
  sortParticipants,
  TABLE_COLS,
  type Density,
  type SortDir,
  type TableCol,
} from "./PipelineTable";
import {
  downloadText,
  matchesQuery,
  participantSearchText,
  personName,
  readJson,
  readStore,
  toCsv,
  useMediaQuery,
  writeStore,
} from "./util";

type View = PipelineView;
type FollowFilter = "" | "due" | "week" | "none" | "quiet";

const VIEW_KEY = (ws: string, roundId: string) => `rb-view:${ws}:${roundId}`;
const STEP_KEY = "rb-card-next-step";
/** The investor sheet's width (Sheet's default). */
const SHEET_W = 520;
const COLS_KEY = (ws: string, roundId: string) => `rb-table-cols:${ws}:${roundId}`;
const DENSITY_KEY = (view: "board" | "table") => `rb-density:${view}`;
const BOARD_SORT_KEY = (roundId: string) => `rb-board-sort:${roundId}`;
/** Columns hidden until the founder turns them on. */
const DEFAULT_HIDDEN: TableCol[] = ["title"];
const FILTER_KEYS = ["stage", "prio", "type", "industry", "follow", "owner", "tag", "kind"] as const;
/** URL keys a built-in view sets (the filters and the search). */
const FILTER_PARAMS = ["q", ...FILTER_KEYS] as const;
/** URL keys a saved view captures: filters, search, view and sort. */
const VIEW_KEYS = [...FILTER_PARAMS, "view", "sort", "order"] as const;

interface SavedView {
  id: string;
  name: string;
  /** URL query (without the open investor). */
  query: string;
  builtin?: boolean;
  density?: Density;
  hidden?: TableCol[];
}

/** The given keys of a query, sorted, as a string (to compare views with the URL). */
function normQuery(sp: URLSearchParams, keys: readonly string[]): string {
  const out = new URLSearchParams();
  for (const k of [...keys].sort()) {
    const v = sp.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

/** An agent action on the round in the last 24 hours (trimmed on the server). */
export interface AgentMarkInput {
  investor_id: string;
  kind: string;
  label: string;
  type: ActorType;
  at: string;
  /** Written by an import run: an agent importing a list is not "an agent did this" to a card. */
  imported?: boolean;
}

/** Agent actions in the last 24h, latest per investor (SYSTEM §2.5). */
export function agentMarksFrom(acts: AgentMarkInput[], now = new Date()): Record<string, AgentMark> {
  const out: Record<string, AgentMark> = {};
  for (const a of acts) {
    if (a.type !== "agent" || a.imported || out[a.investor_id]) continue;
    const verb =
      a.kind === "stage_change"
        ? "Moved"
        : a.kind === "commitment"
          ? "Commitment recorded"
          : a.kind === "follow_up_set"
            ? "Follow-up set"
            : ["note", "email", "call", "meeting"].includes(a.kind)
              ? "Logged"
              : "Updated";
    out[a.investor_id] = { label: a.label, tip: `${verb} by ${a.label} ${relativeTime(a.at, now)}` };
  }
  return out;
}

/* ---------- the round's client store (UX pass 1, P0-5) ----------
 *
 * Server props are initial data only. Rows live here, keyed by round id, so they survive a
 * remount (Back, a cached payload) and a late server payload never overwrites a newer local
 * write: rows merge by `updated_at` (newer wins), rows added here after the payload was made
 * are kept, and rows removed here are not brought back by it.
 */

interface RoundCache {
  participants: Participant[];
  extras: Record<string, PipelineExtra>;
  summary: RoundSummary;
  summaryAt: number;
  /** Server snapshot time (ms) of the last merged payload. */
  serverAt: number;
  /** investor id → when it was added or written here. */
  written: Map<string, number>;
  /** investor id → when it was removed here. */
  removed: Map<string, number>;
  /** Investors with a write in flight (an optimistic move): local wins until it lands. */
  pending: Set<string>;
}

const CACHE = new Map<string, RoundCache>();

const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

function mergeRows(
  local: Participant[],
  server: Participant[],
  serverAt: number,
  written: Map<string, number>,
  removed: Map<string, number>,
  pending: Set<string>,
): Participant[] {
  const mine = new Map(local.map((p) => [p.investor.id, p]));
  const seen = new Set<string>();
  const out: Participant[] = [];
  for (const s of server) {
    const id = s.investor.id;
    seen.add(id);
    if ((removed.get(id) ?? 0) > serverAt) continue;
    const l = mine.get(id);
    out.push(l && (pending.has(id) || ts(l.updated_at) > ts(s.updated_at)) ? l : s);
  }
  for (const l of local) {
    if (!seen.has(l.investor.id) && (written.get(l.investor.id) ?? 0) > serverAt) out.push(l);
  }
  return out;
}


export interface PipelineProps {
  round: Round;
  summary: RoundSummary;
  items: PipelineItem[];
  members: Member[];
  agentMarks: AgentMarkInput[];
  today: string;
  /** When the server made this payload (merge reference for the client store). */
  loadedAt: string;
  /** "Get set up" facts the page cannot derive (null: not visible to this member). */
  setup?: { activeKeys: number | null; pendingInvites: number | null };
}

/**
 * The round's working surface (SYSTEM §4.2): compact ledger, a one-line toolbar, the board
 * or the dense table, and the investor sheet. Filters, sort, view and the open investor live
 * in the URL (updated with `history.replaceState`, so filtering never asks the server), and
 * the board or table fills the viewport so only the columns or rows scroll.
 */
export function Pipeline(props: PipelineProps) {
  const { workspace, client, canWrite } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const tz = workspace.timezone;
  const today = props.today;
  const round = props.round;
  const stages = useMemo(() => sortedStages(round.stages), [round.stages]);
  const serverAt = ts(props.loadedAt);

  /* ---------- store ---------- */
  const fromServer = useMemo(() => expandPipelineItems(props.items, round, today), [props.items, round, today]);
  const cache = useRef<RoundCache | null>(null);
  if (!cache.current) {
    const prev = CACHE.get(round.id);
    cache.current = prev
      ? {
          ...prev,
          participants: mergeRows(
            prev.participants,
            fromServer.participants,
            serverAt,
            prev.written,
            prev.removed,
            prev.pending,
          ),
          extras: { ...prev.extras, ...fromServer.extras },
          summary: serverAt >= prev.summaryAt ? props.summary : prev.summary,
          summaryAt: Math.max(prev.summaryAt, serverAt),
          serverAt,
        }
      : {
          participants: fromServer.participants,
          extras: fromServer.extras,
          summary: props.summary,
          summaryAt: serverAt,
          serverAt,
          written: new Map(),
          removed: new Map(),
          pending: new Set(),
        };
    CACHE.set(round.id, cache.current);
  }
  const c0 = cache.current;
  const [participants, setParticipantsState] = useState(c0.participants);
  const [extras, setExtras] = useState(c0.extras);
  const [summary, setSummaryState] = useState(c0.summary);
  const [agentMarks, setAgentMarks] = useState(() => agentMarksFrom(props.agentMarks));

  const setParticipants = useCallback((fn: (list: Participant[]) => Participant[]) => {
    setParticipantsState((list) => {
      const next = fn(list);
      if (cache.current) cache.current.participants = next;
      return next;
    });
  }, []);
  const setSummary = useCallback((s: RoundSummary) => {
    if (cache.current) {
      cache.current.summary = s;
      cache.current.summaryAt = Date.now();
    }
    setSummaryState(s);
  }, []);

  // A newer server payload (router.refresh, a revisit) merges in; it never wins over newer
  // local writes.
  const lastMerged = useRef(fromServer);
  useEffect(() => {
    if (lastMerged.current === fromServer) return;
    lastMerged.current = fromServer;
    const c = cache.current!;
    if (serverAt < c.serverAt) return;
    c.serverAt = serverAt;
    setParticipants((list) => mergeRows(list, fromServer.participants, serverAt, c.written, c.removed, c.pending));
    setExtras((e) => {
      const next = { ...e, ...fromServer.extras };
      c.extras = next;
      return next;
    });
    if (serverAt >= c.summaryAt) {
      c.summary = props.summary;
      c.summaryAt = serverAt;
      setSummaryState(props.summary);
    }
    setAgentMarks(agentMarksFrom(props.agentMarks));
  }, [fromServer, serverAt, props.summary, props.agentMarks, setParticipants]);

  const [announce, setAnnounce] = useState("");
  const [adding, setAdding] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  /* ---------- URL state (history.replaceState: no server round-trip) ---------- */
  const get = (k: string) => params.get(k) ?? "";
  const q = get("q");
  const prio = get("prio") as Priority | "";
  const type = get("type") as InvestorType | "";
  const industry = get("industry");
  const follow = get("follow") as FollowFilter;
  const owner = get("owner");
  const tag = get("tag");
  const stageFilter = get("stage");
  const kindFilter = get("kind");
  const openId = params.get("investor");
  const sortCol = (TABLE_COLS.some((c) => c.key === get("sort")) ? get("sort") : "fit") as TableCol;
  const sortDir = (get("order") === "asc" || get("order") === "desc" ? get("order") : DEFAULT_DIR[sortCol]) as SortDir;

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, []);

  /* ---------- view (DECISION §3) and per-viewer preferences ---------- */
  const phone = useMediaQuery("(max-width: 639px)") === true;
  const oStage = useMemo(() => findOpenStage(stages), [stages]);
  const stageN = useMemo(() => countByStage(participants), [participants]);
  const openCount = oStage ? (stageN[oStage.key] ?? 0) : 0;
  const dominantKey = useMemo(() => dominantStage(stageN, participants.length), [stageN, participants.length]);
  // undefined until this browser's choice is read (before paint), so the auto rule never flashes.
  const [storedView, setStoredView] = useState<string | null | undefined>(undefined);
  useLayoutEffect(() => setStoredView(readStore(VIEW_KEY(workspace.slug, round.id))), [workspace.slug, round.id]);
  const urlView = get("view");
  const resolved = defaultView({
    url: urlView,
    stored: storedView ?? null,
    canWrite,
    hasOpenStage: Boolean(oStage),
    openCount,
    total: participants.length,
  });
  // Phones have no board: the list, or the Triage takeover when asked for.
  const view: View = phone ? (resolved.view === "triage" && urlView === "triage" ? "triage" : "table") : resolved.view;
  const autoTriage = !phone && resolved.auto && view === "triage";
  // "All 411 are New, so the round opens in Triage." explains the auto pick once per round
  // and browser, then gives the title row back.
  const NOTE_KEY = `rb-triage-note:${workspace.slug}:${round.id}`;
  const [triageNote, setTriageNote] = useState(false);
  useEffect(() => {
    if (!autoTriage || readStore(NOTE_KEY) === "1") return;
    setTriageNote(true);
    writeStore(NOTE_KEY, "1");
  }, [autoTriage, NOTE_KEY]);
  const triageOk = canWrite && Boolean(oStage) && (openCount > 0 || view === "triage");
  const setView = (v: View) => {
    if (!phone) {
      setStoredView(v);
      writeStore(VIEW_KEY(workspace.slug, round.id), v);
    }
    setParams({ view: v, ...(v !== "triage" ? { tq: null, at: null } : {}) });
  };
  const startTriage = (tq?: TriageSlice) => setParams({ view: "triage", tq: tq && tq !== "all" ? tq : null, at: null });

  const [density, setDensityState] = useState<Density | null>(null);
  const [showStep, setShowStep] = useState(false);
  useEffect(() => {
    const raw = readStore(DENSITY_KEY("table"));
    setDensityState(raw === "compact" || raw === "comfortable" ? raw : null);
    setShowStep(readStore(STEP_KEY) === "1");
  }, []);
  const tableDensity: Density = density ?? (participants.length > 100 ? "compact" : "comfortable");
  const setDensity = (_v: View, d: Density) => {
    writeStore(DENSITY_KEY("table"), d);
    setDensityState(d);
  };
  const toggleStep = () =>
    setShowStep((x) => {
      writeStore(STEP_KEY, x ? "0" : "1");
      return !x;
    });

  const [hidden, setHidden] = useState<Set<TableCol>>(new Set(DEFAULT_HIDDEN));
  useEffect(() => {
    const arr = readJson<TableCol[] | null>(COLS_KEY(workspace.slug, round.id), null);
    if (Array.isArray(arr)) setHidden(new Set(arr));
  }, [workspace.slug, round.id]);
  const visible = useMemo(() => new Set(TABLE_COLS.map((c) => c.key).filter((k) => !hidden.has(k))), [hidden]);
  const [shownCols, setShownCols] = useState<Set<TableCol> | null>(null);
  const toggleCol = (k: TableCol) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      writeStore(COLS_KEY(workspace.slug, round.id), JSON.stringify([...n]));
      return n;
    });

  const [boardSorts, setBoardSorts] = useState<Record<string, BoardSort>>({});
  useEffect(() => setBoardSorts(readJson(BOARD_SORT_KEY(round.id), {})), [round.id]);
  const setBoardSort = (stageKey: string, s: BoardSort) =>
    setBoardSorts((m) => {
      const next = { ...m, [stageKey]: s };
      writeStore(BOARD_SORT_KEY(round.id), JSON.stringify(next));
      return next;
    });

  /* ---------- search: local text first, URL after a pause ---------- */
  const [qText, setQText] = useState(q);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!qTimer.current) setQText(q);
  }, [q]);
  const onSearch = (v: string) => {
    setQText(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      qTimer.current = null;
      setParams({ q: v.trim() || null });
    }, 200);
  };
  const query = useDeferredValue(qText.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<FilterMenuHandle>(null);
  const filterBtnFocus = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-pipeline-toolbar] [aria-keyshortcuts="F"]')?.focus(),
    );

  /* ---------- data refresh ---------- */
  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await getRoundSummary(client, round.id));
    } catch {
      /* the ledger keeps its last numbers; the next write retries */
    }
  }, [client, round.id, setSummary]);

  // Agent work while the tab was away: re-render the server page in the background (one
  // request); its rows merge in by updated_at.
  const lastRefresh = useRef(Date.now());
  const refreshSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundRefresh = useCallback(
    (delay = 0) => {
      if (refreshSoon.current) clearTimeout(refreshSoon.current);
      refreshSoon.current = setTimeout(() => {
        lastRefresh.current = Date.now();
        router.refresh();
      }, delay);
    },
    [router],
  );
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh.current > 20_000) backgroundRefresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [backgroundRefresh]);
  useEffect(() => () => void (refreshSoon.current && clearTimeout(refreshSoon.current)), []);

  /** After a write: the store first, then the summary, then (debounced) the server page. */
  // Debounced: a run of Triage decisions refreshes the summary once, not once per key.
  const summarySoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (summarySoon.current && clearTimeout(summarySoon.current)), []);
  const afterWrite = useCallback(() => {
    if (summarySoon.current) clearTimeout(summarySoon.current);
    summarySoon.current = setTimeout(() => void refreshSummary(), 1500);
    backgroundRefresh(4000);
  }, [refreshSummary, backgroundRefresh]);

  const patchParticipant = useCallback(
    (p: Participant) => {
      cache.current?.written.set(p.investor.id, Date.now());
      setParticipants((list) => {
        const i = list.findIndex((x) => x.investor.id === p.investor.id);
        if (i < 0) return [...list, p];
        const cur = list[i]!;
        // Two server versions: the newer one wins (a late response never undoes a later write).
        if (ts(cur.updated_at) > ts(p.updated_at)) return list;
        const next = list.slice();
        next[i] = p;
        return next;
      });
    },
    [setParticipants],
  );

  /* ---------- single moves (optimistic, with Undo) ---------- */
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  const doMove = useCallback(
    async (investorId: string, key: string, opts: { undo?: boolean } = {}): Promise<boolean> => {
      const prev = participantsRef.current.find((p) => p.investor.id === investorId);
      const to = stages.find((s) => s.key === key);
      if (!prev || !to || prev.stage.key === key) return false;
      const from = prev.stage;
      setParticipants((list) =>
        list.map((p) => (p.investor.id === investorId ? { ...p, stage: to } : p)),
      );
      const pending = cache.current!.pending;
      pending.add(investorId);
      try {
        const res = await moveStage(client, round.id, investorId, key);
        pending.delete(investorId);
        patchParticipant(res.participant);
        const msg = `${prev.investor.name} moved to ${to.label}.`;
        setAnnounce(msg);
        if (opts.undo === false) toast.show(msg);
        else
          toast.show(
            to.kind === "won" && !res.participant.amount_committed ? `${msg} Record the amount in their file.` : msg,
            { label: "Undo", onClick: () => void doMoveRef.current(investorId, from.key, { undo: false }) },
          );
        afterWrite();
        return true;
      } catch (err) {
        pending.delete(investorId);
        setParticipants((list) => list.map((p) => (p.investor.id === investorId ? prev : p)));
        toast.show(`${prev.investor.name} was not moved. ${errorMessage(err)}`);
        return false;
      }
    },
    [stages, client, round.id, patchParticipant, toast, afterWrite, setParticipants],
  );
  const doMoveRef = useRef(doMove);
  doMoveRef.current = doMove;

  /* ---------- filtering (client only) ---------- */
  const counts = useMemo(() => {
    const ind = new Map<string, { label: string; n: number }>();
    const tags = new Map<string, { label: string; n: number }>();
    const stage: Record<string, number> = {};
    const prioN: Record<string, number> = {};
    const typeN: Record<string, number> = {};
    const ownerN: Record<string, number> = {};
    let due = 0;
    let week = 0;
    let none = 0;
    let quiet = 0;
    const nowMs = Date.now();
    for (const p of participants) {
      stage[p.stage.key] = (stage[p.stage.key] ?? 0) + 1;
      const pr = priorityFromFit(p.fit);
      prioN[pr] = (prioN[pr] ?? 0) + 1;
      typeN[p.investor.type] = (typeN[p.investor.type] ?? 0) + 1;
      const o = p.owner?.user_id ?? "none";
      ownerN[o] = (ownerN[o] ?? 0) + 1;
      const st = p.follow_up_state;
      if (!p.follow_up_on) none++;
      if (st === "overdue" || st === "today") due++;
      if (st === "overdue" || st === "today" || st === "soon") week++;
      if (isQuiet(p, today, nowMs)) quiet++;
      for (const i of extras[p.investor.id]?.industries ?? []) {
        const k = i.toLowerCase();
        const cur = ind.get(k);
        ind.set(k, { label: cur?.label ?? i, n: (cur?.n ?? 0) + 1 });
      }
      for (const t of p.investor.tags ?? []) {
        const k = t.toLowerCase();
        const cur = tags.get(k);
        tags.set(k, { label: cur?.label ?? t, n: (cur?.n ?? 0) + 1 });
      }
    }
    const sortMap = (m: Map<string, { label: string; n: number }>) =>
      [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    return { industries: sortMap(ind), tags: sortMap(tags), stage, prioN, typeN, ownerN, due, week, none, quiet };
  }, [participants, extras, today]);

  const searchText = useMemo(() => {
    const m = new Map<Participant, string>();
    return (p: Participant) => {
      let t = m.get(p);
      if (t === undefined) {
        t = participantSearchText(p, extras[p.investor.id]);
        m.set(p, t);
      }
      return t;
    };
  }, [extras]);

  // Every filter except the stage (Triage works inside the open stage).
  const matches = useCallback(
    (p: Participant) => {
      if (prio && priorityFromFit(p.fit) !== prio) return false;
      if (kindFilter && p.stage.kind !== kindFilter) return false;
      if (type && p.investor.type !== type) return false;
      if (industry) {
        const inds = extras[p.investor.id]?.industries ?? [];
        if (!inds.some((i) => i.toLowerCase() === industry.toLowerCase())) return false;
      }
      if (tag && !(p.investor.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
      if (follow) {
        const st = p.follow_up_state;
        if (follow === "none" && p.follow_up_on) return false;
        if (follow === "due" && st !== "overdue" && st !== "today") return false;
        if (follow === "week" && st !== "overdue" && st !== "today" && st !== "soon") return false;
        if (follow === "quiet" && !isQuiet(p, today, Date.now())) return false;
      }
      if (owner === "none" && p.owner) return false;
      if (owner && owner !== "none" && p.owner?.user_id !== owner) return false;
      if (query && !matchesQuery(searchText(p), query)) return false;
      return true;
    },
    [extras, prio, kindFilter, type, industry, tag, follow, owner, query, searchText, today],
  );
  const filtered = useMemo(
    () => participants.filter((p) => (!stageFilter || p.stage.key === stageFilter) && matches(p)),
    [participants, stageFilter, matches],
  );

  const active: Record<string, string | undefined> = {
    stage: stageFilter || undefined,
    prio: prio || undefined,
    type: type || undefined,
    industry: industry || undefined,
    follow: follow || undefined,
    owner: owner || undefined,
    tag: tag || undefined,
    kind: kindFilter || undefined,
  };
  const activeFilters = FILTER_KEYS.filter((k) => active[k]).length;

  const filterFields: FilterField[] = useMemo(
    () => [
      {
        key: "stage",
        label: "Stage",
        values: stages.map((s) => ({
          value: s.key,
          label: s.label,
          icon: <StageDot color={s.color} />,
          hint: num(counts.stage[s.key] ?? 0),
        })),
      },
      {
        key: "prio",
        label: "Fit",
        values: (Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => ({
          value: p,
          label: PRIORITY_LABEL[p],
          keywords: [p === "hot" ? "5" : p === "warm" ? "4" : p === "maybe" ? "3" : "0 1 2"],
          hint: num(counts.prioN[p] ?? 0),
        })),
      },
      {
        key: "type",
        label: "Type",
        values: (Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => ({
          value: t,
          label: t === "other" ? "Other / not set" : INVESTOR_TYPE_LABEL[t],
          hint: num(counts.typeN[t] ?? 0),
        })),
      },
      {
        key: "industry",
        label: "Industry",
        values: counts.industries.map((i) => ({ value: i.label, label: i.label, hint: num(i.n) })),
      },
      {
        key: "follow",
        label: "Follow-up",
        values: [
          { value: "due", label: "Due now", hint: num(counts.due) },
          { value: "week", label: "Due this week", hint: num(counts.week) },
          { value: "none", label: "No follow-up set", hint: num(counts.none) },
          { value: "quiet", label: "Gone quiet (14+ days)", hint: num(counts.quiet) },
        ],
      },
      {
        key: "owner",
        label: "Owner",
        values: [
          { value: "none", label: "No owner", hint: num(counts.ownerN.none ?? 0) },
          ...props.members.map((m) => ({
            value: m.user_id,
            label: m.is_you ? `${personName(m)} (you)` : personName(m),
            keywords: [m.email, ...(m.is_you ? ["me", "mine"] : [])],
            icon: <Avatar name={personName(m)} />,
            hint: num(counts.ownerN[m.user_id] ?? 0),
          })),
        ],
      },
      {
        key: "tag",
        label: "Tag",
        values: counts.tags.map((t) => ({ value: t.label, label: t.label, hint: num(t.n) })),
      },
      {
        key: "kind",
        label: "Stage kind",
        values: [
          { value: "open", label: "Not contacted yet" },
          { value: "active", label: "Talking" },
          { value: "won", label: "Committed" },
          { value: "lost", label: "Passed" },
        ],
      },
    ],
    [stages, counts, props.members],
  );

  const clearFilters = () => {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = null;
    setQText("");
    setParams({ q: null, prio: null, type: null, industry: null, follow: null, owner: null, stage: null, tag: null, kind: null });
  };

  /* ---------- saved views (P2-1): built-ins plus the founder's own, per round ---------- */
  const me = props.members.find((m) => m.is_you);
  const VIEWS_KEY = `rb-views:${workspace.slug}:${round.id}`;
  const [saved, setSaved] = useState<SavedView[]>([]);
  useEffect(() => setSaved(readJson<SavedView[]>(VIEWS_KEY, [])), [VIEWS_KEY]);
  const storeSaved = (next: SavedView[]) => {
    setSaved(next);
    writeStore(VIEWS_KEY, JSON.stringify(next));
  };
  const builtins: SavedView[] = useMemo(
    () => [
      { id: "all", name: "All", query: "", builtin: true },
      { id: "due", name: "Due now", query: "follow=due", builtin: true },
      ...(me ? [{ id: "mine", name: "My investors", query: `owner=${me.user_id}`, builtin: true }] : []),
      { id: "hot", name: "Hot", query: "prio=hot", builtin: true },
    ],
    [me],
  );
  const allViews = useMemo(() => [...builtins, ...saved], [builtins, saved]);
  const currentQuery = (keys: readonly string[]) => normQuery(params, keys);
  const activeView =
    saved.find((v) => normQuery(new URLSearchParams(v.query), VIEW_KEYS) === currentQuery(VIEW_KEYS)) ??
    builtins.find((v) => normQuery(new URLSearchParams(v.query), FILTER_PARAMS) === currentQuery(FILTER_PARAMS));
  const applyView = (v: SavedView) => {
    const next = new URLSearchParams(v.query);
    const patch: Record<string, string | null> = {};
    for (const k of v.builtin ? FILTER_PARAMS : VIEW_KEYS) patch[k] = next.get(k);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = null;
    setQText(next.get("q") ?? "");
    setParams(patch);
    if (!v.builtin) {
      const nv = (next.get("view") as View | null) ?? view;
      if (nv === "board" || nv === "table") {
        setStoredView(nv);
        writeStore(VIEW_KEY(workspace.slug, round.id), nv);
      }
      if (v.density) setDensity(nv, v.density);
      if (v.hidden) {
        setHidden(new Set(v.hidden));
        writeStore(COLS_KEY(workspace.slug, round.id), JSON.stringify(v.hidden));
      }
    }
  };
  const [viewDialog, setViewDialog] = useState<null | { mode: "save" } | { mode: "rename"; id: string }>(null);
  const suggestViewName = () => {
    const parts = filterFields
      .filter((f) => active[f.key])
      .map((f) => f.values.find((x) => x.value === active[f.key])?.label ?? active[f.key]!);
    if (q) parts.push(`“${q}”`);
    return parts.join(" · ").slice(0, 40) || (view === "table" ? "Table" : "Board");
  };
  const saveView = (name: string) => {
    const query = currentQuery(VIEW_KEYS);
    const v: SavedView = {
      id: `v${Date.now().toString(36)}`,
      name,
      query: query ? `${query}${query.includes("view=") ? "" : `&view=${view}`}` : `view=${view}`,
      density: tableDensity,
      hidden: [...hidden],
    };
    storeSaved([...saved, v]);
    toast.show(`Saved the view “${name}”.`);
  };
  // ⌘⇧1…9. Enabled one tick after mount so these registrations come after the shell's ⌘1…9
  // (workspace switch), which would otherwise also match a shifted digit.
  const [viewKeysReady, setViewKeysReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setViewKeysReady(true), 0);
    return () => clearTimeout(t);
  }, []);
  for (let i = 0; i < 9; i++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useHotkey(`mod+shift+${i + 1}`, () => allViews[i] && applyView(allViews[i]!), {
      enabled: viewKeysReady && participants.length > 0 && Boolean(allViews[i]),
      blockedByModals: true,
      description: i === 0 ? "Switch saved view (1–9)" : undefined,
      group: "Pipeline",
    });
  }

  /* ---------- order (table sort, board columns) ---------- */
  const sortedRows = useMemo(() => sortParticipants(filtered, sortCol, sortDir), [filtered, sortCol, sortDir]);
  const boardColumns = useMemo(() => {
    const m: Record<string, Participant[]> = {};
    for (const s of stages) m[s.key] = [];
    for (const p of filtered) (m[p.stage.key] ??= []).push(p);
    return stages.map((s) => {
      const cards = sortCards(m[s.key] ?? [], boardSorts[s.key] ?? "fit");
      if (s.key !== oStage?.key || s.key !== dominantKey) return { stage: s, cards };
      // The dominant New column is grouped by priority (DECISION §5.4); keep the sort inside.
      const by: Record<string, Participant[]> = { hot: [], warm: [], maybe: [], low: [] };
      for (const p of cards) by[priorityFromFit(p.fit)]!.push(p);
      return { stage: s, cards: PRIORITY_ORDER.flatMap((pr) => by[pr]!) };
    });
  }, [stages, filtered, boardSorts, oStage, dominantKey]);
  const order = useMemo(
    () =>
      view === "table"
        ? sortedRows.map((p) => p.investor.id)
        : boardColumns.flatMap((c) => c.cards.map((p) => p.investor.id)),
    [view, sortedRows, boardColumns],
  );

  /* ---------- ledger (DECISION §5.1): a strip until money exists ---------- */
  const facts = useMemo(
    () => ledgerFacts(participants, oStage?.key ?? null, today, summary.round.target_close_on ?? round.target_close_on),
    [participants, oStage, today, summary.round.target_close_on, round.target_close_on],
  );
  const money = useMemo(() => hasMoney(participants), [participants]);
  const showStrip = !money && participants.length > 0;
  const startTriageOnScreen = showStrip && canWrite && Boolean(oStage) && openCount > 0;
  const onBucket = (b: NextUpBucket) => {
    if (b.id === "new") startTriage(b.hw > 0 ? "hw" : "all");
    else if (b.id === "ready") setParams({ stage: b.stageKey, kind: b.stageKey ? null : "open", follow: null });
    else if (b.id === "quiet") setParams({ follow: "quiet", kind: null, stage: null });
    else setParams({ follow: "none", kind: "active", stage: null });
  };

  /* ---------- the sheet ---------- */
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  const openInvestor = useCallback((id: string) => setParams({ investor: id }), [setParams]);
  // J / K walk the order the sheet was opened from, even when an edit takes the investor out
  // of the current filter (setting a follow-up from "Due now").
  // The list the investor was opened from: their board column, the phone's pill list, or the
  // table (critique 1: "102 of 411" from the Contacted column was the whole round).
  const [sheetOrder, setSheetOrder] = useState<string[] | null>(null);
  const phoneOrder = useRef<string[]>([]);
  const onPhoneList = useCallback((ids: string[]) => {
    phoneOrder.current = ids;
  }, []);
  useEffect(() => {
    if (openId && !sheetOrder) {
      const col = view === "board" ? boardColumns.find((c) => c.cards.some((p) => p.investor.id === openId)) : undefined;
      const list = phone ? phoneOrder.current : col ? col.cards.map((p) => p.investor.id) : order;
      setSheetOrder(list.includes(openId) ? list : order);
    }
    if (!openId && sheetOrder) setSheetOrder(null);
  }, [openId, order, sheetOrder, view, boardColumns, phone]);
  const orderRef = useRef(order);
  orderRef.current = order;
  const sheetOrderRef = useRef(sheetOrder);
  sheetOrderRef.current = sheetOrder;
  const dirty = useRef(false);
  const closeSheet = useCallback(() => {
    const id = new URLSearchParams(window.location.search).get("investor");
    setParams({ investor: null });
    if (id) {
      // Focus goes back to the row or card that was open, or, if it left the view, to the
      // next one that is still there.
      const now = new Set(orderRef.current);
      const walk = sheetOrderRef.current ?? orderRef.current;
      const at = walk.indexOf(id);
      const target = now.has(id)
        ? id
        : (walk.slice(at + 1).find((x) => now.has(x)) ?? [...walk.slice(0, Math.max(0, at))].reverse().find((x) => now.has(x)));
      if (target) setFocusReq((r) => ({ id: target, n: (r?.n ?? 0) + 1 }));
    }
    if (dirty.current) {
      dirty.current = false;
      backgroundRefresh(300);
    }
  }, [setParams, backgroundRefresh]);
  const navOrder = useMemo(() => {
    if (!sheetOrder) return order;
    const inRound = new Set(participants.map((p) => p.investor.id));
    return sheetOrder.filter((id) => inRound.has(id));
  }, [sheetOrder, order, participants]);

  /* ---------- "Get set up" (P2-4) ---------- */
  const SETUP_KEY = `rb-setup-dismissed:${workspace.slug}`;
  const [setupDismissed, setSetupDismissed] = useState(true);
  useEffect(() => setSetupDismissed(readStore(SETUP_KEY) === "1"), [SETUP_KEY]);
  const setupSteps = useMemo(() => {
    const keys = props.setup?.activeKeys ?? null;
    const invites = props.setup?.pendingInvites ?? 0;
    return [
      { key: "import", label: "Bring in your investor list", done: participants.length > 0 },
      { key: "invite", label: "Invite a co-founder", done: props.members.length > 1 || invites > 0 },
      { key: "agent", label: "Connect an agent", done: keys !== null && keys > 0, unknown: keys === null },
      { key: "followups", label: "Set your first follow-ups", done: participants.some((p) => p.follow_up_on) },
    ];
  }, [participants, props.members.length, props.setup]);
  const setupLeft = setupSteps.filter((x) => !x.done).length;
  const showSetup = canWrite && !setupDismissed && setupLeft > 0;
  const dismissSetup = () => {
    writeStore(SETUP_KEY, "1");
    setSetupDismissed(true);
  };

  const openParticipant = openId ? participants.find((p) => p.investor.id === openId) : undefined;
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const empty = participants.length === 0;

  /* ---------- selection and bulk actions (table) ---------- */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Rows that left the round leave the selection.
    setSelected((s) => {
      if (!s.size) return s;
      const ids = new Set(participants.map((p) => p.investor.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [participants]);
  const visibleIds = useMemo(() => new Set(filtered.map((p) => p.investor.id)), [filtered]);
  const hiddenSelected = useMemo(() => [...selected].filter((id) => !visibleIds.has(id)).length, [selected, visibleIds]);

  const runBulk = useCallback(
    async (
      body: BulkInput,
      opts: { done: (r: BulkResult) => string; undo?: () => BulkInput[] | null; optimistic?: (p: Participant) => Participant },
    ): Promise<boolean> => {
      const ids = "investor_ids" in body ? new Set(body.investor_ids) : null;
      const before = participantsRef.current;
      const pending = cache.current!.pending;
      if (opts.optimistic && ids) {
        for (const id of ids) pending.add(id);
        setParticipants((list) => list.map((p) => (ids.has(p.investor.id) ? opts.optimistic!(p) : p)));
      }
      const settle = () => {
        if (ids) for (const id of ids) pending.delete(id);
      };
      const undoBodies = opts.undo?.() ?? null;
      try {
        const r = await bulkUpdateParticipants(client, round.id, body);
        settle();
        const c = cache.current!;
        const now = Date.now();
        for (const p of r.participants) c.written.set(p.investor.id, now);
        for (const id of r.removed) c.removed.set(id, now);
        const byId = new Map(r.participants.map((p) => [p.investor.id, p]));
        const gone = new Set(r.removed);
        setParticipants((list) => {
          const next = list.filter((p) => !gone.has(p.investor.id)).map((p) => byId.get(p.investor.id) ?? p);
          for (const p of r.participants) if (!list.some((x) => x.investor.id === p.investor.id)) next.push(p);
          return next;
        });
        const msg = opts.done(r);
        setAnnounce(msg);
        toast.show(
          msg,
          undoBodies && r.changed > 0
            ? {
                label: "Undo",
                onClick: () =>
                  void (async () => {
                    for (const b of undoBodies) await runBulkRef.current(b, { done: () => "Undone." });
                  })(),
              }
            : undefined,
        );
        afterWrite();
        return true;
      } catch (err) {
        settle();
        if (opts.optimistic) setParticipants((list) => list.map((p) => before.find((b) => b.investor.id === p.investor.id) ?? p));
        toast.show(`Nothing was changed. ${errorMessage(err)}`);
        return false;
      }
    },
    [client, round.id, toast, afterWrite, setParticipants],
  );
  const runBulkRef = useRef(runBulk);
  runBulkRef.current = runBulk;

  const selectedRows = () => participantsRef.current.filter((p) => selected.has(p.investor.id));
  const n = selected.size;
  const plural = (k: number) => `${num(k)} ${k === 1 ? "investor" : "investors"}`;

  const bulkMove = (key: string, ids?: string[]) => {
    const to = stages.find((s) => s.key === key);
    const pick = ids ? new Set(ids) : null;
    const rows = pick ? participantsRef.current.filter((p) => pick.has(p.investor.id) && p.stage.key !== key) : selectedRows();
    if (!to || !rows.length) return;
    void runBulk(
      { op: "stage", investor_ids: rows.map((p) => p.investor.id), stage: key },
      {
        optimistic: (p) => ({ ...p, stage: to }),
        done: (r) => `${plural(r.changed)} moved to ${to.label}.`,
        undo: () => [{ op: "restore", items: rows.map((p) => ({ investor_id: p.investor.id, stage: p.stage.key })) }],
      },
    );
  };
  const bulkFollowUp = (iso: string | null) => {
    const rows = selectedRows();
    if (!rows.length) return;
    void runBulk(
      { op: "follow_up", investor_ids: rows.map((p) => p.investor.id), follow_up_on: iso },
      {
        done: (r) =>
          iso ? `Follow-up set to ${formatDate(iso, today)} for ${plural(r.changed)}.` : `Follow-up cleared for ${plural(r.changed)}.`,
        undo: () => [
          {
            op: "restore",
            items: rows.map((p) => ({
              investor_id: p.investor.id,
              follow_up_on: p.follow_up_on ?? null,
              follow_up_note: p.follow_up_note ?? null,
            })),
          },
        ],
      },
    );
  };
  const bulkOwner = (userId: string | null) => {
    const rows = selectedRows();
    const m = props.members.find((x) => x.user_id === userId);
    if (!rows.length) return;
    void runBulk(
      { op: "owner", investor_ids: rows.map((p) => p.investor.id), owner_user_id: userId },
      {
        optimistic: (p) => ({ ...p, owner: m ? { user_id: m.user_id, name: m.name, email: m.email } : null }),
        done: (r) => (m ? `${personName(m)} now owns ${plural(r.changed)}.` : `Owner removed from ${plural(r.changed)}.`),
        undo: () => [
          { op: "restore", items: rows.map((p) => ({ investor_id: p.investor.id, owner_user_id: p.owner?.user_id ?? null })) },
        ],
      },
    );
  };
  const bulkFit = (fit: number) => {
    const rows = selectedRows();
    if (!rows.length) return;
    void runBulk(
      { op: "fit", investor_ids: rows.map((p) => p.investor.id), fit },
      {
        optimistic: (p) => ({ ...p, fit, priority: priorityFromFit(fit) }),
        done: (r) => `Fit set to ${fit}/5 for ${plural(r.changed)}.`,
        undo: () => [{ op: "restore", items: rows.map((p) => ({ investor_id: p.investor.id, fit: p.fit })) }],
      },
    );
  };
  const bulkTag = (t: string, add: boolean) => {
    const rows = selectedRows();
    const has = (p: Participant) => (p.investor.tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase());
    const affected = rows.filter((p) => (add ? !has(p) : has(p))).map((p) => p.investor.id);
    if (!rows.length) return;
    void runBulk(
      { op: add ? "add_tag" : "remove_tag", investor_ids: rows.map((p) => p.investor.id), tag: t },
      {
        done: (r) => (add ? `Tagged ${plural(r.changed)} “${t}”.` : `Removed “${t}” from ${plural(r.changed)}.`),
        undo: () => (affected.length ? [{ op: add ? "remove_tag" : "add_tag", investor_ids: affected, tag: t }] : null),
      },
    );
  };
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const bulkRemove = async () => {
    const rows = selectedRows();
    if (!rows.length) return;
    setRemoveBusy(true);
    const items: BulkItem[] = rows.map((p) => ({
      investor_id: p.investor.id,
      stage: p.stage.key,
      fit: p.fit,
      probability: p.probability ?? null,
      amount_soft: p.amount_soft ?? null,
      amount_committed: p.amount_committed ?? null,
      committed_on: p.committed_on ?? null,
      follow_up_on: p.follow_up_on ?? null,
      follow_up_note: p.follow_up_note ?? null,
      next_step: p.next_step ?? null,
      owner_user_id: p.owner?.user_id ?? null,
    }));
    const ok = await runBulk(
      { op: "remove", investor_ids: rows.map((p) => p.investor.id) },
      {
        done: (r) => `${plural(r.removed.length)} removed from ${round.name}. Their contacts stay.`,
        undo: () => [{ op: "restore", items }],
      },
    );
    setRemoveBusy(false);
    if (ok) {
      setConfirmRemove(false);
      setSelected(new Set());
    }
  };
  const exportSelected = () => {
    const rows = sortParticipants(selectedRows(), sortCol, sortDir);
    const header = ["Name", "Firm", "Title", "Type", "Email", "Stage", "Fit", "Follow up", "Follow-up note", "Soft", "Committed", "Owner", "Next step", "Tags"];
    const body = rows.map((p) => [
      p.investor.name,
      p.investor.firm,
      p.investor.title,
      INVESTOR_TYPE_LABEL[p.investor.type],
      p.investor.email,
      p.stage.label,
      p.fit,
      p.follow_up_on,
      p.follow_up_note,
      p.amount_soft,
      p.amount_committed,
      p.owner ? personName(p.owner) : "",
      p.next_step,
      p.investor.tags,
    ]);
    downloadText(`${round.slug}-${rows.length}-investors.csv`, toCsv(header, body));
    toast.show(`Exported ${plural(rows.length)}.`);
  };
  const [tagDialog, setTagDialog] = useState<null | "add" | "remove">(null);

  /* ---------- Triage's window into the store ---------- */
  const triageStore: TriageStore = useMemo(
    () => ({
      apply: (ids, fn) => {
        const set = new Set(ids);
        for (const id of ids) cache.current!.pending.add(id);
        setParticipants((list) => list.map((p) => (set.has(p.investor.id) ? fn(p) : p)));
      },
      commit: (rows) => {
        for (const p of rows) cache.current!.pending.delete(p.investor.id);
        for (const p of rows) patchParticipant(p);
      },
      rollback: (prev) => {
        const m = new Map(prev.map((p) => [p.investor.id, p]));
        for (const id of m.keys()) cache.current!.pending.delete(id);
        setParticipants((list) => list.map((p) => m.get(p.investor.id) ?? p));
      },
      afterWrite,
      announce: setAnnounce,
    }),
    [setParticipants, patchParticipant, afterWrite],
  );
  const tqRaw = get("tq");
  const tq: TriageSlice = tqRaw === "hw" || tqRaw === "maybe" || tqRaw === "low" ? tqRaw : "all";
  const setCursor = useCallback((id: string | null) => setParams({ at: id }), [setParams]);

  /* ---------- keyboard and palette ---------- */
  const isNarrow = useMediaQuery("(max-width: 899px)");
  // ≥1280px the sheet is a split panel: the list stays usable and follows the keyboard (P2-3).
  const split = useMediaQuery("(min-width: 1280px)") === true;
  const splitOpen = split && Boolean(openId) && view !== "triage";
  const working = !empty && view !== "triage";
  useHotkey("/", () => searchRef.current?.focus(), {
    description: "Search this round",
    group: "Pipeline",
    blockedByModals: true,
    enabled: working,
  });
  useHotkey("f", () => filterRef.current?.open(), {
    description: "Filter",
    group: "Pipeline",
    blockedByModals: true,
    enabled: working,
  });
  useHotkey("c", () => setAdding(true), {
    description: "Add investor",
    group: "Pipeline",
    blockedByModals: true,
    enabled: canWrite,
  });
  useHotkey("t", () => setView("triage"), {
    description: `Triage ${oStage?.label ?? "New"}`,
    group: "Pipeline",
    blockedByModals: true,
    enabled: working && !phone && triageOk && openCount > 0,
  });
  useHotkey("escape", () => setSelected(new Set()), {
    blockedByModals: true,
    enabled: n > 0 && view !== "triage",
  });
  const [bulkMenu, setBulkMenu] = useState<null | "move" | "follow">(null);
  useHotkey("m", () => setBulkMenu("move"), {
    description: "Move the selection to…",
    group: "Pipeline",
    blockedByModals: true,
    enabled: n > 0 && canWrite && view !== "triage",
  });
  useHotkey("d", () => setBulkMenu("follow"), {
    description: "Follow-up for the selection",
    group: "Pipeline",
    blockedByModals: true,
    enabled: n > 0 && canWrite && view !== "triage",
  });
  useCommands(
    "pipeline",
    useMemo(
      () => [
        ...(canWrite ? [{ id: "investor.new", label: "New investor", group: round.name, kbd: "c", run: () => setAdding(true) }] : []),
        ...(triageOk && openCount > 0 && view !== "triage"
          ? [{ id: "pipeline.triage", label: `Triage ${oStage?.label ?? "New"}`, group: round.name, kbd: "t", run: () => setView("triage") }]
          : []),
        ...(view !== "board" ? [{ id: "pipeline.board", label: "Show as board", group: round.name, run: () => setView("board") }] : []),
        ...(view !== "table" ? [{ id: "pipeline.table", label: "Show as table", group: round.name, run: () => setView("table") }] : []),
        {
          id: "pipeline.due",
          label: "Show follow-ups due now",
          group: round.name,
          run: () => setParams({ follow: "due", ...(view === "triage" ? { view: "board" } : {}) }),
        },
        ...(activeFilters || q ? [{ id: "pipeline.clear", label: "Clear filters", group: round.name, run: clearFilters }] : []),
      ],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [canWrite, round.name, view, activeFilters, q, triageOk, openCount],
    ),
  );

  /* ---------- fill the viewport: the page stops, the columns or rows scroll ---------- */
  const surfaceRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const workRef = useRef<HTMLDivElement>(null);
  const [stickyTop, setStickyTop] = useState(0);
  const [fill, setFill] = useState<number | null>(null);
  // The width the page has (not the viewport: the split sheet takes 512px of it). The title
  // row, ledger and table adapt to this, so nothing truncates when the sheet opens.
  const [headW, setHeadW] = useState(1392);
  const [endSlot, setEndSlot] = useState<HTMLElement | null>(null);
  const [eatBottom, setEatBottom] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector<HTMLElement>("body header.sticky");
      const top = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
      const main = surfaceRef.current?.closest("main");
      const pb = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      // Keep a 12px gap under the board: the shell's bottom padding is taken back.
      const gap = Math.min(pb, 12);
      setEatBottom(Math.max(0, pb - gap));
      setStickyTop(top);
      const workTop = workRef.current ? workRef.current.getBoundingClientRect().top + window.scrollY : top + 200;
      setFill(Math.max(420, Math.floor(window.innerHeight - workTop - gap)));
      if (headRef.current) setHeadW(Math.round(headRef.current.clientWidth));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (headRef.current) ro?.observe(headRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [empty, view, phone, splitOpen]);

  const viewOptions: MenuEntry[] =
    view === "table"
      ? [
          { type: "label", label: "Density" },
          { label: "Compact rows", selected: tableDensity === "compact", onSelect: () => setDensity("table", "compact") },
          { label: "Comfortable rows", selected: tableDensity === "comfortable", onSelect: () => setDensity("table", "comfortable") },
          { type: "separator" },
          { type: "label", label: "Columns" },
          ...TABLE_COLS.filter((c) => !c.required).map((c) => ({
            label: c.label,
            selected: visible.has(c.key),
            // On but not on screen: empty for these rows, or no room at this width.
            hint: visible.has(c.key) && shownCols && !shownCols.has(c.key) ? "hidden" : undefined,
            onSelect: () => toggleCol(c.key),
          })),
        ]
      : [
          { type: "label", label: "Cards" },
          { label: "Show next step", selected: showStep, onSelect: toggleStep },
        ];

  const mobileFilters = (
    <>
      {filterFields.map((f) => (
        <Field key={f.key} label={f.label}>
          <Select value={active[f.key] ?? ""} onChange={(e) => setParams({ [f.key]: e.target.value || null })}>
            <option value="">Any</option>
            {f.values.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
      ))}
    </>
  );

  const countText =
    filtered.length !== participants.length
      ? `${num(filtered.length)} of ${num(participants.length)}`
      : Object.keys(stageN).length === 1 && oStage && stageN[oStage.key]
        ? `${num(participants.length)} in ${oStage.label}`
        : `${num(participants.length)} investors`;

  const viewSegment =
    empty ? null : (
      <Segmented
        label="View"
        value={view}
        onChange={setView}
        className="self-center"
        options={[
          ...(triageOk
            ? [
                {
                  value: "triage" as View,
                  label: (
                    <span className="inline-flex items-baseline gap-6" title="Triage (T)">
                      Triage <span className={cn("font-mono text-[11.5px]", view === "triage" ? "text-canvas" : "text-muted")}>{num(openCount)}</span>
                    </span>
                  ),
                },
              ]
            : []),
          { value: "board" as View, label: "Board" },
          { value: "table" as View, label: "Table" },
        ]}
      />
    );

  const setupNode =
    showSetup && !phone ? (
      <SetupMenu
        steps={setupSteps}
        base={base}
        roundSlug={round.slug}
        onDismiss={dismissSetup}
        onFollowUps={() => setParams({ follow: "none", view: view === "triage" ? "board" : view })}
      />
    ) : null;

  const bulkBar =
    n > 0 && canWrite && view !== "triage" ? (
      <BulkBar
        count={n}
        hiddenCount={hiddenSelected}
        stages={stages}
        members={props.members}
        today={today}
        openMenu={bulkMenu}
        onMenuChange={setBulkMenu}
        onMove={(k: string) => bulkMove(k)}
        onFollowUp={bulkFollowUp}
        onOwner={bulkOwner}
        onFit={bulkFit}
        onTag={(mode) => setTagDialog(mode)}
        onRemove={() => setConfirmRemove(true)}
        onExport={exportSelected}
        onClear={() => setSelected(new Set())}
      />
    ) : null;

  return (
    <div
      ref={surfaceRef}
      className="flex flex-col gap-14"
      style={{
        ...(eatBottom && !phone ? { marginBottom: -eatBottom } : null),
        ...(splitOpen ? { paddingRight: SHEET_W - 8 } : null),
      }}
    >
      {phone ? (
        empty ? null : (
          <PipelinePhone
            round={round}
            stages={stages}
            rows={filtered}
            all={participants}
            openKey={oStage?.key ?? null}
            facts={facts}
            moneyOn={money}
            today={today}
            canWrite={canWrite}
            triageOk={triageOk && openCount > 0}
            stage={stageFilter}
            dueOnly={follow === "due"}
            dueTotal={counts.due}
            selected={canWrite ? selected : null}
            onSelectedChange={setSelected}
            onStage={(k) => setParams({ stage: k, follow: null })}
            onDue={() => setParams({ follow: "due", stage: null })}
            onBucket={onBucket}
            onOpen={openInvestor}
            onStartTriage={() => startTriage()}
            onFilters={() => setFiltersOpen(true)}
            activeFilters={activeFilters}
            search={qText}
            onSearch={onSearch}
            base={base}
            onListChange={onPhoneList}
          />
        )
      ) : (
        <div ref={headRef} className="flex flex-col gap-14">
          <RoundHeader wsSlug={workspace.slug} round={round} active="pipeline" className="mb-0 flex-nowrap items-center">
            {viewSegment}
            {autoTriage && triageNote && headW >= 1180 ? (
              <span className="t-micro min-w-0 truncate text-muted">
                {openCount === participants.length
                  ? `All ${num(openCount)} are ${oStage?.label ?? "New"}, so the round opens in Triage.`
                  : `${num(openCount)} of ${num(participants.length)} are ${oStage?.label ?? "New"}, so the round opens in Triage.`}
              </span>
            ) : null}
            {!empty && view !== "triage" ? (
              <ViewTabs
                views={allViews}
                activeId={activeView?.id ?? null}
                dueCount={counts.due}
                onSelect={applyView}
                onSave={() => setViewDialog({ mode: "save" })}
                onRename={(id) => setViewDialog({ mode: "rename", id })}
                onDelete={(id) => {
                  const v = saved.find((x) => x.id === id);
                  storeSaved(saved.filter((x) => x.id !== id));
                  if (v) toast.show(`Deleted the view “${v.name}”.`, { label: "Undo", onClick: () => storeSaved([...saved]) });
                }}
              />
            ) : null}
            {setupNode ? <span className="ml-auto shrink-0">{setupNode}</span> : null}
            {view === "triage" && canWrite ? (
              <Button size="sm" onClick={() => setAdding(true)} kbd="C" aria-keyshortcuts="C" className={cn("shrink-0", setupNode ? undefined : "ml-auto")}>
                Add investor
              </Button>
            ) : null}
          </RoundHeader>

          {working ? (
            showStrip ? (
              <LedgerStrip
                round={round}
                facts={facts}
                openLabel={oStage?.label ?? "New"}
                today={today}
                canWrite={canWrite && Boolean(oStage)}
                width={headW}
                onStartTriage={() => startTriage(facts.hwOpen > 0 ? "hw" : "all")}
              />
            ) : (
              <LedgerDesk
                round={round}
                rows={participants}
                facts={facts}
                openKey={oStage?.key ?? null}
                openLabel={oStage?.label ?? "New"}
                today={today}
                nowMs={serverAt || Date.now()}
                canWrite={canWrite}
                width={headW}
                onOpen={openInvestor}
                onDueAll={() => setParams({ follow: "due", stage: null, kind: null })}
                onBucket={onBucket}
              />
            )
          ) : null}

          {working ? (
            <div data-pipeline-toolbar className="flex flex-col gap-8">
              <div className="flex items-center gap-8 max-lg:flex-wrap" role="search" aria-label="Filter investors">
                <div className="relative flex min-w-0 flex-[1_1_220px]">
                  <SearchInput
                    ref={searchRef}
                    placeholder={headW < 1000 ? "Search…" : "Search name, firm, focus, notes…"}
                    aria-label="Search investors in this round"
                    aria-keyshortcuts="/"
                    value={qText}
                    onChange={(e) => onSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        if (qText) onSearch("");
                        else e.currentTarget.blur();
                      }
                    }}
                    className="pr-28"
                  />
                  {qText ? null : <Kbd className="pointer-events-none absolute top-7 right-8">/</Kbd>}
                </div>
                <FilterMenu
                  ref={filterRef}
                  fields={filterFields}
                  active={active}
                  onChange={(k, v) => setParams({ [k]: v })}
                  onOpenRequest={() => {
                    if (!isNarrow) return false;
                    setFiltersOpen(true);
                    return true;
                  }}
                />
                <Menu
                  label="Display options"
                  align="end"
                  trigger="Display"
                  triggerClassName="inline-flex h-32 items-center gap-6 rounded-sm border border-line bg-surface px-10 text-fg hover:border-muted"
                  items={viewOptions}
                />
                <span className="t-micro whitespace-nowrap text-muted" aria-live="polite">
                  {n > 0 ? `${num(n)} selected · ` : ""}
                  {countText}
                </span>
                {view === "board" ? <span ref={setEndSlot} className="inline-flex shrink-0 empty:hidden" /> : null}
                {canWrite ? (
                  <Button
                    variant={startTriageOnScreen ? "secondary" : "primary"}
                    className="ml-auto"
                    onClick={() => setAdding(true)}
                    title="Add investor (C)"
                    kbd="C"
                    aria-keyshortcuts="C"
                  >
                    Add investor
                  </Button>
                ) : null}
              </div>
              <FilterChips
                fields={filterFields}
                active={active}
                onRemove={(k) => setParams({ [k]: null })}
                onClear={clearFilters}
                focusAfterRemove={filterBtnFocus}
                extra={
                  q
                    ? [
                        {
                          key: "q",
                          label: `Matches “${q}”`,
                          onRemove: () => {
                            setQText("");
                            setParams({ q: null });
                          },
                        },
                      ]
                    : undefined
                }
              />
              {filtered.length === 0 ? (
                <p className="t-body-s text-muted" role="status">
                  No investors match these filters.{" "}
                  <button type="button" className="link border-0 bg-transparent p-0" onClick={clearFilters}>
                    Clear filters
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {empty ? (
        <>
          {phone ? <h1 className="t-display-s">{round.name}</h1> : null}
          <EmptyState
            title={`No investors in ${round.name} yet`}
            actions={
              <>
                {canWrite ? <ButtonLink href={`${base}/import?round=${encodeURIComponent(round.slug)}`}>Import CSV</ButtonLink> : null}
                {canWrite ? (
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    Add investor
                  </Button>
                ) : null}
                <ButtonLink variant="ghost" href={`${base}/settings/mcp`}>
                  Connect an agent →
                </ButtonLink>
              </>
            }
          >
            Import a spreadsheet, add them one at a time, or ask your agent.
          </EmptyState>
          {showSetup ? <SetupChecklist steps={setupSteps} base={base} roundSlug={round.slug} onDismiss={dismissSetup} /> : null}
        </>
      ) : view === "triage" && oStage ? (
        <div ref={workRef}>
          <PipelineTriage
            round={round}
            stages={stages}
            rows={participants}
            matches={matches}
            extras={extras}
            agentMarks={agentMarks}
            today={today}
            timeZone={tz}
            client={client}
            wsSlug={workspace.slug}
            canWrite={canWrite}
            openKey={oStage.key}
            slice={tq}
            at={get("at") || null}
            active={activeFilters}
            filterFields={filterFields}
            filterActive={active}
            onFilterChange={(k, v) => setParams({ [k]: v, at: null })}
            onSlice={(sl) => setParams({ tq: sl === "all" ? null : sl, at: null })}
            onCursor={setCursor}
            onOpenFile={openInvestor}
            onOpenBoard={() => setView("board")}
            onExit={() => setParams({ view: null, tq: null, at: null })}
            store={triageStore}
            keysEnabled={!openId}
          />
        </div>
      ) : phone ? null : (
        <div ref={workRef}>
          {view === "board" ? (
            <PipelineBoard
              round={round}
              stages={stages}
              columns={boardColumns}
              sorts={boardSorts}
              onSortChange={setBoardSort}
              agentMarks={agentMarks}
              today={today}
              canWrite={canWrite}
              showNextStep={showStep}
              filtered={activeFilters > 0 || Boolean(query)}
              height={fill}
              openId={openId}
              focusReq={focusReq}
              openKey={oStage?.key ?? null}
              dominantKey={dominantKey}
              activePrio={prio}
              onPrioFilter={(pr) => setParams({ prio: pr })}
              onTriage={triageOk && openCount > 0 ? () => setView("triage") : undefined}
              selected={canWrite ? selected : null}
              onSelectedChange={setSelected}
              onOpen={openInvestor}
              onFocusMove={splitOpen ? openInvestor : undefined}
              onMove={doMove}
              onMoveMany={(ids, key) => bulkMove(key, ids)}
              endSlot={endSlot}
            />
          ) : (
            <PipelineTable
              round={round}
              rows={sortedRows}
              extras={extras}
              agentMarks={agentMarks}
              members={props.members}
              visible={visible}
              density={tableDensity}
              sort={sortCol}
              dir={sortDir}
              onSort={(c) =>
                setParams({
                  sort: c,
                  order: c === sortCol ? (sortDir === "asc" ? "desc" : "asc") : DEFAULT_DIR[c],
                })
              }
              onOpen={openInvestor}
              onFocusMove={splitOpen ? openInvestor : undefined}
              openId={openId}
              selected={canWrite ? selected : null}
              onSelectedChange={setSelected}
              height={fill}
              focusReq={focusReq}
              today={today}
              timeZone={tz}
              onShown={setShownCols}
            />
          )}
        </div>
      )}

      {bulkBar}

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <InvestorSheet
        open={Boolean(openId)}
        investorId={openId}
        client={client}
        wsSlug={workspace.slug}
        round={round}
        participant={openParticipant}
        members={props.members}
        today={today}
        timeZone={tz}
        canWrite={canWrite}
        order={view === "triage" ? undefined : navOrder}
        onNavigate={openInvestor}
        modal={!split || view === "triage"}
        top={stickyTop}
        onClose={closeSheet}
        onParticipantChange={(p) => {
          dirty.current = true;
          patchParticipant(p);
        }}
        onInvestorChange={(inv) => {
          dirty.current = true;
          setParticipants((list) =>
            list.map((p) =>
              p.investor.id === inv.id
                ? { ...p, investor: { ...p.investor, name: inv.name, firm: inv.firm, title: inv.title, type: inv.type, tags: inv.tags } }
                : p,
            ),
          );
          setExtras((e) => ({ ...e, [inv.id]: { industries: inv.industries, search: e[inv.id]?.search ?? "" } }));
        }}
        onChanged={() => {
          dirty.current = true;
          void refreshSummary();
        }}
        onStageMove={doMove}
      />

      <AddInvestorDialog
        open={adding}
        onClose={() => setAdding(false)}
        client={client}
        wsSlug={workspace.slug}
        round={round}
        onOpen={openInvestor}
        onAdded={(inv, part) => {
          setExtras((e) => ({ ...e, [inv.id]: { industries: inv.industries, search: (inv.location ?? "").toLowerCase() } }));
          if (part) patchParticipant(part);
          afterWrite();
        }}
      />

      <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        <div className="flex flex-col gap-10">{mobileFilters}</div>
        <div className="flex gap-8">
          <Button variant="primary" onClick={() => setFiltersOpen(false)}>
            Show {num(filtered.length)} investors
          </Button>
          {activeFilters ? (
            <Button variant="ghost" onClick={clearFilters}>
              Clear
            </Button>
          ) : null}
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        busy={removeBusy}
        busyLabel="Removing…"
        title={`Remove ${plural(n)} from ${round.name}?`}
        confirmLabel={`Remove ${plural(n)}`}
        onConfirm={() => void bulkRemove()}
      >
        <p>Their contacts, notes and timelines stay. You can undo this right after.</p>
      </ConfirmDialog>

      <NameDialog
        open={viewDialog !== null}
        title={viewDialog?.mode === "rename" ? "Rename view" : "Save this view"}
        hint="Filters, search, sort, view, density and columns. Saved in this browser."
        initial={
          viewDialog?.mode === "rename" ? (saved.find((v) => v.id === viewDialog.id)?.name ?? "") : viewDialog ? suggestViewName() : ""
        }
        submitLabel={viewDialog?.mode === "rename" ? "Rename" : "Save view"}
        onClose={() => setViewDialog(null)}
        onSubmit={(name) => {
          if (viewDialog?.mode === "rename") storeSaved(saved.map((v) => (v.id === viewDialog.id ? { ...v, name } : v)));
          else saveView(name);
          setViewDialog(null);
        }}
      />

      <TagDialog
        mode={tagDialog}
        count={n}
        suggestions={counts.tags.map((t) => t.label)}
        onClose={() => setTagDialog(null)}
        onSubmit={(t, add) => {
          setTagDialog(null);
          bulkTag(t, add);
        }}
      />
    </div>
  );
}

/* ---------- saved views ---------- */

function ViewTabs({
  views,
  activeId,
  dueCount = 0,
  onSelect,
  onSave,
  onRename,
  onDelete,
}: {
  views: SavedView[];
  activeId: string | null;
  /** "Due now 5": mono bad-ink, hidden at 0. */
  dueCount?: number;
  onSelect: (v: SavedView) => void;
  onSave: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const current = views.find((v) => v.id === activeId);
  const own = views.filter((v) => !v.builtin);
  const mod = typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘⇧" : "Ctrl+Shift+";
  return (
    <div className="flex min-w-0 shrink items-center gap-6 self-center">
      <div role="group" aria-label="Views" className="flex min-w-0 items-center gap-2 overflow-x-auto rounded-pill bg-sunk p-2 scrollbar-none">
        {views.map((v, i) => {
          const on = v.id === activeId;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(v)}
              title={i < 9 ? `${v.name} (${mod}${i + 1})` : v.name}
              className={cn(
                "h-26 shrink-0 rounded-pill border-0 px-10 text-sm whitespace-nowrap transition-colors duration-[120ms]",
                on ? "bg-surface font-medium text-fg shadow-pill" : "bg-transparent text-muted hover:text-fg",
              )}
            >
              {v.name}
              {v.id === "due" && dueCount > 0 ? <span className="ml-6 font-mono text-[11.5px] text-bad">{num(dueCount)}</span> : null}
            </button>
          );
        })}
      </div>
      <Menu
        label="View actions"
        align="start"
        trigger={<span aria-hidden>⋯</span>}
        triggerClassName="inline-flex size-26 items-center justify-center rounded-pill border-0 bg-transparent text-muted hover:bg-sunk hover:text-fg"
        items={[
          { label: "Save current view…", onSelect: onSave },
          ...(current && !current.builtin
            ? ([
                { type: "separator" },
                { label: `Rename “${current.name}”…`, onSelect: () => onRename(current.id) },
                { label: `Delete “${current.name}”`, danger: true, onSelect: () => onDelete(current.id) },
              ] as MenuEntry[])
            : own.length
              ? ([{ type: "separator" }, { type: "label", label: "Open a saved view to rename or delete it" }] as MenuEntry[])
              : []),
        ]}
      />
    </div>
  );
}

function NameDialog({
  open,
  title,
  hint,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  hint?: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const t = text.trim();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (t) onSubmit(t.slice(0, 40));
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!t}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <Field label="Name" hint={hint}>
        <Input autoFocus value={text} maxLength={40} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/* ---------- "Get set up" checklist ---------- */

function SetupChecklist({
  steps,
  base,
  roundSlug,
  onDismiss,
  onFollowUps,
  className,
}: {
  steps: { key: string; label: string; done: boolean; unknown?: boolean }[];
  base: string;
  roundSlug: string;
  onDismiss: () => void;
  onFollowUps?: () => void;
  className?: string;
}) {
  const href: Record<string, string> = {
    import: `${base}/import?round=${encodeURIComponent(roundSlug)}`,
    invite: `${base}/settings/members`,
    agent: `${base}/settings/mcp`,
  };
  const done = steps.filter((x) => x.done).length;
  const item = (x: (typeof steps)[number]) => (
    <li key={x.key} className="flex min-w-0 items-center gap-6">
      <span
        aria-hidden
        className={cn(
          "inline-flex size-16 shrink-0 items-center justify-center rounded-pill border text-[10px]",
          x.done ? "border-good bg-good-soft text-good-ink" : "border-line text-transparent",
        )}
      >
        ✓
      </span>
      {x.done ? (
        <span className="text-muted">{x.label}</span>
      ) : x.key === "followups" && onFollowUps ? (
        <button type="button" onClick={onFollowUps} className="link border-0 bg-transparent p-0 text-left">
          {x.label}
        </button>
      ) : href[x.key] ? (
        <Link href={href[x.key]!} className="link">
          {x.label}
        </Link>
      ) : (
        <span>{x.label}</span>
      )}
      <span className="sr-only">{x.done ? "(done)" : "(to do)"}</span>
    </li>
  );
  return (
    <section
      aria-label="Get set up"
      className={cn("flex flex-wrap items-center gap-x-18 gap-y-6 rounded-md border border-line bg-surface px-14 py-8", className)}
    >
      <span className="t-label">
        Get set up · {done}/{steps.length}
      </span>
      <ul className="t-body-s m-0 flex list-none flex-wrap gap-x-16 gap-y-4 p-0">{steps.map(item)}</ul>
      <button
        type="button"
        onClick={onDismiss}
        className="t-body-s ml-auto border-0 bg-transparent p-0 text-muted hover:text-fg"
        aria-label="Dismiss the setup checklist"
      >
        Dismiss
      </button>
    </section>
  );
}

/* ---------- "SET UP 2/4" in the title row (DECISION §5.1) ---------- */

function SetupMenu({
  steps,
  base,
  roundSlug,
  onDismiss,
  onFollowUps,
}: {
  steps: { key: string; label: string; done: boolean; unknown?: boolean }[];
  base: string;
  roundSlug: string;
  onDismiss: () => void;
  onFollowUps: () => void;
}) {
  const router = useRouter();
  const href: Record<string, string> = {
    import: `${base}/import?round=${encodeURIComponent(roundSlug)}`,
    invite: `${base}/settings/members`,
    agent: `${base}/settings/mcp`,
  };
  const done = steps.filter((x) => x.done).length;
  const go = (key: string) => (key === "followups" ? onFollowUps() : href[key] ? router.push(href[key]!) : undefined);
  return (
    <span className="inline-flex items-center gap-8 whitespace-nowrap">
      <Menu
        label="Get set up"
        align="end"
        minWidth={240}
        trigger={
          <span className="t-label">
            Set up {done}/{steps.length}
          </span>
        }
        triggerClassName="inline-flex h-28 items-center rounded-sm border-0 bg-transparent px-4 hover:bg-sunk"
        items={[
          { type: "label", label: `Get set up · ${done}/${steps.length}` },
          ...steps.map((x) => ({
            label: x.label,
            icon: <span aria-hidden className={cn("inline-flex w-14 justify-center text-[11px]", x.done ? "text-good-ink" : "text-faint")}>{x.done ? "✓" : "○"}</span>,
            disabled: x.done,
            onSelect: () => go(x.key),
          })),
          { type: "separator" },
          { label: "Dismiss", onSelect: onDismiss },
        ]}
      />
    </span>
  );
}

/* ---------- bulk bar (DECISION §5.6): pinned to the bottom of the work surface ---------- */

function BulkBar({
  count,
  hiddenCount,
  stages,
  members,
  today,
  openMenu,
  onMenuChange,
  onMove,
  onFollowUp,
  onOwner,
  onFit,
  onTag,
  onRemove,
  onExport,
  onClear,
}: {
  count: number;
  hiddenCount: number;
  stages: Round["stages"];
  members: Member[];
  today: string;
  openMenu: null | "move" | "follow";
  onMenuChange: (m: null | "move" | "follow") => void;
  onMove: (key: string) => void;
  onFollowUp: (iso: string | null) => void;
  onOwner: (userId: string | null) => void;
  onFit: (fit: number) => void;
  onTag: (mode: "add" | "remove") => void;
  onRemove: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useToastLift(ref, true);
  const trigger = "inline-flex h-30 items-center gap-6 rounded-sm border border-line bg-surface px-10 text-sm text-fg hover:border-muted";
  const keys = new Map(triageTargets(stages).map((t) => [t.stage.key, t.key]));
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom))] z-30 flex justify-center px-16">
      <div
        ref={ref}
        role="toolbar"
        aria-label={`Bulk actions for ${count} selected`}
        className="pointer-events-auto flex min-h-48 w-full max-w-[960px] flex-wrap items-center gap-6 rounded-md border border-line bg-surface px-12 py-8 shadow-menu"
      >
        <span className="t-body-s mr-6 font-semibold whitespace-nowrap text-fg">
          {num(count)} selected
          {hiddenCount ? <span className="font-normal text-muted"> ({num(hiddenCount)} hidden by filters)</span> : null}
        </span>
        <Menu
          label="Move to stage"
          trigger={
            <>
              Move to… <Kbd>M</Kbd>
            </>
          }
          triggerClassName={trigger}
          open={openMenu === "move"}
          onOpenChange={(o) => onMenuChange(o ? "move" : null)}
          items={[
            { type: "label", label: "Move to" },
            ...sortedStages(stages).map((s) => ({
              label: s.label,
              icon: <StageDot color={s.color} />,
              accel: keys.get(s.key) ?? undefined,
              onSelect: () => onMove(s.key),
            })),
          ]}
        />
        <Menu
          label="Set follow-up"
          trigger={
            <>
              Follow up <Kbd>D</Kbd>
            </>
          }
          triggerClassName={trigger}
          open={openMenu === "follow"}
          onOpenChange={(o) => onMenuChange(o ? "follow" : null)}
          items={[
            ...quickPicks("followup", today).map((p) => ({
              label: p.label,
              hint: formatDate(p.iso, today),
              accel: p.kbd,
              onSelect: () => onFollowUp(p.iso),
            })),
            { type: "separator" },
            { label: "Clear follow-up", onSelect: () => onFollowUp(null) },
          ]}
        />
        <Menu
          label="Assign owner"
          trigger="Owner"
          triggerClassName={trigger}
          items={[
            ...members.map((m) => ({
              label: m.is_you ? `${personName(m)} (you)` : personName(m),
              icon: <Avatar name={personName(m)} />,
              onSelect: () => onOwner(m.user_id),
            })),
            { type: "separator" },
            { label: "No owner", onSelect: () => onOwner(null) },
          ]}
        />
        <Menu
          label="Set fit"
          trigger="Fit"
          triggerClassName={trigger}
          items={[5, 4, 3, 2, 1, 0].map((f) => ({
            label: `${f}/5 · ${PRIORITY_LABEL[priorityFromFit(f)]}`,
            onSelect: () => onFit(f),
          }))}
        />
        <Menu
          label="Tags"
          trigger="Tag"
          triggerClassName={trigger}
          items={[
            { label: "Add a tag…", onSelect: () => onTag("add") },
            { label: "Remove a tag…", onSelect: () => onTag("remove") },
          ]}
        />
        <Menu
          label="More bulk actions"
          trigger="⋯"
          triggerClassName={trigger}
          items={[
            { label: "Export CSV", onSelect: onExport },
            { label: "Remove from round…", danger: true, onSelect: onRemove },
          ]}
        />
        <button
          type="button"
          onClick={onClear}
          className="t-body-s ml-auto inline-flex items-center gap-6 border-0 bg-transparent px-4 text-muted hover:text-fg"
          aria-label="Clear selection"
        >
          <Kbd>Esc</Kbd> Clear
        </button>
      </div>
    </div>
  );
}

function TagDialog({
  mode,
  count,
  suggestions,
  onClose,
  onSubmit,
}: {
  mode: null | "add" | "remove";
  count: number;
  suggestions: string[];
  onClose: () => void;
  onSubmit: (tag: string, add: boolean) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (mode) setText("");
  }, [mode]);
  const add = mode === "add";
  const t = text.trim();
  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      title={add ? `Tag ${count} ${count === 1 ? "investor" : "investors"}` : `Remove a tag from ${count}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (t) onSubmit(t, add);
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!t}>
            {add ? "Add tag" : "Remove tag"}
          </Button>
        </>
      }
    >
      <Field label="Tag" hint="Tags live on the contact, so they show in every round.">
        <Input
          autoFocus
          value={text}
          maxLength={40}
          list="rb-bulk-tags"
          placeholder="e.g. lead-capable"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <datalist id="rb-bulk-tags">
        {suggestions.slice(0, 50).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </Dialog>
  );
}
