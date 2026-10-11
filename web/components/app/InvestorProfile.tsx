"use client";

import { useEffect, useState } from "react";

import { Field, Input, SaveState, SectionLabel, Select } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { updateInvestor, type InvestorUpdate } from "@/lib/api/investors";
import type { Investor, InvestorType } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";

import { moneyInput, parseMoney } from "./util";

type TextKey =
  | "name"
  | "firm"
  | "title"
  | "email"
  | "linkedin_url"
  | "website_url"
  | "x_url"
  | "location"
  | "check_note"
  | "source"
  | "warm_intro_by";
type ListKey = "stage_focus" | "industries" | "tags";
type MoneyKey = "check_min" | "check_max";

// Placeholders never look like data: an empty fact shows a dash.
const EMPTY = "—";
const TEXT: { key: TextKey; label: string; placeholder?: string; type?: string; wide?: boolean }[] = [
  { key: "name", label: "Name", wide: true },
  { key: "firm", label: "Firm" },
  { key: "title", label: "Title" },
  { key: "email", label: "Email", type: "email" },
  { key: "location", label: "Location" },
  { key: "linkedin_url", label: "LinkedIn" },
  { key: "website_url", label: "Website" },
  { key: "x_url", label: "X" },
];
const LISTS: { key: ListKey; label: string; placeholder: string }[] = [
  { key: "stage_focus", label: "Invests at", placeholder: EMPTY },
  { key: "industries", label: "Industries", placeholder: EMPTY },
  { key: "tags", label: "Tags (comma-separated)", placeholder: EMPTY },
];
const MORE: { key: TextKey; label: string; placeholder?: string }[] = [
  { key: "source", label: "Source" },
  { key: "warm_intro_by", label: "Warm intro by" },
];

const splitList = (s: string) =>
  s
    .split(/[;,|]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The Profile form on the investor page (SYSTEM §4.8): every contact field, edited inline and
 * saved on blur. Email and LinkedIn conflicts with another contact are shown on the field.
 */
export function InvestorProfile({
  client,
  investor,
  currency,
  canWrite,
  onSaved,
}: {
  client: ApiClient;
  investor: Investor;
  currency: string;
  canWrite: boolean;
  onSaved: (inv: Investor) => void;
}) {
  const fromInv = (inv: Investor) => ({
    ...Object.fromEntries(TEXT.concat(MORE).map((f) => [f.key, inv[f.key] ?? ""])),
    ...Object.fromEntries(LISTS.map((f) => [f.key, inv[f.key].join(", ")])),
    check_min: moneyInput(inv.check_min),
    check_max: moneyInput(inv.check_max),
    check_note: inv.check_note ?? "",
  }) as Record<TextKey | ListKey | MoneyKey, string>;

  const [d, setD] = useState(() => fromInv(investor));
  const [type, setType] = useState<InvestorType>(investor.type);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setD(fromInv(investor));
    setType(investor.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investor.updated_at]);

  const save = async (key: string, patch: InvestorUpdate) => {
    setState("saving");
    try {
      const inv = await updateInvestor(client, investor.id, patch);
      setErrors((e) => {
        const { [key]: _x, ...rest } = e;
        return rest;
      });
      setState("saved");
      onSaved(inv);
    } catch (err) {
      setState("error");
      let msg = errorMessage(err);
      if (err instanceof ApiError && err.code === "duplicate") {
        msg = `Another contact already has this ${key === "email" ? "email" : "LinkedIn profile"}.`;
      } else if (err instanceof ApiError) {
        const fe = err.fieldErrors;
        msg = fe[key] ?? msg;
      }
      setErrors((e) => ({ ...e, [key]: msg }));
    }
  };

  const blurText = (key: TextKey) => {
    const v = d[key].trim();
    const cur = (investor[key] ?? "") as string;
    if (v === cur) return;
    if (key === "name" && !v) {
      setErrors((e) => ({ ...e, name: "A contact needs a name." }));
      return;
    }
    void save(key, { [key]: v || null } as InvestorUpdate);
  };
  const blurList = (key: ListKey) => {
    const v = splitList(d[key]);
    if (v.join("|") === investor[key].join("|")) return;
    void save(key, { [key]: v } as InvestorUpdate);
  };
  const blurMoney = (key: MoneyKey) => {
    const v = parseMoney(d[key]);
    if (Number.isNaN(v)) {
      setErrors((e) => ({ ...e, [key]: "Use a number like 250k or 1M." }));
      return;
    }
    if ((v ?? null) === (investor[key] ?? null)) return;
    setD((x) => ({ ...x, [key]: moneyInput(v) }));
    void save(key, { [key]: v } as InvestorUpdate);
  };

  const ro = !canWrite;
  const input = (key: TextKey, label: string, placeholder?: string, type?: string, wide?: boolean) => (
    <Field key={key} label={label} error={errors[key]} className={wide ? "sm:col-span-2" : undefined}>
      <Input
        tone="inline"
        type={type}
        value={d[key]}
        disabled={ro}
        placeholder={placeholder ?? EMPTY}
        maxLength={key.endsWith("_url") ? 500 : key === "email" ? 254 : 200}
        onChange={(e) => setD((x) => ({ ...x, [key]: e.target.value }))}
        onBlur={() => blurText(key)}
      />
    </Field>
  );

  return (
    <section aria-label="Profile">
      <SectionLabel aside={<SaveState state={state} />}>Profile</SectionLabel>
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2 [&_input]:-mx-9 [&_input]:w-[calc(100%+18px)] [&_select]:-mx-9 [&_select]:w-[calc(100%+18px)]">
        {TEXT.slice(0, 3).map((f) => input(f.key, f.label, f.placeholder, f.type, f.wide))}
        <Field label="Type">
          <Select
            tone="inline"
            value={type}
            disabled={ro}
            onChange={(e) => {
              const t = e.target.value as InvestorType;
              setType(t);
              void save("type", { type: t });
            }}
          >
            {(Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => (
              <option key={t} value={t}>
                {INVESTOR_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {TEXT.slice(3).map((f) => input(f.key, f.label, f.placeholder, f.type, f.wide))}
        <Field label="Check size" error={errors.check_note} className="sm:col-span-2" hint={ro ? undefined : "Free text, e.g. “$250k–$1M, leads”. Min and max are read from it when empty."}>
          <Input
            tone="inline"
            value={d.check_note}
            disabled={ro}
            maxLength={200}
            placeholder={EMPTY}
            onChange={(e) => setD((x) => ({ ...x, check_note: e.target.value }))}
            onBlur={() => blurText("check_note")}
          />
        </Field>
        {(["check_min", "check_max"] as MoneyKey[]).map((k) => (
          <Field key={k} label={`${k === "check_min" ? "Min" : "Max"} check (${currency})`} error={errors[k]}>
            <Input
              tone="inline"
              mono
              inputMode="decimal"
              value={d[k]}
              disabled={ro}
              placeholder={EMPTY}
              onChange={(e) => setD((x) => ({ ...x, [k]: e.target.value }))}
              onBlur={() => blurMoney(k)}
            />
          </Field>
        ))}
        {LISTS.map((f) => (
          <Field key={f.key} label={f.label} error={errors[f.key]}>
            <Input
              tone="inline"
              value={d[f.key]}
              disabled={ro}
              placeholder={f.placeholder}
              onChange={(e) => setD((x) => ({ ...x, [f.key]: e.target.value }))}
              onBlur={() => blurList(f.key)}
            />
          </Field>
        ))}
        {MORE.map((f) => input(f.key, f.label, f.placeholder))}
      </div>
    </section>
  );
}
