"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Chip,
  DefList,
  LinkButtons,
  Loading,
  PriorityChip,
  SaveState,
  SectionLabel,
  Sheet,
  StagePill,
  StageSelector,
  Textarea,
  Timeline,
} from "@/components/ui";
import { listActivities } from "@/lib/api/activities";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { getInvestor, updateInvestor } from "@/lib/api/investors";
import { sortedStages } from "@/lib/api/rounds";
import type { Activity, Investor, Member, Participant, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { formatDate, isoDate, money, moneyCompact, stageFocusLabel } from "@/lib/format";

import { LogComposer } from "./LogComposer";
import { ParticipantFields } from "./ParticipantFields";

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
 * The investor file on the Pipeline page (SYSTEM §4.4): header, stage buttons, round fields,
 * log composer, latest timeline, contact links, facts and notes. Opens with ?investor=<id>.
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
  onClose,
  onParticipantChange,
  onInvestorChange,
  onChanged,
  onStageMove,
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
  onClose: () => void;
  onParticipantChange: (p: Participant) => void;
  onInvestorChange?: (inv: Investor) => void;
  /** Something changed that affects the ledger (refresh the summary). */
  onChanged: () => void;
  /** Stage moves go through the board's optimistic path (with Undo). */
  onStageMove: (investorId: string, stageKey: string) => Promise<boolean>;
}) {
  const [investor, setInvestor] = useState<Investor | null>(null);
  const [timeline, setTimeline] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
  useEffect(() => {
    if (open && investorId && pVersion) void loadTimeline(investorId).catch(() => {});
  }, [pVersion, open, investorId, loadTimeline]);

  const onSaved = useCallback(
    (np: Participant) => {
      onParticipantChange(np);
      onChanged();
    },
    [onParticipantChange, onChanged],
  );

  const name = investor?.name ?? p?.investor.name ?? "Investor";
  const who = [investor?.title ?? p?.investor.title, investor?.firm ?? p?.investor.firm]
    .filter(Boolean)
    .join(" · ");
  const type = investor?.type ?? p?.investor.type;
  const industries = investor?.industries ?? [];
  const stages = sortedStages(round.stages);
  const otherRounds = (investor?.rounds ?? []).filter((r) => r.round_id !== round.id);
  const base = `/w/${encodeURIComponent(wsSlug)}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={name}
      label={name}
      subline={who || undefined}
      chips={
        <>
          {p ? <PriorityChip fit={p.fit} showFit /> : null}
          {type ? <Chip tone="type">{INVESTOR_TYPE_LABEL[type]}</Chip> : null}
          {industries.slice(0, 3).map((i) => (
            <Chip key={i} tone="industry">
              {i}
            </Chip>
          ))}
        </>
      }
      headerAside={
        investorId ? (
          <Link href={`${base}/investors/${investorId}`} className="link t-body-s whitespace-nowrap">
            Open full page ↗
          </Link>
        ) : null
      }
    >
      {error ? <p className="t-body-s text-bad">{error}</p> : null}
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
            key={p.investor.id}
            client={client}
            round={round}
            participant={p}
            investorName={name}
            members={members}
            canWrite={canWrite}
            onSaved={onSaved}
            title="Round fields"
          />
        </>
      ) : !loading && investor ? (
        <p className="t-body-s text-muted">
          {name} is not in {round.name}. Open their page to add them to this round.
        </p>
      ) : null}

      {investorId ? (
        <section aria-label="Log">
          <SectionLabel>Log</SectionLabel>
          <LogComposer
            client={client}
            investorId={investorId}
            investorName={name}
            round={p ? round.id : undefined}
            today={today}
            timeZone={timeZone}
            disabled={!canWrite}
            onLogged={(a) => {
              setTimeline((t) => [a, ...t]);
              onChanged();
            }}
          />
        </section>
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
          <Timeline items={timeline} timeZone={timeZone} currency={round.currency} empty="No activity yet. Log the first note above." />
        )}
      </section>

      {investor ? (
        <>
          <section aria-label="Contact">
            <SectionLabel>Contact</SectionLabel>
            <LinkButtons
              linkedin={investor.linkedin_url}
              website={investor.website_url}
              x={investor.x_url}
              email={investor.email}
            />
            {!investor.linkedin_url && !investor.website_url && !investor.x_url && !investor.email ? (
              <p className="t-body-s text-muted">No contact details yet.</p>
            ) : null}
          </section>
          <section aria-label="Facts">
            <SectionLabel>Facts</SectionLabel>
            <DefList
              items={[
                { term: "Invests at", value: investor.stage_focus.map(stageFocusLabel).join(", ") },
                { term: "Check size", value: checkSize(investor, round.currency) },
                { term: "Industries", value: investor.industries.join(", ") },
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
                { term: "Location", value: investor.location },
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
                { term: "Added", value: formatDate(isoDate(investor.created_at, timeZone), today) },
              ]}
            />
          </section>
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
        </>
      ) : loading ? null : null}
    </Sheet>
  );
}
