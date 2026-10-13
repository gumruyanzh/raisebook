import assert from "node:assert/strict";
import { test } from "node:test";

import type { Stage } from "./api/types";
import { cardMeta, cardPriority, checkRange, closeLikelihood, fitMeta, lastTouch } from "./boardCard";

const st = (key: string, label: string, kind: Stage["kind"]) => ({ key, label, kind });
const NEW = st("new", "New", "open");
const MEETING = st("meeting", "Meeting", "active");
const DD = st("dd", "Diligence", "active");
const WON = st("committed", "Committed", "won");
const LOST = st("passed", "Passed", "lost");

test("closeLikelihood: stage base × (0.6 + 0.1 × fit), with the working in the tooltip", () => {
  assert.deepEqual(closeLikelihood({ stage: MEETING, fit: 5 }), {
    value: 44,
    source: "derived",
    why: "Meeting 40% × fit 5 → 44%",
  });
  // Not rated counts as a neutral 3, not as the lowest fit.
  assert.equal(closeLikelihood({ stage: MEETING, fit: 0 }).value, 36);
  assert.equal(closeLikelihood({ stage: MEETING, fit: 0 }).why, "Meeting 40% × fit not rated (as 3) → 36%");
  assert.equal(closeLikelihood({ stage: NEW, fit: 3 }).value, 5); // 5 × 0.9 = 4.5 → 5
  assert.equal(closeLikelihood({ stage: NEW, fit: 0 }).value, 5);
  assert.equal(closeLikelihood({ stage: st("replied", "Replied", "active"), fit: 4 }).value, 25);
  assert.equal(closeLikelihood({ stage: st("contacted", "Contacted", "active"), fit: 4 }).value, 15);
  assert.equal(closeLikelihood({ stage: st("research", "Researching", "open"), fit: 5 }).value, 11);
  assert.equal(closeLikelihood({ stage: DD, fit: 5 }).value, 66);
});

test("closeLikelihood: won is 100, lost is 0, whatever the fit", () => {
  assert.equal(closeLikelihood({ stage: WON, fit: 0 }).value, 100);
  assert.equal(closeLikelihood({ stage: WON, fit: 0 }).why, "Committed: 100%");
  assert.equal(closeLikelihood({ stage: LOST, fit: 5 }).value, 0);
});

test("closeLikelihood: a custom stage uses its kind's base", () => {
  assert.equal(closeLikelihood({ stage: st("term_sheet", "Term sheet", "active"), fit: 5 }).value, 22);
  assert.equal(closeLikelihood({ stage: st("shortlist", "Shortlist", "open"), fit: 5 }).value, 6);
  assert.equal(closeLikelihood({ stage: st("closed", "Closed", "won"), fit: 2 }).value, 100);
});

test("closeLikelihood: a probability set on the participant wins", () => {
  const l = closeLikelihood({ stage: NEW, fit: 0, probability: 30 });
  assert.deepEqual(l, { value: 30, source: "set", why: "Probability set on this investor: 30%" });
  assert.equal(closeLikelihood({ stage: MEETING, fit: 5, probability: 0 }).value, 0);
  assert.equal(closeLikelihood({ stage: MEETING, fit: 5, probability: 140 }).value, 100);
  assert.equal(closeLikelihood({ stage: MEETING, fit: 5, probability: null }).source, "derived");
});

test("cardPriority follows the app's fit rule", () => {
  assert.equal(cardPriority(5), "hot");
  assert.equal(cardPriority(4), "warm");
  assert.equal(cardPriority(3), "maybe");
  assert.equal(cardPriority(2), "low");
  assert.equal(cardPriority(1), "low");
  assert.equal(cardPriority(0), null); // not rated: no chip, not "Low fit"
});

test("cardMeta: type, first stage focus, first industry; never other; at most 3", () => {
  assert.deepEqual(cardMeta({ type: "vc", stageFocus: ["seed", "series a"], industries: ["Fintech", "Health"] }), [
    "VC",
    "Seed",
    "Fintech",
  ]);
  assert.deepEqual(cardMeta({ type: "corporate_vc" }), ["CVC"]);
  assert.deepEqual(cardMeta({ type: "family_office", industries: ["Other", "Climate"] }), ["Family office", "Climate"]);
  assert.deepEqual(cardMeta({ type: "other", stageFocus: [], industries: ["Other"] }), []);
  assert.deepEqual(cardMeta({ type: "angel", stageFocus: ["pre-seed"] }), ["Angel", "Pre-seed"]);
  assert.deepEqual(cardMeta({}), []);
});

test("checkRange: compact, the second amount without the symbol", () => {
  assert.equal(checkRange(250_000, 1_000_000), "$250k–1M");
  assert.equal(checkRange(1_000_000, 250_000), "$250k–1M");
  assert.equal(checkRange(500_000, 500_000), "$500k");
  assert.equal(checkRange(250_000, null), "$250k+");
  assert.equal(checkRange(null, 1_000_000), "Up to $1M");
  assert.equal(checkRange(null, null), "");
  assert.equal(checkRange(0, 0), "");
  assert.equal(checkRange(50_000, 250_000, "EUR"), "€50k–250k");
});

test("lastTouch: days, then weeks, months, years", () => {
  const today = "2026-10-13";
  assert.equal(lastTouch(null, today), "");
  assert.equal(lastTouch("2026-10-13T08:00:00Z", today, "UTC"), "Today");
  assert.equal(lastTouch("2026-10-12T08:00:00Z", today, "UTC"), "1d ago");
  assert.equal(lastTouch("2026-10-10T08:00:00Z", today, "UTC"), "3d ago");
  assert.equal(lastTouch("2026-09-15T08:00:00Z", today, "UTC"), "4w ago");
  assert.equal(lastTouch("2026-06-01T08:00:00Z", today, "UTC"), "4mo ago");
  assert.equal(lastTouch("2024-10-01T08:00:00Z", today, "UTC"), "2y ago");
  // The workspace calendar decides the day: 03:00 UTC is still yesterday in Los Angeles.
  assert.equal(lastTouch("2026-10-13T03:00:00Z", today, "America/Los_Angeles"), "1d ago");
});

test("fitMeta: drops whole chips from the end, never the check range", () => {
  assert.deepEqual(fitMeta(["VC", "Seed", "Fintech"], "$250k–1M", 206), ["VC", "Seed", "Fintech"]);
  assert.deepEqual(fitMeta(["Family office", "Series A", "Dev tools"], "$25k–100k", 206), ["Family office"]);
  assert.deepEqual(fitMeta(["Family office", "Series A", "Dev tools"], "", 206), ["Family office", "Series A"]);
  assert.deepEqual(fitMeta(["VC"], "$250k–1M", 40), []);
});
