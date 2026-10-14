/**
 * Words for activity rows (the timeline and feeds): column names as people say them, fit
 * levels, and which rows a research row already covers. Pure; unit-tested.
 */

import type { Activity } from "./api/types";

const FIELD_WORD: Record<string, string> = {
  linkedin_url: "LinkedIn",
  website_url: "website",
  x_url: "X",
  check_min: "check size",
  check_max: "check size",
  stage_focus: "stage focus",
  follow_up_on: "follow-up",
  follow_up_note: "follow-up note",
  amount_soft: "soft amount",
  owner_user_id: "owner",
};
export const FIT_WORD: Record<number, string> = { 0: "unset", 1: "Low", 2: "Low", 3: "Maybe", 4: "Warm", 5: "Hot" };

/** "LinkedIn, website, check size": people's words for column names, each once. */
export function fieldList(fields: readonly unknown[]): string {
  const words: string[] = [];
  for (const f of fields) {
    const w = FIELD_WORD[String(f)] ?? String(f).replaceAll("_", " ");
    if (!words.includes(w)) words.push(w);
  }
  return words.join(", ");
}

/**
 * Research writes back through the normal edit paths, so each fill is also an
 * ``investor_updated`` / ``participant_updated`` row. The research row already says what it
 * filled, so those are not shown twice (an accepted suggestion is a person's act and stays).
 */
export function coveredByResearch(a: Activity): boolean {
  const d = a.data ?? {};
  return (a.kind === "investor_updated" || a.kind === "participant_updated") && d.source === "research" && !d.suggestion_id;
}
