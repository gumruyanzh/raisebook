"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, Chip, Loading, SectionLabel, Select } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import {
  getDossier,
  getIdentity,
  listDossierVersions,
  listRuns,
  startResearch,
  type DossierVersion,
  type DossierView,
  type Identity,
  type Run,
} from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { formatDate, num } from "@/lib/format";
import { approxUsd, isActive, sectionsOf, stoppedRun, verdictLabel, type Section } from "@/lib/research";

import { AgentBy, Brief, Cites } from "./Brief";
import { useAiSettings, useRunAnnouncements, useRunPoll } from "./hooks";
import { IdentityPicker } from "./IdentityPicker";
import { ResearchError, SpendLimitNote } from "./ResearchError";
import { RunProgress } from "./RunProgress";
import { SuggestionList } from "./SuggestionList";

type Loaded = { identity: Identity; view: DossierView | null; versions: DossierVersion[]; active: Run | null };

/** Load identity, the dossier (a 404 `no_dossier` is "none yet") and its versions. */
async function loadAll(c: ApiClient, investorId: string, version?: number): Promise<Loaded> {
  const [identity, view, versions, runs] = await Promise.all([
    getIdentity(c, investorId),
    getDossier(c, investorId, version).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }),
    listDossierVersions(c, investorId)
      .then((r) => r.data)
      .catch(() => [] as DossierVersion[]),
    // A run already going (started elsewhere, or before a reload) is followed here.
    listRuns(c, { investor_id: investorId, limit: 5 })
      .then((r) => r.data)
      .catch(() => [] as Run[]),
  ]);
  // A run going now, or else the last one when it stopped without a result (failed, partial,
  // capped): it stays visible with its reason and Resume after a reload.
  return { identity, view, versions, active: runs.find((r) => isActive(r.status)) ?? stoppedRun(runs, view?.dossier.created_at) };
}

const host = (u: string | null | undefined) => (u ? u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : "");

/**
 * The Dossier tab (RESEARCH-PLAN §8.3) of the investor sheet and the investor page. Top to
 * bottom: who this is (or "Is this them?"), the Brief, "New since", suggestions, the five
 * collapsed sections with numbered sources, the unverified claims, then versions and
 * "Research again". Research is never automatic: every run starts from a button here.
 */
