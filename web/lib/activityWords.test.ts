import assert from "node:assert/strict";
import { test } from "node:test";

import { coveredByResearch, fieldList } from "./activityWords";
import type { Activity } from "./api/types";

const act = (kind: string, data: Record<string, unknown>) => ({ kind, data }) as unknown as Activity;

test("fieldList: people's words for column names, each once", () => {
  assert.equal(fieldList(["linkedin_url", "website_url"]), "LinkedIn, website");
  assert.equal(fieldList(["email", "check_min", "check_max", "stage_focus"]), "email, check size, stage focus");
});

test("coveredByResearch: research fills are not shown twice; accepted suggestions stay", () => {
  assert.equal(coveredByResearch(act("investor_updated", { source: "research", fields: ["email"] })), true);
  assert.equal(coveredByResearch(act("participant_updated", { source: "research", changes: { fit: { from: 0, to: 3 } } })), true);
  assert.equal(coveredByResearch(act("investor_updated", { source: "research", suggestion_id: "s1" })), false);
  assert.equal(coveredByResearch(act("investor_updated", { fields: ["email"] })), false);
  assert.equal(coveredByResearch(act("research", { event: "dossier" })), false);
});
