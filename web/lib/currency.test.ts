import assert from "node:assert/strict";
import { test } from "node:test";

import { currencyOption, currencyOptions, guessCurrency } from "./currency";
import { rankOptions } from "./rank";
import { COUNTRY_ALIASES, ZONE_TABLE } from "./tz/data";
import { registerZoneData } from "./tz/index";

const asOptions = () => currencyOptions().map((c) => ({ label: c.code, keywords: c.keywords, code: c.code }));
const first = (q: string) => rankOptions(asOptions(), q)[0]?.code;

test("search by code, name, symbol and country", () => {
  for (const q of ["eur", "euro", "€", "EUR"]) assert.equal(first(q), "EUR", q);
  for (const q of ["dram", "armenia", "AMD", "֏"]) assert.equal(first(q), "AMD", q);
  assert.equal(first("rupee"), "INR");
  assert.equal(first("£"), "GBP");
  assert.equal(first("sterling"), "GBP");
  assert.equal(first("naira"), "NGN");
  assert.equal(first("shekel"), "ILS");
});

test("every ISO code once, common ones first", () => {
  const list = currencyOptions();
  assert.equal(new Set(list.map((c) => c.code)).size, list.length);
  assert.ok(list.length > 100);
  assert.deepEqual(list.slice(0, 3).map((c) => c.code), ["USD", "EUR", "GBP"]);
  assert.ok(list.every((c) => /^[A-Z]{3}$/.test(c.code)));
});

test("names and symbols come from Intl", () => {
  const amd = currencyOption("amd");
  assert.equal(amd.code, "AMD");
  assert.equal(amd.name, "Armenian Dram");
  assert.equal(currencyOption("NGN").symbol, "₦");
  assert.equal(currencyOption("CHF").symbol, "CHF");
});

test("guessCurrency: timezone first, then locale, then USD", () => {
  assert.equal(guessCurrency({ timeZone: "Asia/Yerevan" }), "AMD"); // hub fallback, no data yet
  registerZoneData(ZONE_TABLE, COUNTRY_ALIASES);
  assert.equal(guessCurrency({ timeZone: "Africa/Lagos", locale: "en-US" }), "NGN");
  assert.equal(guessCurrency({ timeZone: "Asia/Calcutta" }), "INR");
  assert.equal(guessCurrency({ timeZone: "Europe/Berlin", locale: "en-US" }), "EUR");
  assert.equal(guessCurrency({ timeZone: "UTC", locale: "en-GB" }), "GBP");
  assert.equal(guessCurrency({ timeZone: "UTC", locale: "hy-AM" }), "AMD");
  assert.equal(guessCurrency({ timeZone: "UTC", locale: "fr" }), "EUR");
  assert.equal(guessCurrency({}), "USD");
});
