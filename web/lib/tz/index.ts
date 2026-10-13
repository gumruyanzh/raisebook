/**
 * Timezones for the TimezonePicker and anything that shows a zone (UX pass 1, P0-2).
 * Built on the platform's Intl APIs only. The search metadata (countries, aliases, ranks) is in
 * `./data`, loaded with `loadZoneData()` the first time a picker opens; everything here works
 * without it, just with plainer labels and a city-only search.
 *
 * The value Raisebook stores is always the canonical IANA id (`canonicalZone`).
 */

import { fold } from "../rank";
import { canonicalZone, LEGACY_ZONES } from "./canonical";
import type { ZoneRow } from "./data";

export { canonicalZone, LEGACY_ZONES };

/** The 12 most-used founder hubs, shown as "Suggested" when the query is empty. */
export const SUGGESTED_ZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Asia/Yerevan",
] as const;

export interface ZoneOption {
  /** Canonical IANA id (`Asia/Yerevan`), or `UTC`. */
  id: string;
  /** `Yerevan`. */
  city: string;
  /** Country (`Armenia`) once the data is loaded, else the id's area (`Asia`). */
  region: string;
  /** `UTC+04:00` at the time of the search. */
  offset: string;
  offsetMinutes: number;
  /** Local wall time at the time of the search: `4:31 PM`. */
  now: string;
  rank: number;
}

/* ---------- ids ---------- */

