import assert from "node:assert/strict";
import { test } from "node:test";

import { currencySymbol, money, moneyCompact } from "./format";

test("currencies outside the old list render with their own symbol", () => {
  assert.equal(money(250000, "NGN"), "₦250,000");
  assert.equal(moneyCompact(250000, "NGN"), "₦250k");
  assert.equal(moneyCompact(1_500_000, "AMD"), "֏1.5M");
  assert.equal(currencySymbol("EUR"), "€");
  assert.equal(moneyCompact(200_000, "EUR"), "€200k");
});

test("letter symbols get a space, $ is never borrowed", () => {
  assert.equal(moneyCompact(250000, "CHF"), "CHF 250k");
  assert.equal(currencySymbol("SGD"), "SGD");
  assert.equal(money(2_000_000, "USD"), "$2,000,000");
  assert.equal(moneyCompact(-900, "USD"), "-$900");
});
