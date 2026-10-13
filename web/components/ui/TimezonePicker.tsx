"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import {
  allZoneIds,
  canonicalZone,
  loadZoneData,
  searchZones,
  SUGGESTED_ZONES,
  zoneDataLoaded,
  zoneLabel,
  zoneOption,
  type ZoneOption,
} from "@/lib/tz";

import { Combobox, Highlight, type ComboboxOption } from "./Combobox";

export interface TimezonePickerProps {
  /** IANA id; legacy ids (Asia/Calcutta) are shown and saved as canonical ones. */
  value: string;
  onChange: (tz: string) => void;
  /** Usually the browser's zone: pinned as "Your browser" when it differs from `value`. */
  suggest?: string | null;
  disabled?: boolean;
  /** `sm` 28px; `md` 32px, which also shows the local time in the trigger. */
  size?: "sm" | "md";
  tone?: "form" | "toolbar";
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
}

type ZoneRowOption = ComboboxOption<string> & { zone: ZoneOption; tag?: string };

function toOption(z: ZoneOption, group?: string, tag?: string): ZoneRowOption {
  return {
    value: z.id,
    label: z.city,
    description: `${z.region} · ${z.id}`,
    hint: `${z.offset} · ${z.now}`,
    group,
    zone: z,
    tag,
  };
}

/** Ticks once a minute while `active`, so offsets and local times stay current. */
function useMinute(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const msToNext = 60_000 - (Date.now() % 60_000);
    let iv: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      setNow(new Date());
      iv = setInterval(() => setNow(new Date()), 60_000);
    }, msToNext + 50);
    return () => {
      clearTimeout(t);
      if (iv) clearInterval(iv);
    };
  }, [active]);
  return now;
}

/**
 * Searchable timezone picker (UX pass 1, P0-2): cities, countries, aliases (SF, Bay Area,
 * Bangalore), abbreviations (PST, IST, CET) and offsets (UTC+4). Each row shows the UTC offset
 * and the local time now. Always emits the canonical IANA id.
 */
export function TimezonePicker({
  value,
  onChange,
  suggest,
  disabled,
  size = "md",
  tone,
  id,
  name,
  className,
  ...aria
}: TimezonePickerProps) {
  const current = canonicalZone(value || "UTC");
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(zoneDataLoaded);
  const now = useMinute(true);

  useEffect(() => {
    if (!open || ready) return;
    let live = true;
    loadZoneData().then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, ready]);

  // Every zone, by offset then city. Rebuilt once a minute and when the metadata arrives,
  // never on a keystroke.
  const options = useMemo<ZoneRowOption[]>(
    () => (open ? searchZones("", now).map((z) => toOption(z, "All timezones")) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, now, ready],
  );

  const pinned = useMemo<ZoneRowOption[]>(() => {
    if (!open) return [];
    const out: ZoneRowOption[] = [];
    const seen = new Set<string>();
    const add = (zid: string, group: string | undefined, tag?: string) => {
      if (seen.has(zid)) return;
      seen.add(zid);
      out.push(toOption(zoneOption(zid, now), group, tag));
    };
    const browser = suggest ? canonicalZone(suggest) : null;
    if (browser && browser !== current) add(browser, undefined, "Your browser");
    add(current, undefined, "Current");
    add("UTC", undefined);
    for (const z of SUGGESTED_ZONES) if (!seen.has(z)) add(z, "Suggested");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, now, ready, suggest, current]);

  const filter = useCallback(
    (_: ComboboxOption<string>[], q: string) => searchZones(q, now).slice(0, 200).map((z) => toOption(z)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, ready],
  );

  const label = zoneLabel(current, now);
  const known = useMemo(() => current === "UTC" || allZoneIds().includes(current), [current]);

  return (
    <Combobox<string>
      {...aria}
      id={id}
      name={name}
      className={className}
      size={size}
      tone={tone}
      disabled={disabled}
      value={current}
      options={options}
      pinned={pinned}
      filter={filter}
      onOpen={() => setOpen(true)}
      popoverMinWidth={460}
      onChange={(v) => v && onChange(canonicalZone(v))}
      searchPlaceholder="City, country, or UTC+4"
      emptyText={(q) => (
        <>
          No timezone matches &ldquo;{q}&rdquo;. Try a city, a country, or an offset like UTC+4.
        </>
      )}
      renderValue={() => (
        <span className="flex min-w-0 items-baseline gap-8">
          <span className="truncate">{known ? label.city : current}</span>
          <span suppressHydrationWarning className="t-micro shrink-0 text-muted">
            {label.offset}
          </span>
          {size === "md" && label.now ? (
            <span suppressHydrationWarning className="t-body-s hidden shrink-0 text-muted sm:inline">
              · {label.now} now
            </span>
          ) : null}
        </span>
      )}
      renderOption={(o, { query }) => {
        const z = (o as ZoneRowOption).zone;
        const tag = (o as ZoneRowOption).tag;
        return (
          <>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-fg">
                <Highlight text={z.city} query={query} />
              </span>
              <span className="ml-8 text-sm text-muted">
                {tag ? `${tag} · ` : ""}
                {z.id === "UTC" ? "Coordinated Universal Time" : `${z.region} · ${z.id}`}
              </span>
            </span>
            <span className={cn("t-micro shrink-0 text-muted")}>
              {z.offset}
              <span className="max-[400px]:hidden"> · {z.now}</span>
            </span>
          </>
        );
      }}
    />
  );
}
