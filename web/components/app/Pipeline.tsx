"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  ButtonLink,
  EmptyState,
  Kbd,
  Ledger,
  ledgerFromSummary,
  Menu,
  SearchInput,
  Segmented,
  Select,
  Sheet,
  useToast,
} from "@/components/ui";
import { listActivities } from "@/lib/api/activities";
import { errorMessage } from "@/lib/api/client";
import { listAllInvestors } from "@/lib/api/investors";
import {
  getRoundSummary,
  listAllParticipants,
  moveStage,
  sortedStages,
} from "@/lib/api/rounds";
import type {
  Activity,
  Investor,
  InvestorType,
  Member,
  Participant,
  Priority,
  Round,
  RoundSummary,
} from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL, PRIORITY_LABEL } from "@/lib/api/types";
import { num, priorityFromFit, relativeTime } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { AddInvestorDialog } from "./AddInvestorDialog";
import { InvestorSheet } from "./InvestorSheet";
import { PipelineBoard, type AgentMark } from "./PipelineBoard";
import { DEFAULT_DIR, PipelineTable, TABLE_COLS, type SortDir, type TableCol } from "./PipelineTable";
import { matchesQuery, participantSearchText, personName } from "./util";

type View = "board" | "table";
type FollowFilter = "" | "due" | "week" | "none";

const VIEW_KEY = (roundId: string) => `rb-view:${roundId}`;
const COLS_KEY = "rb-table-cols";
const DEFAULT_HIDDEN: TableCol[] = [];

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Agent actions in the last 24h, latest per investor (SYSTEM §2.5). */
export function agentMarksFrom(acts: Activity[], now = new Date()): Record<string, AgentMark> {
  const out: Record<string, AgentMark> = {};
  for (const a of acts) {
    if (a.actor.type !== "agent" || out[a.investor_id]) continue;
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
    out[a.investor_id] = { label: a.actor.label, tip: `${verb} by ${a.actor.label} ${relativeTime(a.occurred_at, now)}` };
  }
  return out;
}

export interface PipelineProps {
  round: Round;
  summary: RoundSummary;
  participants: Participant[];
  investors: Investor[];
  members: Member[];
  agentActivity: Activity[];
  today: string;
}

/**
 * The round's working surface (SYSTEM §4.2): compact ledger, toolbar, board or table, and the
 * investor sheet. Filters, view and the open investor live in the URL so views can be shared.
 */
