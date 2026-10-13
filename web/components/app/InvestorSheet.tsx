"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Chip,
  DefList,
  FitMeter,
  Kbd,
  Loading,
  SaveState,
  SectionLabel,
  Sheet,
  Skeleton,
  StagePill,
  StageSelector,
  Tabs,
  Textarea,
  Timeline,
} from "@/components/ui";
import { useCommands, type Command } from "@/lib/commands";
import { quickPicks } from "@/lib/dates";
import { useHotkey } from "@/lib/hotkeys";
import { collapseImportRuns, importRunOf, importSentence, listActivities } from "@/lib/api/activities";
import { importRunsCached, type ImportRun } from "@/lib/api/data";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { getInvestor, updateInvestor } from "@/lib/api/investors";
import { sortedStages } from "@/lib/api/rounds";
import type { Activity, Investor, Member, Participant, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { money, moneyCompact, stageFocusLabel } from "@/lib/format";
import { visibleIndustries } from "@/lib/pipeline";
import { useOptionalSession, useWorkspace } from "@/lib/session";

import { LogComposer } from "./LogComposer";
import { DossierPanel } from "./research/DossierPanel";
import { ParticipantFields, useParticipantSave } from "./ParticipantFields";
import { draftHref, ReachOut } from "./ReachOut";

/** A quiet "from research" mark beside a value research filled in (R7). */
export function FromResearch({ fields, of }: { fields: readonly string[] | undefined; of: readonly string[] }) {
  if (!fields || !of.some((f) => fields.includes(f))) return null;
  return (
    <span className="t-micro ml-6 whitespace-nowrap text-muted" title="Filled in by research. Edit it and the mark goes away.">
      from research
    </span>
  );
}

/** "$250k–$1M" from check_min/max, else the free-text note. */
export function checkSize(inv: Pick<Investor, "check_min" | "check_max" | "check_note">, currency: string) {
  const { check_min: lo, check_max: hi } = inv;
  if (lo && hi && lo !== hi) return `${moneyCompact(lo, currency)}–${moneyCompact(hi, currency)}`;
  if (lo || hi) return moneyCompact((lo || hi) as number, currency);
  return inv.check_note ?? "";
}

/** Investor-level notes with a 1.2s autosave ("Saving…" → "Saved"). */
export function NotesEditor({
  client,
  investor,
  canWrite,
  onSaved,
  label = "Notes",
}: {
  client: ApiClient;
  investor: Investor;
  canWrite: boolean;
  onSaved?: (inv: Investor) => void;
  label?: string;
}) {
  const [text, setText] = useState(investor.notes ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(investor.notes ?? "");
  const latest = useRef(text);
  latest.current = text;

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = latest.current;
    if (value === saved.current) return;
    setState("saving");
    try {
      const inv = await updateInvestor(client, investor.id, { notes: value.trim() ? value : null });
      saved.current = value;
      setState("saved");
      setError(null);
      onSaved?.(inv);
    } catch (err) {
      setState("error");
      setError(errorMessage(err));
    }
  }, [client, investor.id, onSaved]);

  // Save pending text when the editor unmounts (sheet closed mid-typing).
  useEffect(() => () => void (timer.current && flush()), [flush]);

  return (
    <section aria-label={label}>
      <SectionLabel aside={<SaveState state={state} />}>{label}</SectionLabel>
      <Textarea
        aria-label={`${label} on ${investor.name}`}
        value={text}
        disabled={!canWrite}
        placeholder={canWrite ? "Thesis fit, portfolio overlap, what they asked for…" : "View only"}
        maxLength={20000}
        onChange={(e) => {
          setText(e.target.value);
          setState("idle");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void flush(), 1200);
        }}
        onBlur={() => void flush()}
        className="min-h-120"
      />
      {error ? <p className="t-body-s mt-6 text-bad">{error}</p> : null}
    </section>
  );
}

