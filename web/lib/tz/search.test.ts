import assert from "node:assert/strict";
import { test } from "node:test";

import { COUNTRY_ALIASES, ZONE_TABLE } from "./data";
import {
  allZoneIds,
  browserTimeZone,
  canonicalZone,
  formatOffset,
  parseOffsetQuery,
  registerZoneData,
  searchZones,
  zoneClock,
  zoneCountry,
  zoneLabel,
} from "./index";

registerZoneData(ZONE_TABLE, COUNTRY_ALIASES);

// A fixed instant (Northern-hemisphere summer time is still on; Sydney is on daylight time).
const AT = new Date("2026-10-12T12:00:00Z");

const first = (q: string) => searchZones(q, AT)[0]?.id;
const ids = (q: string) => searchZones(q, AT).map((z) => z.id);

function expectFirst(zone: string, queries: string[]) {
  for (const q of queries) assert.equal(first(q), zone, `"${q}" should find ${zone} first, got ${ids(q).slice(0, 5).join(", ")}`);
}

test("San Francisco and the Pacific coast", () => {
  expectFirst("America/Los_Angeles", ["San Francisco", "SF", "bay area", "Seattle", "PST", "PT", "pacific", "palo alto"]);
});

test("Yerevan", () => {
  expectFirst("Asia/Yerevan", ["Yerevan", "yere", "Armenia", "AMT"]);
});

test("offsets match every zone at that offset now, and nothing else", () => {
  for (const q of ["UTC+4", "+4", "GMT+4", "+04:00", "utc +4"]) {
    const r = searchZones(q, AT);
    const found = r.map((z) => z.id);
    assert.ok(found.includes("Asia/Yerevan"), q);
    assert.ok(found.includes("Asia/Dubai"), q);
    assert.ok(r.every((z) => z.offsetMinutes === 240), q);
    assert.ok(found.indexOf("Asia/Dubai") < found.indexOf("Europe/Samara"), "hubs before Samara");
    assert.ok(found.indexOf("Asia/Yerevan") < found.indexOf("Europe/Samara"), "hubs before Samara");
  }
  const la = searchZones("UTC-7", AT);
  assert.ok(la.some((z) => z.id === "America/Los_Angeles"), "LA is UTC-7 in October");
  assert.ok(la.every((z) => z.offsetMinutes === -420));
  assert.equal(searchZones("-0700", AT)[0]?.id, la[0]?.id);
});

test("India and IST", () => {
  expectFirst("Asia/Kolkata", ["+5:30", "IST", "Kolkata", "Calcutta", "Mumbai", "Bangalore", "Bengaluru", "india"]);
  const ist = ids("IST");
  assert.ok(ist.includes("Asia/Jerusalem"));
  assert.ok(ist.includes("Europe/Dublin"));
});

test("renamed cities", () => {
  expectFirst("Europe/Kyiv", ["Kyiv", "Kiev"]);
  expectFirst("Asia/Ho_Chi_Minh", ["Ho Chi Minh", "Saigon"]);
});

test("US east, UK, central Europe, Brazil, UTC", () => {
  expectFirst("America/New_York", ["NYC", "new york", "EST", "ET", "boston"]);
  expectFirst("Europe/London", ["london", "UK", "BST"]);
  expectFirst("Europe/Berlin", ["CET", "berlin"]);
  expectFirst("America/Sao_Paulo", ["sao paulo", "São Paulo"]);
  expectFirst("UTC", ["utc"]);
  expectFirst("Asia/Dubai", ["dubai", "UAE", "GST"]);
  expectFirst("Asia/Jerusalem", ["tel aviv", "israel"]);
});

test("canonical ids only, once each", () => {
  assert.equal(canonicalZone("Asia/Calcutta"), "Asia/Kolkata");
  assert.equal(canonicalZone("Europe/Kiev"), "Europe/Kyiv");
  assert.equal(canonicalZone("US/Pacific"), "America/Los_Angeles");
  assert.equal(canonicalZone("Etc/UTC"), "UTC");
  assert.equal(canonicalZone("GMT"), "UTC");
  assert.equal(canonicalZone("Asia/Yerevan"), "Asia/Yerevan");
  const all = allZoneIds();
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.includes("Asia/Kolkata") && !all.includes("Asia/Calcutta"));
  assert.ok(all.includes("UTC"));
  const listed = searchZones("", AT).map((z) => z.id);
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(!listed.includes("Asia/Calcutta"));
  assert.ok(ZONE_TABLE["Asia/Kolkata"] && !ZONE_TABLE["Asia/Calcutta"]);
});

test("labels: city, country, offset and local time", () => {
  const l = zoneLabel("Asia/Yerevan", AT);
  assert.deepEqual(l, { city: "Yerevan", region: "Armenia", offset: "UTC+04:00", now: "4:00 PM" });
  assert.equal(zoneLabel("Asia/Calcutta", AT).offset, "UTC+05:30");
  assert.equal(zoneLabel("UTC", AT).city, "UTC");
  assert.equal(formatOffset(-420), "UTC-07:00");
  assert.equal(zoneClock("America/Los_Angeles", AT).offsetMinutes, -420);
  assert.equal(zoneCountry("Asia/Yerevan"), "AM");
  assert.equal(zoneCountry("UTC"), null);
  assert.equal(typeof browserTimeZone(), "string");
});

test("offset parsing", () => {
  assert.equal(parseOffsetQuery("UTC+4"), 240);
  assert.equal(parseOffsetQuery("+5:30"), 330);
  assert.equal(parseOffsetQuery("-0700"), -420);
  assert.equal(parseOffsetQuery("GMT−3"), -180);
  assert.equal(parseOffsetQuery("utc"), null);
  assert.equal(parseOffsetQuery("4"), null);
  assert.equal(parseOffsetQuery("+25"), null);
});

test("search is fast: under 2ms per keystroke over the full list", () => {
  searchZones("warm", AT); // builds the index once
  const keystrokes = ["s", "sa", "san", "san ", "san f", "san fr", "y", "ye", "yer", "+", "+4", "ist", "berl", "kolk", "nyc", "pacific"];
  const rounds = 10;
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) for (const k of keystrokes) searchZones(k, AT);
  const per = (performance.now() - t0) / (rounds * keystrokes.length);
  assert.ok(per < 2, `${per.toFixed(3)}ms per keystroke`);
});
