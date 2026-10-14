"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type ApiClient } from "@/lib/api/client";
import {
  getAiSettings,
  getBatch,
  getCompanyProfile,
  getDossier,
  getIdentity,
  getRun,
  listSuggestions,
  roundResearch,
  type AiSettings,
  type Batch,
  type CompanyProfile,
  type DossierView,
  type Identity,
  type ResearchSummary,
  type RoundResearchRow,
  type Run,
  type Suggestion,
} from "@/lib/api/research";
import { isActive } from "@/lib/research";

/* ---------- AI settings and the company profile, shared for 30s per workspace ---------- */

const settingsCache = new WeakMap<ApiClient, { at: number; p: Promise<AiSettings | null> }>();
const profileCache = new WeakMap<ApiClient, { at: number; p: Promise<CompanyProfile | null> }>();
const listeners = new Set<() => void>();

/** The workspace's research settings (null when they could not load: research stays hidden). */
export function aiSettingsCached(c: ApiClient): Promise<AiSettings | null> {
  const hit = settingsCache.get(c);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const p = getAiSettings(c).catch(() => {
    settingsCache.delete(c);
    return null;
  });
  settingsCache.set(c, { at: Date.now(), p });
  return p;
}

export function companyProfileCached(c: ApiClient): Promise<CompanyProfile | null> {
  const hit = profileCache.get(c);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const p = getCompanyProfile(c).catch(() => {
    profileCache.delete(c);
    return null;
  });
  profileCache.set(c, { at: Date.now(), p });
  return p;
}

/* ---------- runs started elsewhere (a toast's Refresh, the Triage panel) ---------- */

const runListeners = new Set<(investorId: string) => void>();

/** Tell open dossiers that a run started for this investor, so they follow it. */
export function announceRun(investorId: string): void {
  for (const l of runListeners) l(investorId);
}

export function useRunAnnouncements(investorId: string, onRun: () => void): void {
  const ref = useRef(onRun);
  ref.current = onRun;
  useEffect(() => {
    const l = (id: string) => {
      if (id === investorId) ref.current();
    };
    runListeners.add(l);
    return () => void runListeners.delete(l);
  }, [investorId]);
}

/** After spending (a run finished) or a settings change: everyone reads fresh numbers. */
export function invalidateResearch(c: ApiClient): void {
  settingsCache.delete(c);
  profileCache.delete(c);
  for (const l of listeners) l();
}

export function useAiSettings(c: ApiClient): { settings: AiSettings | null | undefined; profile: CompanyProfile | null | undefined; reload: () => void } {
  const [settings, setSettings] = useState<AiSettings | null | undefined>(undefined);
  const [profile, setProfile] = useState<CompanyProfile | null | undefined>(undefined);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void aiSettingsCached(c).then((s) => live && setSettings(s));
    void companyProfileCached(c).then((p) => live && setProfile(p));
    return () => {
      live = false;
    };
  }, [c, n]);
  useEffect(() => {
    const l = () => setN((x) => x + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const reload = useCallback(() => invalidateResearch(c), [c]);
  return { settings, profile, reload };
}

/* ---------- polling (every 2s while active, paused while the tab is hidden) ---------- */

function useVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * Follow a run until it stops. `onDone` runs once when it leaves queued/running (with the
 * final run). Returns the latest run.
 */
export function useRunPoll(c: ApiClient, initial: Run | null, onDone?: (run: Run) => void, everyMs = 2000): Run | null {
  const [run, setRun] = useState<Run | null>(initial);
  const visible = useVisible();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => setRun(initial), [initial]);
  const id = run?.id;
  const active = isActive(run?.status);
  useEffect(() => {
    if (!id || !active || !visible) return;
    let live = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      getRun(c, id, ctrl.signal)
        .then((r) => {
          if (!live) return;
          setRun(r);
          if (!isActive(r.status)) doneRef.current?.(r);
        })
        .catch((err) => {
          if (!live || (err instanceof DOMException && err.name === "AbortError")) return;
          // A transient failure: try again on the next tick.
          setRun((r) => (r ? { ...r } : r));
        });
    }, everyMs);
    return () => {
      live = false;
      clearTimeout(t);
      ctrl.abort();
    };
  }, [c, id, active, visible, run, everyMs]);
  return run;
}