/** The browser's zone as a canonical id; `UTC` when unknown. */
export function browserTimeZone(): string {
  try {
    return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

let ZONE_IDS: string[] | null = null;

/** Every canonical zone this browser knows, once each, plus `UTC`. */
export function allZoneIds(): string[] {
  if (ZONE_IDS) return ZONE_IDS;
  let raw: string[] = [];
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    raw = sv ? sv("timeZone") : [];
  } catch {
    raw = [];
  }
  if (!raw.length && TABLE) raw = Object.keys(TABLE);
  if (!raw.length) raw = [...SUGGESTED_ZONES];
  const seen = new Set<string>(["UTC"]);
  const ids = ["UTC"];
  for (const r of raw) {
    const id = canonicalZone(r);
    if (seen.has(id) || !usable(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  // Cache only the full list: before the data loads, a fallback list must not stick.
  if (raw.length > SUGGESTED_ZONES.length) ZONE_IDS = ids;
  return ids;
}

/* ---------- Intl formatters (cached per zone; constructing them is the slow part) ---------- */

/** Legacy names per canonical id, for browsers whose ICU predates the rename (Europe/Kyiv). */
const LEGACY_BY_CANON: Record<string, string[]> = {};
for (const [old, canon] of Object.entries(LEGACY_ZONES)) (LEGACY_BY_CANON[canon] ??= []).push(old);

const CLOCK = new Map<string, Intl.DateTimeFormat | null>();

function makeFormatter(id: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  for (const candidate of [id, ...(LEGACY_BY_CANON[id] ?? [])]) {
    try {
      return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: candidate });
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

function clockFormatter(id: string): Intl.DateTimeFormat | null {
  let f = CLOCK.get(id);
  if (f === undefined) {
    f = makeFormatter(id, { hour: "numeric", minute: "2-digit", timeZoneName: "longOffset" });
    CLOCK.set(id, f);
  }
  return f;
}

function usable(id: string): boolean {
  return clockFormatter(id) !== null;
}

/** "GMT+05:30" / "GMT" → minutes east of UTC. */
function parseGmt(s: string): number {
  const m = /([+-−])(\d{1,2})(?::?(\d{2}))?/.exec(s);
  if (!m) return 0;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** `UTC+04:00`, `UTC−07:00` uses an ASCII minus so it can be typed back. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

interface Clock {
  offsetMinutes: number;
  now: string;
}

let clockMinute = -1;
const CLOCKS = new Map<string, Clock>();

/** Offset and wall time for a zone at `at`, cached per minute. */
export function zoneClock(id: string, at: Date = new Date()): Clock {
  const minute = Math.floor(at.getTime() / 60_000);
  if (minute !== clockMinute) {
    CLOCKS.clear();
    clockMinute = minute;
  }
  const hit = CLOCKS.get(id);
  if (hit) return hit;
  const f = clockFormatter(id);
  let clock: Clock = { offsetMinutes: 0, now: "" };
  if (f) {
    const parts = f.formatToParts(at);
    let now = "";
    let tzName = "";
    for (const p of parts) {
      if (p.type === "timeZoneName") tzName = p.value;
      else if (p.type === "hour" || p.type === "minute" || p.type === "dayPeriod") now += p.value;
      else if (p.type === "literal" && now && !/GMT|UTC/.test(p.value)) now += p.value;
    }
    clock = { offsetMinutes: parseGmt(tzName), now: now.trim().replace(/\s+/g, " ") };
  }
  CLOCKS.set(id, clock);
  return clock;
}

/* ---------- labels ---------- */

function cityOf(id: string): string {
  if (id === "UTC") return "UTC";
  const last = id.slice(id.lastIndexOf("/") + 1);
  return last.replace(/_/g, " ");
}

let REGION_NAMES: Intl.DisplayNames | null | undefined;

function countryName(code: string): string {
  if (!code) return "";
  if (REGION_NAMES === undefined) {
    try {
      REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      REGION_NAMES = null;
    }
  }
  try {
    return REGION_NAMES?.of(code) ?? code;
  } catch {
    return code;
  }
}

function regionOf(id: string): string {
  if (id === "UTC") return "Coordinated Universal Time";
  const cc = zoneCountry(id);
  if (cc) return countryName(cc);
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash).replace(/_/g, " ") : "";
}

/** Countries of the suggested hubs, so they resolve before `./data` loads. */
const HUB_COUNTRY: Record<string, string> = {
  "America/Los_Angeles": "US",
  "America/New_York": "US",
  "America/Chicago": "US",
  "Europe/London": "GB",
  "Europe/Berlin": "DE",
  "Europe/Paris": "FR",
  "Asia/Jerusalem": "IL",
  "Asia/Dubai": "AE",
  "Asia/Kolkata": "IN",
  "Asia/Singapore": "SG",
  "Asia/Tokyo": "JP",
  "Australia/Sydney": "AU",
  "Asia/Yerevan": "AM",
};

/** ISO 3166 country of a zone (`Asia/Yerevan` → `AM`), or null (UTC, unknown, data not loaded). */
export function zoneCountry(id: string): string | null {
  const canon = canonicalZone(id);
  return TABLE?.[canon]?.[0] || HUB_COUNTRY[canon] || null;
}

/** `{city: "Yerevan", region: "Armenia", offset: "UTC+04:00", now: "4:31 PM"}`. */
export function zoneLabel(
  id: string,
  at: Date = new Date(),
): { city: string; region: string; offset: string; now: string } {
  const canon = canonicalZone(id);
  const c = zoneClock(canon, at);
  return { city: cityOf(canon), region: regionOf(canon), offset: formatOffset(c.offsetMinutes), now: c.now };
}

function option(id: string, at: Date): ZoneOption {
  const c = zoneClock(id, at);
  return {
    id,
    city: cityOf(id),
    region: regionOf(id),
    offset: formatOffset(c.offsetMinutes),
    offsetMinutes: c.offsetMinutes,
    now: c.now,
    rank: TABLE?.[id]?.[1] ?? 0,
  };
}

/* ---------- search data ---------- */

let TABLE: Record<string, ZoneRow> | null = null;
let COUNTRY_ALIASES: Record<string, string> = {};
let loading: Promise<void> | null = null;

/** Install the metadata table (tests call this directly; the app uses `loadZoneData`). */
export function registerZoneData(table: Record<string, ZoneRow>, countryAliases: Record<string, string> = {}) {
  TABLE = table;
  COUNTRY_ALIASES = countryAliases;
  INDEX = null;
  ZONE_IDS = null;
}

export function zoneDataLoaded(): boolean {
  return TABLE !== null;
}

/** Load `./data` once (a separate chunk). Resolves immediately when it is already in. */
export function loadZoneData(): Promise<void> {
  if (TABLE) return Promise.resolve();
  loading ??= import("./data").then(
    (m) => registerZoneData(m.ZONE_TABLE, m.COUNTRY_ALIASES),
    (err) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

interface Entry {
  id: string;
  city: string;
  idText: string;
  aliases: string[];
  abbrs: string[];
  countries: string[];
  generic: string[];
  rank: number;
  order: number;
}

let INDEX: Entry[] | null = null;

function split(s: string | undefined): string[] {
  return s ? s.split("|").map(fold).filter(Boolean) : [];
}

function intlName(id: string, style: "short" | "longGeneric", at: Date): string {
  const f = makeFormatter(id, { timeZoneName: style });
  if (!f) return "";
  return f.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
}

function buildIndex(at: Date): Entry[] {
  const legacyCities: Record<string, string[]> = {};
  for (const [old, canon] of Object.entries(LEGACY_ZONES)) {
    (legacyCities[canon] ??= []).push(fold(old.slice(old.lastIndexOf("/") + 1)), fold(old));
  }
  const ids = allZoneIds();
  return ids.map((id, order) => {
    const row = TABLE?.[id];
    const cc = row?.[0] ?? "";
    const abbrs = split(row?.[3]);
    const generic: string[] = [];
    if (id !== "UTC") {
      const short = intlName(id, "short", at);
      if (short && !/^(GMT|UTC)/.test(short)) abbrs.push(fold(short));
      const g = intlName(id, "longGeneric", at);
      if (g && !/^(GMT|UTC)/.test(g)) generic.push(fold(g));
    }
    const countries = cc ? [fold(countryName(cc)), ...split(COUNTRY_ALIASES[cc])] : [];
    return {
      id,
      city: fold(cityOf(id)),
      idText: fold(id.replace(/\//g, " / ")),
      aliases: [...split(row?.[2]), ...(legacyCities[id] ?? [])],
      abbrs,
      countries,
      generic,
      rank: row?.[1] ?? 0,
      order,
    };
  });
}

function index(at: Date): Entry[] {
  INDEX ??= buildIndex(at);
  return INDEX;
}

const WORD_START = /[\s/\-(.,]/;

function wordPrefix(hay: string, q: string): boolean {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) return false;
    if (i === 0 || WORD_START.test(hay[i - 1]!)) return true;
    from = i + 1;
  }
}

function score(e: Entry, q: string): number {
  if (e.city === q) return 0;
  if (e.aliases.includes(q) || e.abbrs.includes(q)) return 1;
  if (e.city.startsWith(q)) return 2;
  if (e.countries.includes(q)) return 3;
  if (e.aliases.some((a) => a.startsWith(q))) return 3;
  if (wordPrefix(e.city, q)) return 4;
  if (e.countries.some((c) => c.startsWith(q) || wordPrefix(c, q))) return 4;
  if (e.aliases.some((a) => wordPrefix(a, q))) return 4;
  if (e.generic.some((g) => g.startsWith(q))) return 4;
  if (e.generic.some((g) => wordPrefix(g, q))) return 5;
  if (e.idText.includes(q)) return 5;
  if (e.aliases.some((a) => a.includes(q)) || e.generic.some((g) => g.includes(q))) return 6;
  return -1;
}

/**
 * `UTC+4`, `GMT+4`, `+4`, `+04:00`, `UTC-7`, `-0700`, `+5:30`, `utc +05:30` → minutes east of
 * UTC; `null` when the query is not an offset.
 */
export function parseOffsetQuery(query: string): number | null {
  const q = query.trim().toLowerCase().replace(/−/g, "-");
  const m = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(q);
  if (!m) return null;
  const h = Number(m[2]);
  const min = Number(m[3] ?? 0);
  if (h > 14 || min >= 60) return null;
  return (m[1] === "+" ? 1 : -1) * (h * 60 + min);
}

/**
 * Search every zone: cities, countries, aliases (SF, Bay Area, Bangalore), abbreviations
 * (PST, IST, CET) and offsets (UTC+4 matches every zone at +04:00 *now*, DST-aware). An
 * empty query lists every zone by offset, then city. Results are canonical ids, once each.
 */
export function searchZones(query: string, at: Date = new Date()): ZoneOption[] {
  const entries = index(at);
  const off = parseOffsetQuery(query);
  if (off !== null) {
    return entries
      .filter((e) => zoneClock(e.id, at).offsetMinutes === off)
      .sort((a, b) => b.rank - a.rank || a.city.localeCompare(b.city))
      .map((e) => option(e.id, at));
  }
  const q = fold(query);
  if (!q) {
    return entries
      .map((e) => option(e.id, at))
      .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city));
  }
  const hits: { e: Entry; s: number }[] = [];
  for (const e of entries) {
    const s = score(e, q);
    if (s >= 0) hits.push({ e, s });
  }
  hits.sort((a, b) => a.s - b.s || b.e.rank - a.e.rank || a.e.order - b.e.order);
  return hits.map((h) => option(h.e.id, at));
}

/** One zone as a picker option (pinned rows, the trigger). */
export function zoneOption(id: string, at: Date = new Date()): ZoneOption {
  return option(canonicalZone(id), at);
}
