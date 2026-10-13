"use client";

import { useEffect, useMemo, useState } from "react";

import { COMMON_CURRENCY_CODES, currencyOption, currencyOptions, guessCurrency, type CurrencyOption } from "@/lib/currency";
import { rankOptions } from "@/lib/rank";
import { loadZoneData, zoneDataLoaded } from "@/lib/tz";

import { Combobox, Highlight, type ComboboxOption } from "./Combobox";

export interface CurrencyPickerProps {
  /** ISO 4217 code. */
  value: string;
  onChange: (code: string) => void;
  /** Pins a "Suggested" currency guessed from a timezone and/or locale. */
  suggestFrom?: { timeZone?: string | null; locale?: string | null };
  disabled?: boolean;
  size?: "sm" | "md";
  tone?: "form" | "toolbar";
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
}

type CurOption = ComboboxOption<string> & { cur: CurrencyOption };

function toOption(c: CurrencyOption, group?: string): CurOption {
  return {
    value: c.code,
    label: c.code,
    description: c.name,
    hint: c.symbol !== c.code ? c.symbol : undefined,
    keywords: c.keywords,
    group,
    cur: c,
  };
}

/**
 * Searchable currency picker (UX pass 1, P0-3): every ISO 4217 code, matched on the code, the
 * name, the symbol (€, £) and the country (Armenia → AMD). Pinned: the current value, the
 * guess for the founder's timezone/locale, then the common ones.
 */
export function CurrencyPicker({
  value,
  onChange,
  suggestFrom,
  disabled,
  size = "md",
  tone,
  id,
  name,
  className,
  ...aria
}: CurrencyPickerProps) {
  const code = (value || "USD").toUpperCase();
  const tz = suggestFrom?.timeZone ?? null;
  const locale = suggestFrom?.locale ?? null;
  const [ready, setReady] = useState(zoneDataLoaded);

  // The guess needs the zone → country table for zones outside the founder hubs.
  useEffect(() => {
    if (!tz || ready) return;
    let live = true;
    loadZoneData().then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [tz, ready]);

  const guess = useMemo(
    () => (tz || locale ? guessCurrency({ timeZone: tz, locale }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tz, locale, ready],
  );

  const options = useMemo(() => currencyOptions().map((c) => toOption(c, "All currencies")), []);

  const pinned = useMemo(() => {
    const out: CurOption[] = [];
    const seen = new Set<string>();
    const add = (c: string, group: string) => {
      if (seen.has(c)) return;
      seen.add(c);
      out.push(toOption(currencyOption(c), group));
    };
    add(code, "Current");
    if (guess) add(guess, "Suggested");
    for (const c of COMMON_CURRENCY_CODES) add(c, "Common");
    return out;
  }, [code, guess]);

  const current = currencyOption(code);

  return (
    <Combobox<string>
      {...aria}
      id={id}
      name={name}
      className={className}
      size={size}
      tone={tone}
      disabled={disabled}
      value={code}
      options={options}
      pinned={pinned}
      filter={(opts, q) => rankOptions(opts, q).map((o) => ({ ...o, group: undefined }))}
      popoverMinWidth={360}
      onChange={(v) => v && onChange(v)}
      searchPlaceholder="Code, name, symbol or country"
      emptyText={(q) => <>No currency matches &ldquo;{q}&rdquo;. Try a code like EUR, a name, or a country.</>}
      renderValue={() => (
        <span className="flex min-w-0 items-baseline gap-8">
          <span className="font-mono text-sm font-medium">{current.code}</span>
          <span className="truncate text-muted">{current.name !== current.code ? current.name : ""}</span>
        </span>
      )}
      renderOption={(o, { query }) => {
        const c = (o as CurOption).cur;
        return (
          <>
            <span className="w-36 shrink-0 font-mono text-sm font-medium">
              <Highlight text={c.code} query={query} />
            </span>
            <span className="min-w-0 flex-1 truncate text-fg">
              <Highlight text={c.name} query={query} />
            </span>
            {c.symbol !== c.code ? <span className="t-micro shrink-0 text-muted">{c.symbol}</span> : null}
          </>
        );
      }}
    />
  );
}