export function useBatchPoll(c: ApiClient, initial: Batch | null, onTick?: (b: Batch) => void, everyMs = 2000): Batch | null {
  const [batch, setBatch] = useState<Batch | null>(initial);
  const visible = useVisible();
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  useEffect(() => setBatch(initial), [initial]);
  const id = batch?.id;
  const active = (batch?.active ?? 0) > 0;
  useEffect(() => {
    if (!id || !active || !visible) return;
    let live = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      getBatch(c, id, ctrl.signal)
        .then((b) => {
          if (!live) return;
          setBatch(b);
          tickRef.current?.(b);
        })
        .catch(() => live && setBatch((b) => (b ? { ...b } : b)));
    }, everyMs);
    return () => {
      live = false;
      clearTimeout(t);
      ctrl.abort();
    };
  }, [c, id, active, visible, batch, everyMs]);
  return batch;
}

/* ---------- the round's research rows (identity, verdict, suggestions per investor) ---------- */

export function useRoundResearch(c: ApiClient, roundId: string): {
  rows: Map<string, RoundResearchRow>;
  loaded: boolean;
  refresh: () => Promise<void>;
} {
  const [rows, setRows] = useState<Map<string, RoundResearchRow>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const r = await roundResearch(c, roundId);
      setRows(new Map(r.data.map((x) => [x.investor_id, x])));
    } catch (err) {
      // Research is optional on the pipeline: an old API or a hiccup leaves it out quietly.
      if (!(err instanceof ApiError)) return;
    } finally {
      setLoaded(true);
    }
  }, [c, roundId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { rows, loaded, refresh };
}

/* ---------- one investor's research, for Triage's decision panel ---------- */

export interface InvestorResearch {
  view: DossierView | null;
  identity: Identity | null;
  suggestions: Suggestion[];
  run: Run | null;
}

const investorCache = new Map<string, { at: number; p: Promise<InvestorResearch> }>();

function researchSig(investorId: string | null, row: ResearchSummary | null | undefined): string {
  return [
    investorId,
    row?.verdict ?? "",
    row?.dossier_at ?? "",
    row?.identity_status ?? "",
    row?.pending_suggestions ?? 0,
    row?.active_run?.id ?? "",
    row?.active_run?.status ?? "",
    row?.stopped_run?.id ?? "",
  ].join("|");
}

/** What the panel needs for one investor, guided by the round's summary row (no wasted calls). */
export function investorResearchCached(c: ApiClient, investorId: string, row: ResearchSummary | null | undefined): Promise<InvestorResearch> {
  const sig = researchSig(investorId, row);
  const hit = investorCache.get(sig);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = (async (): Promise<InvestorResearch> => {
    const [view, identity, suggestions, run] = await Promise.all([
      row?.dossier_at ? getDossier(c, investorId).catch(() => null) : Promise.resolve(null),
      row?.identity_status === "needs_pick" || row?.identity_status === "not_found" || row?.identity_status === "rejected"
        ? getIdentity(c, investorId).catch(() => null)
        : Promise.resolve(null),
      row?.pending_suggestions && !row?.dossier_at
        ? listSuggestions(c, { investor_id: investorId, status: "pending" })
            .then((r) => r.data)
            .catch(() => [] as Suggestion[])
        : Promise.resolve(null),
      // The run going now, or the last one when it stopped without a result (with its reason).
      row?.active_run && isActive(row.active_run.status)
        ? getRun(c, row.active_run.id).catch(() => null)
        : row?.stopped_run
          ? getRun(c, row.stopped_run.id).catch(() => null)
          : Promise.resolve(null),
    ]);
    return { view, identity, suggestions: suggestions ?? view?.suggestions ?? [], run };
  })();
  investorCache.set(sig, { at: Date.now(), p });
  while (investorCache.size > 40) investorCache.delete(investorCache.keys().next().value!);
  p.catch(() => investorCache.delete(sig));
  return p;
}

export function forgetInvestorResearch(investorId: string): void {
  for (const k of [...investorCache.keys()]) if (k.startsWith(`${investorId}|`)) investorCache.delete(k);
}

export function useInvestorResearch(
  c: ApiClient,
  investorId: string | null,
  row: ResearchSummary | null | undefined,
  enabled = true,
): { data: InvestorResearch | null; loading: boolean } {
  const [data, setData] = useState<InvestorResearch | null>(null);
  const [loading, setLoading] = useState(false);
  const sig = researchSig(investorId, row);
  useEffect(() => {
    if (!investorId || !enabled) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    investorResearchCached(c, investorId, row)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, sig, enabled]);
  return { data: data && investorId ? data : null, loading };
}
