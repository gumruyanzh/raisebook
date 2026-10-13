"use client";

import type { ReactNode } from "react";

import { CurrencyPicker, DateField, Field, Input, Segmented, Textarea } from "@/components/ui";
import type { InputProps } from "@/components/ui/Field";
import type { RoundInput } from "@/lib/api/rounds";
import type { Instrument, Round } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { currencySymbol } from "@/lib/format";
import { useOptionalWorkspace } from "@/lib/session";
import { browserTimeZone } from "@/lib/tz";

import { moneyInput, parseMoney } from "./util";

export interface RoundDraft {
  name: string;
  target: string;
  currency: string;
  instrument: Instrument;
  cap: string;
  preMoney: string;
  closeOn: string;
  notes: string;
}

export function draftFromRound(r?: Partial<Round> | null, defaultCurrency = "USD"): RoundDraft {
  return {
    name: r?.name ?? "Seed",
    // 0 is how the API stores "no target"; show it as empty.
    target: r?.target_amount ? moneyInput(r.target_amount) : "",
    currency: r?.currency ?? defaultCurrency,
    instrument: r?.instrument ?? "safe",
    cap: moneyInput(r?.valuation_cap ?? null),
    preMoney: moneyInput(r?.pre_money_valuation ?? null),
    closeOn: r?.target_close_on ?? "",
    notes: r?.notes ?? "",
  };
}

/**
 * Validate a draft into an API body. Returns field errors keyed by draft field when the input
 * cannot be read. An empty target is left out on create (the round has no target) and sent as
 * 0 on update (which clears it: the API stores "no target" as 0).
 */
export function roundBody(
  d: RoundDraft,
  { update = false }: { update?: boolean } = {},
): { body?: RoundInput & { name: string }; errors: Partial<Record<keyof RoundDraft, string>> } {
  const errors: Partial<Record<keyof RoundDraft, string>> = {};
  const name = d.name.trim();
  if (!name) errors.name = "Give the round a name, like Seed or Pre-seed.";
  const target = parseMoney(d.target);
  if (Number.isNaN(target)) errors.target = "Use a number like 2000000, $2M or 750k.";
  const cap = parseMoney(d.cap);
  if (Number.isNaN(cap)) errors.cap = "Use a number like 16M.";
  const pre = parseMoney(d.preMoney);
  if (Number.isNaN(pre)) errors.preMoney = "Use a number like 12M.";
  if (Object.keys(errors).length) return { errors };
  const priced = d.instrument === "priced";
  const body: RoundInput & { name: string } = {
    name,
    currency: d.currency,
    instrument: d.instrument,
    valuation_cap: priced ? null : (cap || null),
    pre_money_valuation: priced ? (pre || null) : null,
    target_close_on: d.closeOn || null,
    notes: d.notes.trim() ? d.notes : null,
  };
  if (target !== null) body.target_amount = target;
  else if (update) body.target_amount = 0;
  return { errors, body };
}

/** A money input with the currency symbol inside the box, so "2,000,000" reads as money. */
export function MoneyInput({ currency, className, ...rest }: InputProps & { currency: string }) {
  const sym = currencySymbol(currency);
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-9 -translate-y-1/2 font-mono text-sm text-muted"
      >
        {sym}
      </span>
      <Input
        inputMode="decimal"
        mono
        {...rest}
        className={className}
        style={{ paddingLeft: `${14 + sym.length * 8}px` }}
      />
    </div>
  );
}

const INSTRUMENTS: { value: Instrument; label: string }[] = [
  { value: "safe", label: "SAFE" },
  { value: "priced", label: "Priced" },
  { value: "convertible_note", label: "Note" },
  { value: "other", label: "Other" },
];

/** The round terms fields, shared by onboarding, "New round" and round settings. */
export function RoundFields({
  draft,
  onChange,
  errors = {},
  disabled,
  showNotes,
  hint,
  className,
  timeZone,
}: {
  draft: RoundDraft;
  onChange: (d: RoundDraft) => void;
  errors?: Partial<Record<keyof RoundDraft, string>>;
  disabled?: boolean;
  showNotes?: boolean;
  hint?: ReactNode;
  className?: string;
  /** Calendar for the close date's quick picks; defaults to the workspace's (or the browser's). */
  timeZone?: string;
}) {
  const set = <K extends keyof RoundDraft>(k: K, v: RoundDraft[K]) => onChange({ ...draft, [k]: v });
  const priced = draft.instrument === "priced";
  const ws = useOptionalWorkspace();
  const tz = timeZone ?? ws?.workspace.timezone ?? browserTimeZone();
  return (
    <div className={cn("grid grid-cols-1 gap-12 sm:grid-cols-2", className)}>
      <Field label="Round name" error={errors.name} className="sm:col-span-2">
        <Input value={draft.name} maxLength={80} disabled={disabled} onChange={(e) => set("name", e.target.value)} placeholder="Seed" />
      </Field>
      <Field label="Target amount" optional error={errors.target} hint="2M, 750k or 2,000,000 all work.">
        <MoneyInput
          currency={draft.currency}
          value={draft.target}
          disabled={disabled}
          onChange={(e) => set("target", e.target.value)}
          onBlur={() => {
            const v = parseMoney(draft.target);
            if (!Number.isNaN(v)) set("target", moneyInput(v));
          }}
          placeholder="e.g. 2M"
        />
      </Field>
      <Field label="Currency">
        <CurrencyPicker value={draft.currency} disabled={disabled} onChange={(c) => set("currency", c)} />
      </Field>
      <div className="flex flex-col gap-4 sm:col-span-2">
        <span className="text-[12px] text-muted" id="instrument-label">
          Instrument
        </span>
        <Segmented
          label="Instrument"
          value={draft.instrument}
          onChange={(v) => !disabled && set("instrument", v)}
          className="self-start"
          options={INSTRUMENTS.map((i) => ({ ...i, disabled }))}
        />
      </div>
      {priced ? (
        <Field label="Pre-money valuation" optional error={errors.preMoney}>
          <MoneyInput
            currency={draft.currency}
            value={draft.preMoney}
            disabled={disabled}
            onChange={(e) => set("preMoney", e.target.value)}
            onBlur={() => {
              const v = parseMoney(draft.preMoney);
              if (!Number.isNaN(v)) set("preMoney", moneyInput(v));
            }}
            placeholder="e.g. 12M"
          />
        </Field>
      ) : (
        <Field label="Valuation cap" optional error={errors.cap}>
          <MoneyInput
            currency={draft.currency}
            value={draft.cap}
            disabled={disabled}
            onChange={(e) => set("cap", e.target.value)}
            onBlur={() => {
              const v = parseMoney(draft.cap);
              if (!Number.isNaN(v)) set("cap", moneyInput(v));
            }}
            placeholder="e.g. 16M"
          />
        </Field>
      )}
      <Field label="Target close date" optional>
        <DateField
          value={draft.closeOn || null}
          timeZone={tz}
          quickPicks="deadline"
          placeholder="Set a close date"
          disabled={disabled}
          onChange={(d) => set("closeOn", d ?? "")}
        />
      </Field>
      {showNotes ? (
        <Field label="Notes" optional className="sm:col-span-2">
          <Textarea value={draft.notes} disabled={disabled} maxLength={20000} onChange={(e) => set("notes", e.target.value)} placeholder="Lead criteria, use of funds, what the round is for." />
        </Field>
      ) : null}
      {hint ? <p className="t-body-s text-muted sm:col-span-2">{hint}</p> : null}
    </div>
  );
}
