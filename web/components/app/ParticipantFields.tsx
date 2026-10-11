"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  Checkbox,
  ConfirmDialog,
  Field,
  FitMeter,
  Input,
  Textarea,
  SaveState,
  SectionLabel,
  Select,
} from "@/components/ui";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { recordCommitment, updateParticipant, type ParticipantUpdate } from "@/lib/api/rounds";
import type { Member, Participant, Round } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

import { moneyInput, parseIntIn, parseMoney, personName } from "./util";

type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Save a participant patch and report "Saving…" → "Saved" (SYSTEM §4.4). */
export function useParticipantSave(
  client: ApiClient,
  round: string,
  investorId: string,
  onSaved: (p: Participant) => void,
) {
  const [state, setState] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const run = useCallback(
    async (fn: () => Promise<Participant>) => {
      setState("saving");
      setError(null);
      try {
        const p = await fn();
        onSaved(p);
        setState("saved");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2400);
        return p;
      } catch (err) {
        setState("error");
        setError(errorMessage(err));
        return null;
      }
    },
    [onSaved],
  );

  const save = useCallback(
    (patch: ParticipantUpdate) => run(() => updateParticipant(client, round, investorId, patch)),
    [client, round, investorId, run],
  );

  return { state, error, save, run };
}

/** The commitment confirm: "Record $250k commitment and move to Committed?" */
export function CommitmentDialog({
  open,
  amount,
  currency,
  wonLabel,
  inWon,
  investorName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  amount: number;
  currency: string;
  wonLabel: string;
  inWon: boolean;
  investorName: string;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (moveToWon: boolean) => void;
}) {
  const [move, setMove] = useState(true);
  useEffect(() => {
    if (open) setMove(true);
  }, [open]);
  const clearing = amount === 0;
  return (
    <ConfirmDialog
      open={open}
      onClose={onCancel}
      danger={false}
      busy={busy}
      busyLabel="Saving…"
      error={error}
      title={
        clearing
          ? `Clear ${investorName}'s commitment?`
          : `Record ${money(amount, currency)} from ${investorName}?`
      }
      confirmLabel={clearing ? "Clear commitment" : "Record commitment"}
      onConfirm={() => onConfirm(!clearing && !inWon && move)}
    >
      {clearing ? (
        <p>The committed amount is removed from the round total. Their stage stays as it is.</p>
      ) : (
        <div className="flex flex-col gap-10">
          <p>
            The amount replaces any earlier commitment from them and counts toward the round once
            they are in {wonLabel}.
          </p>
          {inWon ? null : (
            <Checkbox
              checked={move}
              onChange={(e) => setMove(e.target.checked)}
              label={`Move to ${wonLabel}`}
            />
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

/**
 * The round fields of one participant (SYSTEM §4.4 item 3): follow-up date and note, soft and
 * committed amounts, probability, fit, owner and next step. Saves on change or blur.
 */
export function ParticipantFields({
  client,
  round,
  participant,
  investorName,
  members,
  canWrite,
  onSaved,
  title,
  className,
}: {
  client: ApiClient;
  round: Round;
  participant: Participant;
  investorName: string;
  members: Member[];
  canWrite: boolean;
  onSaved: (p: Participant) => void;
  title?: string;
  className?: string;
}) {
  const p = participant;
  const investorId = p.investor.id;
  const { state, error, save, run } = useParticipantSave(client, round.id, investorId, onSaved);
  const won = round.stages.find((s) => s.kind === "won");

  const [fuNote, setFuNote] = useState(p.follow_up_note ?? "");
  const [soft, setSoft] = useState(moneyInput(p.amount_soft));
  const [committed, setCommitted] = useState(moneyInput(p.amount_committed));
  const [prob, setProb] = useState(p.probability?.toString() ?? "");
  const [next, setNext] = useState(p.next_step ?? "");
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [commit, setCommit] = useState<{ amount: number } | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitErr, setCommitErr] = useState<string | null>(null);

  // Re-sync drafts when another path (board, agent refresh) changes the participant.
  useEffect(() => {
    setFuNote(p.follow_up_note ?? "");
    setSoft(moneyInput(p.amount_soft));
    setCommitted(moneyInput(p.amount_committed));
    setProb(p.probability?.toString() ?? "");
    setNext(p.next_step ?? "");
  }, [p.follow_up_note, p.amount_soft, p.amount_committed, p.probability, p.next_step]);

  const bad = (k: string, msg: string) => setFieldErr((e) => ({ ...e, [k]: msg }));
  const ok = (k: string) =>
    setFieldErr((e) => {
      if (!(k in e)) return e;
      const { [k]: _gone, ...rest } = e;
      return rest;
    });

  const ro = !canWrite;
  const roTitle = ro ? "View only" : undefined;

  const blurSoft = () => {
    const v = parseMoney(soft);
    if (Number.isNaN(v)) return bad("soft", "Use a number like 250000, $250k or 1.5M.");
    ok("soft");
    if ((v ?? null) !== (p.amount_soft ?? null)) void save({ amount_soft: v });
    setSoft(moneyInput(v));
  };
  const blurCommitted = () => {
    const v = parseMoney(committed);
    if (Number.isNaN(v)) return bad("committed", "Use a number like 250000, $250k or 1.5M.");
    ok("committed");
    const amount = v ?? 0;
    if (amount === (p.amount_committed ?? 0)) {
      setCommitted(moneyInput(p.amount_committed));
      return;
    }
    setCommit({ amount });
  };
  const blurProb = () => {
    const v = parseIntIn(prob, 0, 100);
    if (Number.isNaN(v)) return bad("prob", "A whole number from 0 to 100.");
    ok("prob");
    if ((v ?? null) !== (p.probability ?? null)) void save({ probability: v });
  };

  const confirmCommit = async (moveToWon: boolean) => {
    if (!commit) return;
    setCommitBusy(true);
    setCommitErr(null);
    const res = await run(async () => {
      const r = await recordCommitment(client, round.id, investorId, {
        amount: commit.amount,
        move_to_won: moveToWon,
      });
      return r.participant;
    });
    setCommitBusy(false);
    if (res) setCommit(null);
    else setCommitErr("The commitment was not saved. Check the amount and try again.");
  };

  const owners = members;

  return (
    <section className={className} aria-label={title ?? "Round fields"}>
      <SectionLabel aside={<SaveState state={state} />}>{title ?? `In ${round.name}`}</SectionLabel>
      <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
        <Field label="Follow up on">
          <Input
            type="date"
            mono
            max="9999-12-31"
            value={p.follow_up_on ?? ""}
            disabled={ro}
            title={roTitle}
            onChange={(e) => void save({ follow_up_on: e.target.value || null })}
          />
        </Field>
        <Field label="Owner">
          <Select
            value={p.owner?.user_id ?? ""}
            disabled={ro}
            title={roTitle}
            onChange={(e) => void save({ owner_user_id: e.target.value || null })}
          >
            <option value="">No owner</option>
            {owners.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {personName(m)}
                {m.is_you ? " (you)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Follow-up note" className="sm:col-span-2">
          <Textarea
            value={fuNote}
            rows={2}
            maxLength={500}
            placeholder="What it’s for"
            disabled={ro}
            title={roTitle}
            className="min-h-[52px] resize-none [field-sizing:content]"
            onChange={(e) => setFuNote(e.target.value)}
            onBlur={() => {
              const v = fuNote.trim() || null;
              if (v !== (p.follow_up_note ?? null)) void save({ follow_up_note: v });
            }}
          />
        </Field>
        <Field label={`Soft amount (${round.currency})`} error={fieldErr.soft}>
          <Input
            inputMode="decimal"
            mono
            value={soft}
            placeholder="e.g. 250k"
            disabled={ro}
            title={roTitle}
            onChange={(e) => setSoft(e.target.value)}
            onBlur={blurSoft}
          />
        </Field>
        <Field
          label={`Committed (${round.currency})`}
          error={fieldErr.committed}
          hint={won ? `Counts once they are in ${won.label}.` : undefined}
        >
          <Input
            inputMode="decimal"
            mono
            value={committed}
            placeholder="0"
            disabled={ro}
            title={roTitle}
            onChange={(e) => setCommitted(e.target.value)}
            onBlur={blurCommitted}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </Field>
        <Field label="Probability %" error={fieldErr.prob}>
          <Input
            inputMode="numeric"
            mono
            value={prob}
            placeholder="0–100"
            disabled={ro}
            title={roTitle}
            onChange={(e) => setProb(e.target.value)}
            onBlur={blurProb}
          />
        </Field>
        <div className="flex min-w-0 flex-col gap-4">
          <span className="text-[12px] text-muted" id={`fit-${investorId}`}>
            Fit
          </span>
          <div className="flex h-32 items-center">
            <FitMeter
              editable
              value={p.fit}
              disabled={ro}
              label="Fit"
              onChange={(fit) => void save({ fit })}
            />
          </div>
        </div>
        <Field label="Next step" className="sm:col-span-2">
          <Input
            value={next}
            maxLength={500}
            placeholder="What happens next"
            disabled={ro}
            title={roTitle}
            onChange={(e) => setNext(e.target.value)}
            onBlur={() => {
              const v = next.trim() || null;
              if (v !== (p.next_step ?? null)) void save({ next_step: v });
            }}
          />
        </Field>
      </div>
      {error ? <p className={cn("t-body-s mt-8 text-bad")}>{error}</p> : null}
      <CommitmentDialog
        open={commit !== null}
        amount={commit?.amount ?? 0}
        currency={round.currency}
        wonLabel={won?.label ?? "the committed stage"}
        inWon={p.stage.kind === "won"}
        investorName={investorName}
        busy={commitBusy}
        error={commitErr}
        onCancel={() => {
          setCommit(null);
          setCommitErr(null);
          setCommitted(moneyInput(p.amount_committed));
        }}
        onConfirm={(m) => void confirmCommit(m)}
      />
    </section>
  );
}
