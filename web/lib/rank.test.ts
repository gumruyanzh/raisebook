import assert from "node:assert/strict";
import { test } from "node:test";

import { fold, matchRanges, rankOptions } from "./rank";

const opts = (labels: string[], keywords: Record<string, string[]> = {}) =>
  labels.map((label) => ({ label, keywords: keywords[label] }));

test("fold ignores case, diacritics and underscores", () => {
  assert.equal(fold("São_Paulo"), "sao paulo");
  assert.equal(fold("  Zürich  "), "zurich");
});

test("diacritics: 'sao' matches São Paulo", () => {
  const r = rankOptions(opts(["Lisbon", "São Paulo"]), "sao");
  assert.deepEqual(r.map((o) => o.label), ["São Paulo"]);
});

test("exact > prefix > word prefix > keyword > substring > subsequence", () => {
  const list = opts(
    ["Mapleton", "Old Maple", "Ample", "Maple", "Maplewood", "Xylo", "M-a-p-l-e zone"],
    { Xylo: ["maple"] },
  );
  const r = rankOptions(list, "maple").map((o) => o.label);
  assert.deepEqual(r, ["Maple", "Mapleton", "Maplewood", "Old Maple", "Xylo", "M-a-p-l-e zone"]);
});

test("prefix beats substring", () => {
  const r = rankOptions(opts(["Glendale", "Dalesford"]), "dale").map((o) => o.label);
  assert.deepEqual(r, ["Dalesford", "Glendale"]);
});

test("ties keep the original order", () => {
  const r = rankOptions(opts(["Bravo one", "Alpha one", "Charlie one"]), "one").map((o) => o.label);
  assert.deepEqual(r, ["Bravo one", "Alpha one", "Charlie one"]);
});

test("keyword word prefix ('dram' in 'Armenian Dram')", () => {
  const list = [
    { label: "AUD", keywords: ["Australian Dollar"] },
    { label: "AMD", keywords: ["Armenian Dram"] },
  ];
  assert.equal(rankOptions(list, "dram")[0]!.label, "AMD");
});

test("empty query returns everything unchanged", () => {
  const list = opts(["b", "a"]);
  assert.deepEqual(rankOptions(list, "  "), list);
});

test("matchRanges maps folded matches back to the original text", () => {
  assert.deepEqual(matchRanges("São Paulo", "sao"), [[0, 3]]);
  assert.deepEqual(matchRanges("New York", "york"), [[4, 8]]);
  assert.deepEqual(matchRanges("Los_Angeles", "los ang"), [[0, 7]]);
  assert.deepEqual(matchRanges("Zurich", "zch"), [[0, 1], [4, 6]]);
  assert.deepEqual(matchRanges("Zurich", "qq"), []);
});
