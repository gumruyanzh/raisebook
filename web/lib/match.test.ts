import assert from "node:assert/strict";
import { test } from "node:test";

import { matchRanges, rankBy, scoreText } from "./match";

test("scoreText: prefix beats word prefix beats substring; every word must match", () => {
  assert.ok(scoreText("Harper Coldridge", "harp") > scoreText("Abel Harper", "harp"));
  assert.ok(scoreText("Abel Harper", "harp") > scoreText("Sharpe Fund", "harp"));
  assert.equal(scoreText("Dana Whitfield", "dana x"), 0);
  assert.ok(scoreText("São Paulo Capital", "sao") > 0);
});

test("rankBy keeps ties in their original order", () => {
  const r = rankBy(["Go to pipeline", "Go to overview", "New investor"], "go", (s) => s);
  assert.deepEqual(r, ["Go to pipeline", "Go to overview"]);
});

test("matchRanges merges overlapping words", () => {
  assert.deepEqual(matchRanges("Harper Coldridge", "harp col"), [
    [0, 4],
    [7, 10],
  ]);
});