export function DossierPanel({
  investorId,
  investorName,
  round,
  client,
  wsSlug,
  canWrite,
  today,
  currency,
  onChanged,
  nested = false,
}: {
  investorId: string;
  investorName: string;
  /** The round the Fit compares to (id or slug). */
  round?: string | null;
  client: ApiClient;
  wsSlug: string;
  canWrite: boolean;
  today: string;
  currency: string;
  /** Research changed the investor (fields filled, fit, suggestions accepted). */
  onChanged?: () => void;
  /** Under a "Dossier" heading (the investor page): the Brief needs no label of its own. */
  nested?: boolean;
}) {
  const { settings, profile, reload: reloadSettings } = useAiSettings(client);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<unknown>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [starting, setStarting] = useState<string | null>(null);
  const [run0, setRun0] = useState<Run | null>(null);
  const [n, setN] = useState(0);
  const base = `/w/${encodeURIComponent(wsSlug)}`;

  useEffect(() => {
    let live = true;
    setError(null);
    loadAll(client, investorId, version)
      .then((d) => {
        if (!live) return;
        setData(d);
        if (d.active) setRun0(d.active);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [client, investorId, version, n]);
  useEffect(() => {
    setData(null);
    setVersion(undefined);
    setRun0(null);
    setStartErr(null);
  }, [investorId]);

  const reload = useCallback(() => setN((x) => x + 1), []);
  // A run started from elsewhere (the Meeting toast's Refresh): reload and follow it.
  useRunAnnouncements(investorId, reload);
  const finished = useCallback(
    (r: Run) => {
      reloadSettings();
      setVersion(undefined);
      reload();
      if (r.status === "succeeded" || r.status === "partial") onChanged?.();
    },
    [reload, reloadSettings, onChanged],
  );
  const run = useRunPoll(client, run0, finished);
  const running = Boolean(run && isActive(run.status));

  const start = async (kind: "identity" | "dossier" | "refresh") => {
    setStarting(kind);
    setStartErr(null);
    try {
      const r = await startResearch(client, investorId, { kind, ...(round ? { round } : {}) });
      setRun0(r.run);
    } catch (e) {
      setStartErr(e);
    } finally {
      setStarting(null);
    }
  };

  const view = data?.view ?? null;
  const parts = useMemo(() => (view ? sectionsOf(view) : null), [view]);

  if (error)
    return (
      <p className="t-body-s text-bad" role="alert">
        The dossier could not load. {error}
      </p>
    );
  if (!data || settings === undefined) return <Loading>Loading research…</Loading>;

  const identity = data.identity;
  const available = Boolean(settings?.research_available);
  // The monthly limit is used up: no paid buttons, one sentence and where to raise it.
  const capped = Boolean(settings?.usage.cap_reached);
  const canRun = canWrite && available && !capped;
  const limitNote = canWrite && available && capped ? <SpendLimitNote settings={settings} wsSlug={wsSlug} /> : null;
  const noProfileNote =
    canRun && profile?.is_empty ? (
      <p className="t-body-s text-muted">
        No company profile yet, so this dossier would have no fit verdict.{" "}
        <Link href={`/w/${encodeURIComponent(wsSlug)}/settings/company`} className="link">
          Add it first
        </Link>{" "}
        to get one.
      </p>
    ) : null;
  const dossierCost = approxUsd(settings?.estimates.current);
  const identityCost = approxUsd(settings?.estimates.identity);
  const anchored = identity.status === "matched" || identity.status === "confirmed";
  const first = investorName.split(/\s+/)[0] ?? investorName;
  const latest = data.versions[0]?.version;
  const viewingOld = Boolean(view && latest && view.dossier.version !== latest);

  const noKey =
    settings && !available ? (
      <p className="t-body-s text-muted">
        {settings.kek_configured ? (
          <>
            Research runs on your own OpenRouter key.{" "}
            {settings.can_manage_key ? (
              <Link href={`${base}/settings/ai`} className="link">
                Add a key in Settings
              </Link>
            ) : (
              "Ask the workspace owner to add one in Settings → AI research."
            )}{" "}
            An agent can also save a dossier for free with <span className="font-mono text-micro">save_dossier</span>.
          </>
        ) : (
          <>Research is not set up on this server. An agent can still save a dossier with <span className="font-mono text-micro">save_dossier</span>.</>
        )}
      </p>
    ) : null;

  const progress =
    run && (running || !view || run.status !== "succeeded") && !(run.status === "succeeded" && view) ? (
      <RunProgress run={run} client={client} wsSlug={wsSlug} canWrite={canWrite} onChange={setRun0} />
    ) : null;

  const identityLine = anchored ? (
    <p className="t-body-s flex min-w-0 flex-wrap items-baseline gap-x-8 gap-y-2 text-muted">
      <span className="t-label">Identity</span>
      <span className="min-w-0 text-fg">{[identity.title, identity.firm].filter(Boolean).join(" · ") || investorName}</span>
      {identity.linkedin_url ? (
        <a href={identity.linkedin_url} target="_blank" rel="noopener noreferrer" className="link">
          {host(identity.linkedin_url).replace(/^linkedin\.com\//, "")} ↗
        </a>
      ) : null}
      {identity.firm_website ? (
        <a href={identity.firm_website} target="_blank" rel="noopener noreferrer" className="link">
          {host(identity.firm_website)} ↗
        </a>
      ) : null}
      <span className="t-micro">{identity.status === "confirmed" ? "confirmed" : "matched"}</span>
    </p>
  ) : null;

  /* ---------- no dossier yet ---------- */
  if (!view) {
    return (
      <div className="flex flex-col gap-14">
        {identity.status === "needs_pick" ? (
          <IdentityPicker identity={identity} name={investorName} client={client} canWrite={canWrite} onPicked={() => reload()} />
        ) : null}
        {identityLine}
        {progress}
        {running ? null : identity.status === "none" || identity.status === "pending" ? (
          <section className="flex flex-col gap-8" aria-label="Research">
            <p className="text-muted">
              No research on {first} yet. Research finds who {first} is, then reads public pages about their deals, fund and views, and
              writes a dossier where every claim links to its source.
            </p>
            {canRun ? (
              <div className="flex flex-wrap items-center gap-8">
                <Button variant="primary" size="sm" busy={starting === "dossier" ? "Starting…" : false} onClick={() => void start("dossier")}>
                  Research {first} {dossierCost}
                </Button>
                <Button size="sm" variant="ghost" busy={starting === "identity" ? "Starting…" : false} onClick={() => void start("identity")}>
                  Only find who this is {identityCost}
                </Button>
              </div>
            ) : null}
            {noProfileNote}
            {limitNote}
            {noKey}
          </section>
        ) : identity.status === "not_found" || identity.status === "rejected" ? (
          <section className="flex flex-col gap-8" aria-label="Research">
            <p className="text-muted">
              {identity.status === "not_found"
                ? `No public professional profile clearly matched ${investorName}.`
                : `You said none of the people found is ${investorName}.`}{" "}
              Add their LinkedIn URL to anchor research, or search again.
            </p>
            <IdentityPicker identity={{ ...identity, candidates: [] }} name={investorName} client={client} canWrite={canWrite} onPicked={() => reload()} compact />
            {canRun ? (
              <div>
                <Button size="sm" variant="ghost" busy={starting === "identity" ? "Starting…" : false} onClick={() => void start("identity")}>
                  Search again {identityCost}
                </Button>
              </div>
            ) : null}
            {limitNote}
          </section>
        ) : anchored ? (
          <section className="flex flex-col gap-8" aria-label="Research">
            <p className="text-muted">
              Research reads public pages about {first}&apos;s recent deals, fund and views, and writes a dossier where every claim links to its
              source.
            </p>
            {canRun ? (
              <div>
                <Button variant="primary" size="sm" busy={starting === "dossier" ? "Starting…" : false} onClick={() => void start("dossier")}>
                  Research {first} {dossierCost}
                </Button>
              </div>
            ) : null}
            {noProfileNote}
            {limitNote}
            {noKey}
          </section>
        ) : null}
        {startErr ? <ResearchError error={startErr} wsSlug={wsSlug} /> : null}
      </div>
    );
  }

  /* ---------- the dossier ---------- */
  const { sections, citations, briefCites } = parts!;
  const fresh = view.new_since ? new Set(view.dossier.new_fact_keys) : null;
  const newLines = sections.flatMap((s) => s.lines.filter((l) => l.isNew).map((l) => ({ ...l, section: s.label })));
  const refreshing = starting === "refresh" || (running && run?.kind === "refresh");
  const profileEmpty = profile?.is_empty ?? false;

  return (
    <div className="flex min-w-0 flex-col gap-16">
      {view.refresh_offer && !viewingOld && !running ? (
        <div className="flex flex-wrap items-center gap-x-10 gap-y-6 rounded-sm border border-warm bg-warm-soft px-12 py-8">
          <p className="t-body-s min-w-0 flex-1 text-warm-ink">
            <b className="font-semibold">Refresh before your meeting?</b> This dossier is {num(view.age_days)} days old.
          </p>
          {canRun ? (
            <Button size="sm" busy={refreshing ? "Starting…" : false} onClick={() => void start("refresh")}>
              Refresh {dossierCost}
            </Button>
          ) : null}
        </div>
      ) : null}

      {viewingOld ? (
        <p className="t-body-s text-muted">
          You are reading version {view.dossier.version} from {formatDate(view.dossier.created_at.slice(0, 10), today)}.{" "}
          <button type="button" className="link border-0 bg-transparent p-0" onClick={() => setVersion(undefined)}>
            Back to the latest
          </button>
        </p>
      ) : null}

      <section aria-label="Brief">
        {nested ? null : <SectionLabel>Brief</SectionLabel>}
        <Brief
          view={view}
          citations={citations}
          briefCites={briefCites}
          today={today}
          aside={
            view.stale ? (
              <>
                <Chip tone="soon">May be stale</Chip>
                {canRun && !running ? (
                  <button type="button" className="link border-0 bg-transparent p-0" onClick={() => void start("refresh")}>
                    Refresh {dossierCost}
                  </button>
                ) : null}
              </>
            ) : null
          }
        />
        {profileEmpty ? (
          <p className="t-body-s mt-8 text-muted">
            <Link href={`${base}/settings/company`} className="link">
              Add your company profile
            </Link>{" "}
            for a fit verdict and talking points.
          </p>
        ) : null}
      </section>

      {progress ? <section aria-label="Research run">{progress}</section> : null}
      {startErr ? <ResearchError error={startErr} wsSlug={wsSlug} /> : null}

      {fresh && newLines.length ? (
        <section aria-label="New since" className="border-l-2 border-accent pl-12">
          <SectionLabel>New since {formatDate(view.new_since!.slice(0, 10), today)}</SectionLabel>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {newLines.map((l, i) => (
              <li key={i} className="text-13">
                <span className="t-micro mr-6 text-muted">{l.section}</span>
                {l.date ? <span className="t-data mr-6 text-muted">{formatDate(l.date, today)}</span> : null}
                {l.text}
                <Cites nums={l.cites} citations={citations} today={today} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.suggestions.length && !viewingOld ? (
        <section aria-label="Suggestions">
          <SectionLabel>Suggestions</SectionLabel>
          <SuggestionList
            suggestions={view.suggestions}
            investorId={investorId}
            client={client}
            currency={currency}
            canWrite={canWrite}
            onChanged={() => {
              reload();
              onChanged?.();
            }}
          />
        </section>
      ) : null}

      <div className="flex flex-col border-t border-line">
        {sections.map((s) => (
          <Disclosure key={s.key} section={s} citations={citations} today={today} />
        ))}
        {view.dossier.unverified.length ? (
          <details className="group border-b border-line">
            <summary className="flex h-36 cursor-pointer list-none items-center gap-8 [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="w-12 text-muted group-open:hidden">
                →
              </span>
              <span aria-hidden className="hidden w-12 text-muted group-open:inline">
                ↓
              </span>
              <span className="t-label">Unverified · from model memory</span>
              <span className="t-micro ml-auto text-muted">{num(view.dossier.unverified.length)}</span>
            </summary>
            <div className="pb-10 pl-20">
              <p className="t-body-s mb-6 text-muted">The model said these without a source from this run. Treat them as leads to check, not facts.</p>
              <ul className="m-0 flex list-disc flex-col gap-4 pl-16 text-13 text-muted">
                {view.dossier.unverified.map((u, i) => (
                  <li key={i}>{u.text}</li>
                ))}
              </ul>
            </div>
          </details>
        ) : null}
      </div>

      {identityLine}

      <footer className="flex flex-wrap items-center gap-x-12 gap-y-8">
        {data.versions.length > 1 ? (
          <Select
            size="sm"
            tone="toolbar"
            aria-label="Dossier version"
            value={String(view.dossier.version)}
            onChange={(e) => setVersion(Number(e.target.value) === latest ? undefined : Number(e.target.value))}
            className="w-auto"
          >
            {data.versions.map((v) => (
              <option key={v.id} value={v.version}>
                v{v.version} · {formatDate(v.created_at.slice(0, 10), today)} · {verdictLabel(v.verdict)}
                {v.author.by ? ` · ${v.author.by}` : ""}
              </option>
            ))}
          </Select>
        ) : null}
        {canRun && !running && !viewingOld ? (
          <Button size="sm" busy={refreshing ? "Starting…" : false} onClick={() => void start("refresh")}>
            Research again {dossierCost}
          </Button>
        ) : null}
        <span className="t-micro text-muted">
          {num(citations.length)} {citations.length === 1 ? "source" : "sources"} cited
          {view.author.kind === "agent" ? (
            <>
              {" "}
              · <AgentBy by={view.author.by} />
            </>
          ) : null}
        </span>
        {!available && canWrite ? <span className="w-full">{noKey}</span> : null}
        {limitNote ? <span className="w-full">{limitNote}</span> : null}
      </footer>
    </div>
  );
}

function Disclosure({ section, citations, today }: { section: Section; citations: ReturnType<typeof sectionsOf>["citations"]; today: string }) {
  const nNew = section.lines.filter((l) => l.isNew).length;
  return (
    <details className="group border-b border-line">
      <summary className="flex h-36 cursor-pointer list-none items-center gap-8 hover:text-fg [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="w-12 text-muted group-open:hidden">
          →
        </span>
        <span aria-hidden className="hidden w-12 text-muted group-open:inline">
          ↓
        </span>
        <span className="t-label text-fg">{section.label}</span>
        {nNew ? <span className="t-micro text-accent">{nNew} new</span> : null}
        <span className="t-micro ml-auto text-muted">{num(section.lines.length)}</span>
      </summary>
      <ul className="m-0 flex list-none flex-col gap-6 p-0 pb-12 pl-20">
        {section.lines.map((l, i) => (
          <li key={i} className={cn("text-13", l.isNew && "border-l-2 border-accent -ml-10 pl-8")}>
            {l.lead ? <span className="mr-6 font-medium">{l.lead}</span> : null}
            {l.date ? <span className="t-data mr-6 text-muted">{formatDate(l.date, today)}</span> : null}
            <span>{l.text}</span>
            <Cites nums={l.cites} citations={citations} today={today} />
            {l.workspace ? <span className="t-micro ml-6 text-muted">from your own data</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