export function Pipeline(props: PipelineProps) {
  const { workspace, client, canWrite } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const tz = workspace.timezone;
  const today = props.today;

  const [round, setRound] = useState(props.round);
  const [summary, setSummary] = useState(props.summary);
  const [participants, setParticipants] = useState(props.participants);
  const [investors, setInvestors] = useState<Record<string, Investor>>(() =>
    Object.fromEntries(props.investors.map((i) => [i.id, i])),
  );
  const [agentMarks, setAgentMarks] = useState(() => agentMarksFrom(props.agentActivity));
  const [announce, setAnnounce] = useState("");
  const [adding, setAdding] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    setRound(props.round);
    setSummary(props.summary);
    setParticipants(props.participants);
    setInvestors(Object.fromEntries(props.investors.map((i) => [i.id, i])));
    setAgentMarks(agentMarksFrom(props.agentActivity));
  }, [props.round, props.summary, props.participants, props.investors, props.agentActivity]);

  const stages = useMemo(() => sortedStages(round.stages), [round.stages]);

  /* ---------- URL state ---------- */
  const get = (k: string) => params.get(k) ?? "";
  const q = get("q");
  const prio = get("prio") as Priority | "";
  const type = get("type") as InvestorType | "";
  const industry = get("industry");
  const follow = get("follow") as FollowFilter;
  const owner = get("owner");
  const stageFilter = get("stage");
  const openId = params.get("investor");
  const sortCol = (TABLE_COLS.some((c) => c.key === get("sort")) ? get("sort") : "fit") as TableCol;
  const sortDir = (get("order") === "asc" || get("order") === "desc" ? get("order") : DEFAULT_DIR[sortCol]) as SortDir;

  const [view, setViewState] = useState<View>(() => (get("view") === "table" ? "table" : "board"));
  useEffect(() => {
    const v = params.get("view");
    if (v === "table" || v === "board") setViewState(v);
    else {
      const stored = readStore(VIEW_KEY(round.id));
      setViewState(stored === "table" ? "table" : "board");
    }
  }, [params, round.id]);

  const setParams = useCallback(
    (patch: Record<string, string | null>, mode: "replace" | "push" = "replace") => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") sp.delete(k);
        else sp.set(k, v);
      }
      const qs = sp.toString();
      const url = qs ? `${pathname}?${qs}` : (pathname ?? "");
      if (mode === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [params, pathname, router],
  );

  const setView = (v: View) => {
    setViewState(v);
    writeStore(VIEW_KEY(round.id), v);
    setParams({ view: v });
  };

  // Search: local text, URL updated after typing pauses.
  const [qText, setQText] = useState(q);
  useEffect(() => setQText(q), [q]);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setQText(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setParams({ q: v.trim() || null }), 250);
  };

  /* ---------- table columns ---------- */
  const [hidden, setHidden] = useState<Set<TableCol>>(new Set(DEFAULT_HIDDEN));
  useEffect(() => {
    const raw = readStore(COLS_KEY);
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as TableCol[];
      if (Array.isArray(arr)) setHidden(new Set(arr));
    } catch {
      /* ignore */
    }
  }, []);
  const visible = useMemo(
    () => new Set(TABLE_COLS.map((c) => c.key).filter((k) => !hidden.has(k))),
    [hidden],
  );
  const toggleCol = (k: TableCol) => {
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      writeStore(COLS_KEY, JSON.stringify([...n]));
      return n;
    });
  };

  /* ---------- data refresh ---------- */
  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await getRoundSummary(client, round.id));
    } catch {
      /* the ledger keeps its last numbers; the next write retries */
    }
  }, [client, round.id]);

  const refreshAll = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const [s, ps, invs, acts] = await Promise.all([
        getRoundSummary(client, round.id),
        listAllParticipants(client, round.id),
        listAllInvestors(client, { round: round.id }),
        listActivities(client, { round: round.id, actor_type: "agent", since, limit: 200 }),
      ]);
      setSummary(s);
      setParticipants(ps);
      setInvestors(Object.fromEntries(invs.data.map((i) => [i.id, i])));
      setAgentMarks(agentMarksFrom(acts.data));
    } catch (err) {
      toast.show(errorMessage(err));
    }
  }, [client, round.id, toast]);

  // Pick up agent work when the founder returns to the tab.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshAll]);

  const patchParticipant = useCallback((p: Participant) => {
    setParticipants((list) => list.map((x) => (x.investor.id === p.investor.id ? p : x)));
  }, []);

  /* ---------- moves (optimistic, with Undo) ---------- */
  const doMove = useCallback(
    async (investorId: string, key: string, opts: { undo?: boolean } = {}): Promise<boolean> => {
      const prev = participants.find((p) => p.investor.id === investorId);
      const to = stages.find((s) => s.key === key);
      if (!prev || !to || prev.stage.key === key) return false;
      const from = prev.stage;
      setParticipants((list) =>
        list.map((p) => (p.investor.id === investorId ? { ...p, stage: to } : p)),
      );
      try {
        const res = await moveStage(client, round.id, investorId, key);
        patchParticipant(res.participant);
        const msg = `${prev.investor.name} moved to ${to.label}.`;
        setAnnounce(msg);
        if (opts.undo === false) toast.show(msg);
        else
          toast.show(
            to.kind === "won" && !res.participant.amount_committed
              ? `${msg} Record the amount in their file.`
              : msg,
            { label: "Undo", onClick: () => void doMoveRef.current(investorId, from.key, { undo: false }) },
          );
        void refreshSummary();
        return true;
      } catch (err) {
        setParticipants((list) => list.map((p) => (p.investor.id === investorId ? prev : p)));
        toast.show(`${prev.investor.name} was not moved. ${errorMessage(err)}`);
        return false;
      }
    },
    [participants, stages, client, round.id, patchParticipant, toast, refreshSummary],
  );
  const doMoveRef = useRef(doMove);
  doMoveRef.current = doMove;

  /* ---------- filtering ---------- */
  const industries = useMemo(() => {
    const set = new Map<string, string>();
    for (const p of participants)
      for (const i of investors[p.investor.id]?.industries ?? []) set.set(i.toLowerCase(), i);
    return [...set.values()].sort((a, b) => a.localeCompare(b));
  }, [participants, investors]);

  const ownerOptions = useMemo(() => props.members, [props.members]);

  const filtered = useMemo(() => {
    return participants.filter((p) => {
      if (stageFilter && p.stage.key !== stageFilter) return false;
      if (prio && priorityFromFit(p.fit) !== prio) return false;
      if (type && p.investor.type !== type) return false;
      if (industry) {
        const inds = investors[p.investor.id]?.industries ?? [];
        if (!inds.some((i) => i.toLowerCase() === industry.toLowerCase())) return false;
      }
      if (follow) {
        const st = p.follow_up_state;
        if (follow === "none" && p.follow_up_on) return false;
        if (follow === "due" && st !== "overdue" && st !== "today") return false;
        if (follow === "week" && st !== "overdue" && st !== "today" && st !== "soon") return false;
      }
      if (owner === "none" && p.owner) return false;
      if (owner && owner !== "none" && p.owner?.user_id !== owner) return false;
      if (q && !matchesQuery(participantSearchText(p, investors[p.investor.id]), q)) return false;
      return true;
    });
  }, [participants, investors, stageFilter, prio, type, industry, follow, owner, q]);

  const activeFilters = [prio, type, industry, follow, owner, stageFilter].filter(Boolean).length;

  /* ---------- ledger ---------- */
  const ledger = useMemo(() => {
    const base = ledgerFromSummary(summary);
    // Funnel counts and "in conversation" follow the board immediately (optimistic moves).
    const counts: Record<string, number> = {};
    for (const p of participants) counts[p.stage.key] = (counts[p.stage.key] ?? 0) + 1;
    return {
      ...base,
      inConversation: participants.filter((p) => p.stage.kind === "active").length,
      funnel: stages.map((s) => ({ key: s.key, label: s.label, color: s.color, count: counts[s.key] ?? 0 })),
    };
  }, [summary, participants, stages]);

  // Opening pushes a history entry (Back closes the sheet); switching investors replaces it.
  const pushed = useRef(false);
  const openInvestor = useCallback(
    (id: string) => {
      if (!openId) pushed.current = true;
      setParams({ investor: id }, openId ? "replace" : "push");
    },
    [openId, setParams],
  );
  const closeSheet = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      router.back();
    } else setParams({ investor: null });
  }, [router, setParams]);

  const openParticipant = openId ? participants.find((p) => p.investor.id === openId) : undefined;
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const empty = participants.length === 0;

  const filterControls = (
    <>
      <Select
        tone="toolbar"
        aria-label="Priority"
        value={prio}
        onChange={(e) => setParams({ prio: e.target.value || null })}
        className="w-auto!"
      >
        <option value="">Priority: all</option>
        {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </Select>
      <Select
        tone="toolbar"
        aria-label="Investor type"
        value={type}
        onChange={(e) => setParams({ type: e.target.value || null })}
        className="w-auto!"
      >
        <option value="">Type: all</option>
        {(Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => (
          <option key={t} value={t}>
            {INVESTOR_TYPE_LABEL[t]}
          </option>
        ))}
      </Select>
      <Select
        tone="toolbar"
        aria-label="Industry"
        value={industry}
        onChange={(e) => setParams({ industry: e.target.value || null })}
        className="w-auto! max-w-[200px]"
      >
        <option value="">Industry: all</option>
        {industries.map((i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </Select>
      <Select
        tone="toolbar"
        aria-label="Follow-up"
        value={follow}
        onChange={(e) => setParams({ follow: e.target.value || null })}
        className="w-auto!"
      >
        <option value="">Follow-up: any</option>
        <option value="due">Due now</option>
        <option value="week">Due this week</option>
        <option value="none">No follow-up set</option>
      </Select>
      <Select
        tone="toolbar"
        aria-label="Owner"
        value={owner}
        onChange={(e) => setParams({ owner: e.target.value || null })}
        className="w-auto! max-w-[200px]"
      >
        <option value="">Owner: anyone</option>
        <option value="none">No owner</option>
        {ownerOptions.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {personName(m)}
            {m.is_you ? " (you)" : ""}
          </option>
        ))}
      </Select>
    </>
  );

  return (
    <div className="flex flex-col gap-14">
      <Ledger
        {...ledger}
        variant="compact"
        activeStage={stageFilter || null}
        onStageSelect={(key) => setParams({ stage: stageFilter === key ? null : key })}
        onDueSelect={openInvestor}
      />

      {empty ? null : (
      <div className="flex flex-wrap items-center gap-8" role="search" aria-label="Filter investors">
        <SearchInput
          placeholder="Search name, firm, focus, notes…"
          aria-label="Search investors in this round"
          value={qText}
          onChange={(e) => onSearch(e.target.value)}
        />
        <div className="hidden flex-wrap items-center gap-8 sm:flex">{filterControls}</div>
        <Button className="sm:hidden" onClick={() => setFiltersOpen(true)}>
          Filters{activeFilters ? ` (${activeFilters})` : ""}
        </Button>
        {activeFilters || q ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQText("");
              setParams({ q: null, prio: null, type: null, industry: null, follow: null, owner: null, stage: null });
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "board", label: "Board" },
            { value: "table", label: "Table" },
          ]}
        />
        {view === "table" ? (
          <Menu
            label="Columns"
            align="end"
            trigger="Columns"
            triggerClassName="inline-flex h-32 items-center gap-6 rounded-sm border border-line bg-surface px-12 text-muted hover:text-fg"
            items={TABLE_COLS.filter((c) => !c.required).map((c) => ({
              label: c.label,
              selected: visible.has(c.key),
              onSelect: () => toggleCol(c.key),
            }))}
          />
        ) : null}
        <span className="t-micro text-muted" aria-live="polite">
          {num(filtered.length)} of {num(participants.length)}
        </span>
        {canWrite ? (
          <Button variant="primary" className="ml-auto" onClick={() => setAdding(true)}>
            Add investor
          </Button>
        ) : null}
      </div>
      )}

      {empty ? (
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
      ) : view === "board" ? (
        <>
          <PipelineBoard
            round={round}
            stages={stages}
            participants={filtered}
            investors={investors}
            agentMarks={agentMarks}
            today={today}
            canWrite={canWrite}
            onOpen={openInvestor}
            onMove={doMove}
          />
          {canWrite ? (
            <p className="t-micro hidden text-muted sm:block">
              Keyboard: focus a card, then <Kbd>Alt</Kbd> <Kbd>→</Kbd> / <Kbd>←</Kbd> moves it one stage, <Kbd>M</Kbd> opens
              Move to…, <Kbd>↵</Kbd> opens the file.
            </p>
          ) : null}
        </>
      ) : (
        <PipelineTable
          round={round}
          rows={filtered}
          investors={investors}
          agentMarks={agentMarks}
          visible={visible}
          sort={sortCol}
          dir={sortDir}
          onSort={(c) =>
            setParams({
              sort: c,
              order: c === sortCol ? (sortDir === "asc" ? "desc" : "asc") : DEFAULT_DIR[c],
            })
          }
          onOpen={openInvestor}
          selectedId={openId}
          today={today}
          timeZone={tz}
        />
      )}

      {!empty && filtered.length === 0 ? (
        <p className="t-body-s text-muted">No investors match these filters.</p>
      ) : null}

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
        onClose={closeSheet}
        onParticipantChange={patchParticipant}
        onInvestorChange={(inv) => setInvestors((m) => ({ ...m, [inv.id]: inv }))}
        onChanged={refreshSummary}
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
          setInvestors((m) => ({ ...m, [inv.id]: inv }));
          if (part) {
            setParticipants((list) =>
              list.some((x) => x.investor.id === part.investor.id)
                ? list.map((x) => (x.investor.id === part.investor.id ? part : x))
                : [...list, part],
            );
          }
          void refreshSummary();
        }}
      />

      <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        <div className="flex flex-col gap-10 [&_select]:w-full! [&_select]:max-w-none!">{filterControls}</div>
        <Button variant="primary" onClick={() => setFiltersOpen(false)}>
          Show {num(filtered.length)} investors
        </Button>
      </Sheet>
    </div>
  );
}
