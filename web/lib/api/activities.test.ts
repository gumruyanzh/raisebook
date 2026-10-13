import assert from "node:assert/strict";
import { test } from "node:test";

import { dropUndone, similarKeyOf } from "./activities";
import type { Activity } from "./types";

const nora = { type: "user", label: "Nora Vance", user_id: "u1", via: "web" } as Activity["actor"];
const agent = { type: "agent", label: "claude-code", api_key_id: "k1", via: "mcp" } as Activity["actor"];

const act = (over: Partial<Activity>): Activity =>
  ({
    id: Math.random().toString(36).slice(2),
    kind: "participant_updated",
    actor: nora,
    occurred_at: "2026-10-12T17:57:00Z",
    investor_id: "i1",
    investor_name: "Dana Whitfield",
    body: null,
    data: {},
    ...over,
  }) as Activity;

test("similarKeyOf: same actor, kind and fields match regardless of field order", () => {
  const a = act({ data: { changes: { owner: 1, probability: 2 } } });
  const b = act({ investor_id: "i2", data: { changes: { probability: 3, owner: 4 } } });
  assert.equal(similarKeyOf(a), similarKeyOf(b));
  assert.ok(similarKeyOf(a));
});

test("similarKeyOf: a different actor, field set or follow-up date does not match", () => {
  const a = act({ data: { changes: { owner: 1 } } });
  assert.notEqual(similarKeyOf(a), similarKeyOf(act({ actor: agent, data: { changes: { owner: 1 } } })));
  assert.notEqual(similarKeyOf(a), similarKeyOf(act({ data: { changes: { owner: 1, probability: 1 } } })));
  const f1 = act({ kind: "follow_up_set", data: { to: "2026-10-15", note: "Deck" } });
  const f2 = act({ kind: "follow_up_set", data: { to: "2026-10-16", note: "Deck" } });
  assert.notEqual(similarKeyOf(f1), similarKeyOf(f2));
});

test("similarKeyOf: conversations, commitments and real runs never group this way", () => {
  assert.equal(similarKeyOf(act({ kind: "note", body: "Met at demo day" })), null);
  assert.equal(similarKeyOf(act({ kind: "commitment", data: { amount: 50000 } })), null);
  assert.equal(similarKeyOf(act({ data: { bulk_id: "b1", changes: { owner: 1 } } })), null);
});

test("dropUndone: a move and its Undo vanish together; unrelated rows stay", () => {
  const move = act({ id: "m", kind: "stage_change", occurred_at: "2026-10-12T17:57:00Z", data: { from: { key: "new" }, to: { key: "contacted" } } });
  const undo = act({ id: "u", kind: "stage_change", occurred_at: "2026-10-12T17:57:05Z", data: { from: { key: "contacted" }, to: { key: "new" }, undo: true, bulk_id: "b" } });
  const note = act({ id: "n", kind: "note", occurred_at: "2026-10-12T17:50:00Z", body: "Met" });
  assert.deepEqual(dropUndone([undo, move, note]).map((a) => a.id), ["n"]);
  // A follow-up and its undo.
  const fu = act({ id: "f", kind: "follow_up_set", occurred_at: "2026-10-12T17:57:00Z", data: { from: null, to: "2026-10-19" } });
  const fuUndo = act({ id: "g", kind: "follow_up_set", occurred_at: "2026-10-12T17:57:03Z", data: { from: "2026-10-19", to: null, undo: true } });
  assert.deepEqual(dropUndone([fuUndo, fu]), []);
  // Another person's move is not what this Undo reverted; too old is not either.
  assert.equal(dropUndone([undo, act({ ...move, actor: agent })]).length, 2);
  assert.equal(dropUndone([undo, act({ ...move, occurred_at: "2026-10-12T17:30:00Z" })]).length, 2);
  // Without an Undo nothing changes.
  assert.deepEqual(dropUndone([move, note]).map((a) => a.id), ["m", "n"]);
});
