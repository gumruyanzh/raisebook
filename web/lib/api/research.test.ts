import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiClient } from "./client";
import { batchBody, bulkTarget, estimateResearch, prefillForm, startBatch } from "./research";

test("bulkTarget: explicit ids win over the round; nothing is an empty body", () => {
  assert.deepEqual(bulkTarget({ investorIds: ["a", "b"], round: "seed" }), { investor_ids: ["a", "b"] });
  assert.deepEqual(bulkTarget({ investorIds: [], round: "seed" }), { round: "seed" });
  assert.deepEqual(bulkTarget({}), {});
});

test("batchBody carries the confirmed total and allow_partial only when asked", () => {
  assert.deepEqual(batchBody("dossier", { investorIds: ["a"] }, 7.4), { kind: "dossier", investor_ids: ["a"], confirm_usd: 7.4 });
  assert.deepEqual(batchBody("identity", { round: "seed" }, 2.9000000004, true), {
    kind: "identity",
    round: "seed",
    confirm_usd: 2.9,
    allow_partial: true,
  });
  assert.equal(batchBody("dossier", { round: "seed" }, -1).confirm_usd, 0);
});

test("prefillForm: only what was given, the deck under its name", async () => {
  const empty = prefillForm({ websiteUrl: "  " });
  assert.equal([...empty.keys()].length, 0);
  const form = prefillForm({ websiteUrl: " https://kestrel.example ", deck: new Blob(["%PDF-1.7"], { type: "application/pdf" }), deckName: "kestrel.pdf" });
  assert.equal(form.get("website_url"), "https://kestrel.example");
  const deck = form.get("deck") as File;
  assert.equal(deck.name, "kestrel.pdf");
  assert.equal(await deck.text(), "%PDF-1.7");
});

test("estimate and batch calls: method, path, workspace header and JSON body", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ kind: "dossier", count: 2, skipped: {}, per_run_usd: 0.2, total_usd: 0.4, remaining_usd: 20, fits: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const c = createApiClient({ baseUrl: "http://api.test", workspace: "kestrel", csrfToken: "t" });
    const e = await estimateResearch(c, "dossier", { investorIds: ["a", "b"] });
    assert.equal(e.total_usd, 0.4);
    await startBatch(c, batchBody("dossier", { investorIds: ["a", "b"] }, 0.4));
    assert.equal(seen[0]!.url, "http://api.test/v1/research/estimate");
    assert.equal(seen[0]!.init.method, "POST");
    assert.equal((seen[0]!.init.headers as Record<string, string>)["X-Workspace"], "kestrel");
    assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { kind: "dossier", investor_ids: ["a", "b"] });
    assert.equal(seen[1]!.url, "http://api.test/v1/research/batches");
    assert.deepEqual(JSON.parse(String(seen[1]!.init.body)), { kind: "dossier", investor_ids: ["a", "b"], confirm_usd: 0.4 });
  } finally {
    globalThis.fetch = realFetch;
  }
});