/**
 * The investor file on the Pipeline page (SYSTEM §4.4, UX pass 1 P1-5b), work first: stage
 * (with fit), follow-up and next step, the log box, then money and owner, the timeline,
 * contact, facts and notes. Opens with ?investor=<id>.
 *
 * Keyboard while it is open: J / K (or Alt+↓ / Alt+↑) go to the next or previous investor
 * in the page's current order without closing, F opens the follow-up picker (then one key:
 * 0 1 3 M 7 2), N focuses the log box. Its commands also appear in the ⌘K palette.
 */
export function InvestorSheet({
  open,
  investorId,
  client,
  wsSlug,
  round,
  participant,
  members,
  today,
  timeZone,
  canWrite,
  order,
  width,
  onNavigate,
  modal = true,
  top,
  onClose,
  onParticipantChange,
  onInvestorChange,
  onChanged,
  onStageMove,
  onResearchChange,
}: {
  open: boolean;
  investorId: string | null;
  client: ApiClient;
  wsSlug: string;
  round: Round;
  participant: Participant | undefined;
  members: Member[];
  today: string;
  timeZone: string;
  canWrite: boolean;
  /** Investor ids in the page's current (filtered, sorted) order, for J / K. */
  order?: string[];
  /** The panel's width (Triage at 1024–1279px uses a narrower one, so the decision panel fits beside it). */
  width?: number;
  onNavigate?: (investorId: string) => void;
  /** false at ≥1280px: a split panel beside the board or table (P2-3). */
  modal?: boolean;
  top?: number;
  onClose: () => void;
  onParticipantChange: (p: Participant) => void;
  onInvestorChange?: (inv: Investor) => void;
  /** Something changed that affects the ledger (refresh the summary). */
  onChanged: () => void;
  /** Stage moves go through the board's optimistic path (with Undo). */
  onStageMove: (investorId: string, stageKey: string) => Promise<boolean>;
  /** Research changed something (a dossier, an identity, accepted suggestions). */
  onResearchChange?: () => void;
}) {
  const [investor, setInvestor] = useState<Investor | null>(null);
  const [timeline, setTimeline] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const loadTimeline = useCallback(
    async (id: string) => {
      const page = await listActivities(client, { investor_id: id, limit: 20 });
      setTimeline(page.data);
    },
    [client],
  );

  useEffect(() => {
    if (!open || !investorId) return;
    let live = true;
    setLoading(true);
    setError(null);
    setInvestor(null);
    setTimeline([]);
    body.current?.scrollTo({ top: 0 });
    Promise.all([getInvestor(client, investorId), listActivities(client, { investor_id: investorId, limit: 20 })])
      .then(([inv, acts]) => {
        if (!live) return;
        setInvestor(inv);
        setTimeline(acts.data);
      })
      .catch((err) => live && setError(errorMessage(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, investorId, client]);

  const p = participant;
  // Re-read the timeline when the participant changes (stage moves, field edits by anyone).
  const pVersion = p?.updated_at;
  const seenVersion = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !investorId || !pVersion) return;
    const key = `${investorId}:${pVersion}`;
    // The first version seen for an investor was loaded by the open effect above.
    if (!seenVersion.current?.startsWith(`${investorId}:`)) {
      seenVersion.current = key;
      return;
    }
    if (seenVersion.current === key) return;
    seenVersion.current = key;
    void loadTimeline(investorId).catch(() => {});
  }, [pVersion, open, investorId, loadTimeline]);

  const onSaved = useCallback(
    (np: Participant) => {
      onParticipantChange(np);
      onChanged();
    },
    [onParticipantChange, onChanged],
  );
  const fit = useParticipantSave(client, round.id, investorId ?? "", onSaved);

  /* ---------- navigation in the page's order ---------- */
  const pos = investorId && order ? order.indexOf(investorId) : -1;
  const prevId = pos > 0 ? order![pos - 1] : undefined;
  const nextId = pos >= 0 && order && pos < order.length - 1 ? order[pos + 1] : undefined;
  const go = (id: string | undefined) => {
    if (id && onNavigate) onNavigate(id);
  };
  const logId = investorId ? `log-${investorId}` : undefined;
  const fuId = investorId ? `fu-${investorId}` : undefined;
  const focusLog = () => {
    const el = logId ? document.getElementById(logId) : null;
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      (el as HTMLTextAreaElement).focus();
    }
  };
  const openFollowUp = () => {
    const el = fuId ? (document.getElementById(fuId) as HTMLButtonElement | null) : null;
    if (el && !el.disabled) {
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      el.click();
    }
  };
  useHotkey("j", () => go(nextId), { priority: 1, enabled: open && Boolean(nextId), description: "Next investor", group: "Investor file" });
  useHotkey("k", () => go(prevId), { priority: 1, enabled: open && Boolean(prevId), description: "Previous investor", group: "Investor file" });
  useHotkey("alt+arrowdown", () => go(nextId), { priority: 1, enabled: open && Boolean(nextId), allowInInputs: true });
  useHotkey("alt+arrowup", () => go(prevId), { priority: 1, enabled: open && Boolean(prevId), allowInInputs: true });
  useHotkey("n", focusLog, { priority: 1, enabled: open && canWrite && Boolean(investorId), description: "Log a note", group: "Investor file" });
  useHotkey("f", openFollowUp, { priority: 1, enabled: open && canWrite && Boolean(p), description: "Set follow-up", group: "Investor file" });
  // Pipeline | Dossier (RESEARCH-PLAN §8.3). The tab stays as you walk the list with J / K.
  const [tab, setTab] = useState<"pipeline" | "dossier">("pipeline");
  useHotkey("r", () => setTab((t) => (t === "dossier" ? "pipeline" : "dossier")), {
    priority: 1,
    enabled: open && Boolean(investorId),
    description: "Dossier / Pipeline tab",
    group: "Investor file",
  });

  const name = investor?.name ?? p?.investor.name ?? "Investor";
  const stages = useMemo(() => sortedStages(round.stages), [round.stages]);
  const commands: Command[] | null = useMemo(() => {
    if (!open || !investorId) return null;
    const group = name;
    const out: Command[] = [];
    if (p && canWrite) {
      for (const s of stages)
        if (s.key !== p.stage.key)
          out.push({ id: `sheet.move.${s.key}`, label: `Move ${name} to ${s.label}`, group, keywords: ["stage", s.label], run: () => void onStageMove(p.investor.id, s.key) });
      for (const q of quickPicks("followup", today))
        out.push({
          id: `sheet.fu.${q.kbd}`,
          label: `Follow up with ${name}: ${q.label.toLowerCase()}`,
          group,
          keywords: ["follow-up", "follow up", "date"],
          run: () => void fit.save({ follow_up_on: q.iso }),
        });
      out.push({ id: "sheet.log", label: `Log a note on ${name}`, group, kbd: "n", run: focusLog });
    }
    if (nextId) out.push({ id: "sheet.next", label: "Next investor", group, kbd: "j", run: () => go(nextId) });
    if (prevId) out.push({ id: "sheet.prev", label: "Previous investor", group, kbd: "k", run: () => go(prevId) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, investorId, name, p?.stage.key, canWrite, stages, today, nextId, prevId]);
  useCommands("investor-sheet", commands);

  const { workspace } = useWorkspace();
  const me = useOptionalSession()?.user;
  const who = [investor?.firm ?? p?.investor.firm, investor?.title ?? p?.investor.title].filter(Boolean).join(" · ");
  const type = investor?.type ?? p?.investor.type;
  const otherRounds = (investor?.rounds ?? []).filter((r) => r.round_id !== round.id);
  const base = `/w/${encodeURIComponent(wsSlug)}`;
  const navBtn =
    "inline-flex size-28 items-center justify-center rounded-sm border border-line bg-surface text-muted hover:text-fg disabled:opacity-40 disabled:hover:text-muted";

  // Not contacted yet (an open-kind stage): Contact and Facts move up, Money folds away.
  const fresh = p?.stage.kind === "open";
  const hasMoney = Boolean(p && ((p.amount_soft ?? 0) > 0 || (p.amount_committed ?? 0) > 0 || p.probability != null || p.owner));
  const [moneyOpen, setMoneyOpen] = useState(false);
  useEffect(() => setMoneyOpen(false), [investorId]);
  const moneyShown = !fresh || hasMoney || moneyOpen;

  // The import shows once ("Rowan imported Calla from x.csv with 410 others"), as in Triage.
  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void importRunsCached(client).then((r) => live && setRuns(r));
    return () => {
      live = false;
    };
  }, [open, client]);
  const shownTimeline = useMemo(() => collapseImportRuns(timeline), [timeline]);
  const firstName = name.split(/\s+/)[0] ?? name;
  const importLine = useCallback(
    (a: Activity) => {
      const run = importRunOf(a);
      return run ? importSentence(firstName, runs?.find((r) => r.id === run)) : null;
    },
    [runs, firstName],
  );

  // Reach out in the sheet is Triage's row (critique 4): LinkedIn, Draft intro email, the
  // address with Copy, Website, X; one style, one order.
  const person = investor
    ? {
        name: investor.name,
        firm: investor.firm,
        fit: p?.fit ?? 0,
        email: investor.email,
        linkedin_url: investor.linkedin_url,
        website_url: investor.website_url,
        x_url: investor.x_url,
      }
    : null;
  const draft = person ? draftHref(person, { workspaceName: workspace.name, round, sender: me?.name ?? null }) : null;
  const fromResearch = investor?.research?.from_research;
  const rs = investor?.research;
  const researchHint = rs
    ? rs.active_run
      ? "running"
      : rs.identity_status === "needs_pick"
        ? "pick"
        : rs.verdict
          ? (rs.verdict === "strong" ? "Strong" : rs.verdict === "possible" ? "Possible" : "Poor")
          : null
    : null;
  const contactAndFacts = investor ? (
    <>
      <section aria-label="Contact">
        <SectionLabel>Contact</SectionLabel>
        <ReachOut person={person!} draft={draft} />
      </section>
      <section aria-label="Facts">
        <SectionLabel>Facts</SectionLabel>
        <DefList
          items={[
            {
              term: "Invests at",
              value: investor.stage_focus.length ? (
                <>
                  {investor.stage_focus.map(stageFocusLabel).join(", ")}
                  <FromResearch fields={fromResearch} of={["stage_focus"]} />
                </>
              ) : null,
            },
            {
              term: "Check size",
              value: checkSize(investor, round.currency) ? (
                <>
                  {checkSize(investor, round.currency)}
                  <FromResearch fields={fromResearch} of={["check_min", "check_max"]} />
                </>
              ) : null,
            },
            {
              term: "Industries",
              value: visibleIndustries(investor.industries).length ? (
                <>
                  {visibleIndustries(investor.industries).join(", ")}
                  <FromResearch fields={fromResearch} of={["industries"]} />
                </>
              ) : null,
            },
            {
              term: "Tags",
              value: investor.tags.length ? (
                <span className="flex flex-wrap gap-4">
                  {investor.tags.map((t) => (
                    <Chip key={t} tone="tag">
                      {t}
                    </Chip>
                  ))}
                </span>
              ) : null,
            },
            {
              term: "Location",
              value: investor.location ? (
                <>
                  {investor.location}
                  <FromResearch fields={fromResearch} of={["location"]} />
                </>
              ) : null,
            },
            { term: "Source", value: investor.source },
            { term: "Warm intro by", value: investor.warm_intro_by },
            {
              term: "Other rounds",
              value: otherRounds.length ? (
                <span className="flex flex-col gap-2">
                  {otherRounds.map((r) => (
                    <Link
                      key={r.round_id}
                      href={`${base}/r/${encodeURIComponent(r.round_slug)}?investor=${investor.id}`}
                      className="inline-flex items-center gap-6 hover:underline"
                    >
                      {r.round_name} · <StagePill color={r.stage.color} label={r.stage.label} />
                      {r.amount_committed ? (
                        <span className="t-data text-good-ink" title={money(r.amount_committed, round.currency)}>
                          {moneyCompact(r.amount_committed, round.currency)}
                        </span>
                      ) : null}
                    </Link>
                  ))}
                </span>
              ) : null,
            },
          ]}
        />
      </section>
    </>
  ) : loading ? (
    <section aria-label="Loading contact and facts" className="flex flex-col gap-10">
      <SectionLabel>Contact</SectionLabel>
      <Skeleton width="60%" />
      <SectionLabel>Facts</SectionLabel>
      <Skeleton lines={4} />
    </section>
  ) : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={name}
      label={name}
      focusTitle
      bodyRef={body}
      modal={modal}
      width={width}
      top={modal ? undefined : top}
      subline={who || undefined}
      // Fit and type under the name, as in Triage (critique 3): industries live in Facts only,
      // so the header has one chip style and no repeats.
      chips={
        p || (type && type !== "other") ? (
          // The type chip leads and the fit follows, so the fit's hover-only clear button and
          // its save state trail at the end instead of pushing the chip 40px away (critique 4).
          <span className="flex flex-wrap items-center gap-10">
            {type && type !== "other" ? <Chip tone="type">{INVESTOR_TYPE_LABEL[type]}</Chip> : null}
            {p ? (
              <span className="inline-flex items-center gap-6">
                <span className="t-label" id={`fit-label-${p.investor.id}`}>
                  Fit
                </span>
                <FitMeter editable value={p.fit} disabled={!canWrite} label={`Fit for ${name}`} onChange={(f) => void fit.save({ fit: f })} />
                <SaveState state={fit.state} />
              </span>
            ) : null}
          </span>
        ) : null
      }
      headerAside={
        investorId ? (
          <span className="flex flex-col items-end gap-8">
            <Link href={`${base}/investors/${investorId}`} prefetch={false} className="link t-body-s whitespace-nowrap">
              Open full page ↗
            </Link>
            {order && pos >= 0 && order.length > 1 ? (
              <span className="flex items-center gap-4 max-sm:hidden">
                <span className="t-micro mr-2 text-muted" aria-live="polite">
                  {pos + 1} of {order.length}
                </span>
                <button type="button" className={navBtn} disabled={!prevId} onClick={() => go(prevId)} aria-label="Previous investor" title="Previous investor (K)">
                  ↑
                </button>
                <button type="button" className={navBtn} disabled={!nextId} onClick={() => go(nextId)} aria-label="Next investor" title="Next investor (J)">
                  ↓
                </button>
              </span>
            ) : null}
          </span>
        ) : null
      }
    >
      {investorId ? (
        <Tabs
          label={`${name}'s file`}
          idBase="investor-sheet"
          value={tab}
          onChange={setTab}
          className="-mt-6 shrink-0"
          items={[
            { value: "pipeline", label: "Pipeline" },
            {
              value: "dossier",
              label: (
                <span className="inline-flex items-baseline gap-6" title="Dossier (R)">
                  Dossier
                  {researchHint ? <span className="t-micro text-muted">{researchHint}</span> : null}
                </span>
              ),
            },
          ]}
        />
      ) : null}
      {error ? <p className="t-body-s text-bad">{error}</p> : null}
      {tab === "dossier" && investorId ? (
        <div role="tabpanel" id="investor-sheet-panel-dossier" aria-labelledby="investor-sheet-tab-dossier">
          <DossierPanel
            key={investorId}
            investorId={investorId}
            investorName={name}
            round={round.id}
            client={client}
            wsSlug={wsSlug}
            canWrite={canWrite}
            today={today}
            currency={round.currency}
            onChanged={() => {
              void getInvestor(client, investorId)
                .then((inv) => {
                  setInvestor(inv);
                  onInvestorChange?.(inv);
                })
                .catch(() => {});
              onResearchChange?.();
              onChanged();
            }}
          />
        </div>
      ) : (
      <>
      {p ? (
        <>
          <section aria-label={`Stage for ${round.name}`}>
            <SectionLabel>Stage for {round.name}</SectionLabel>
            <StageSelector
              label={`Stage for ${round.name}`}
              stages={stages}
              value={p.stage.key}
              disabled={!canWrite}
              onSelect={(key) => void onStageMove(p.investor.id, key)}
            />
          </section>
          <ParticipantFields
            key={`work-${p.investor.id}`}
            section="work"
            client={client}
            round={round}
            participant={p}
            investorName={name}
            members={members}
            canWrite={canWrite}
            onSaved={onSaved}
            timeZone={timeZone}
            followUpId={fuId}
          />
        </>
      ) : !loading && investor ? (
        <p className="t-body-s text-muted">
          {name} is not in {round.name}. Open their page to add them to this round.
        </p>
      ) : null}

      {/* Not contacted yet: who they are and how to reach them come before the log and the
          money (critique 2), and the money fields wait behind one line. */}
      {fresh ? contactAndFacts : null}

      {investorId ? (
        <section aria-label="Log">
          <SectionLabel aside={canWrite ? <Kbd>N</Kbd> : null}>Log</SectionLabel>
          <LogComposer
            key={investorId}
            client={client}
            investorId={investorId}
            investorName={name}
            round={p ? round.id : undefined}
            today={today}
            timeZone={timeZone}
            disabled={!canWrite}
            textareaId={logId}
            onLogged={(a) => {
              setTimeline((t) => [a, ...t]);
              onChanged();
            }}
          />
        </section>
      ) : null}

      {p ? (
        moneyShown ? (
          <ParticipantFields
            key={`money-${p.investor.id}`}
            section="money"
            client={client}
            round={round}
            participant={p}
            investorName={name}
            members={members}
            canWrite={canWrite}
            onSaved={onSaved}
            timeZone={timeZone}
          />
        ) : (
          <section aria-label="Money">
            <button
              type="button"
              aria-expanded={false}
              onClick={() => setMoneyOpen(true)}
              disabled={!canWrite}
              className="flex w-full items-center gap-8 border-0 bg-transparent p-0 text-left disabled:cursor-default"
            >
              <span className="t-label">{members.length > 1 ? "Money and owner" : "Money"}</span>
              <span className="t-body-s text-muted">Soft, committed and probability, once they are talking</span>
              {canWrite ? <span className="link t-body-s ml-auto">Add</span> : null}
            </button>
          </section>
        )
      ) : null}

      <section aria-label="Timeline">
        <SectionLabel
          aside={
            investorId ? (
              <Link href={`${base}/investors/${investorId}#timeline`} className="link t-body-s">
                Show all
              </Link>
            ) : null
          }
        >
          Timeline
        </SectionLabel>
        {loading ? (
          <Loading>Loading timeline…</Loading>
        ) : (
          <Timeline
            items={shownTimeline}
            timeZone={timeZone}
            currency={round.currency}
            sentenceFor={importLine}
            empty="No activity yet. Log the first note above."
          />
        )}
      </section>

      {fresh ? null : contactAndFacts}

      {investor ? (
        <NotesEditor
          key={investor.id}
          client={client}
          investor={investor}
          canWrite={canWrite}
          onSaved={(inv) => {
            setInvestor(inv);
            onInvestorChange?.(inv);
          }}
        />
      ) : null}
      </>
      )}
    </Sheet>
  );
}
