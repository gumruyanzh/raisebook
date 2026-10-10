/**
 * The privacy promise, word for word from SPEC §8.4. The landing page, /privacy and the README
 * use this exact text. Change the spec first, then this file.
 */
export const PRIVACY_PROMISE: { lead: string; body: string }[] = [
  {
    lead: "Your data is yours.",
    body: "A workspace is visible only to its members and to the API keys its owners create.",
  },
  {
    lead: "We never pool, sell, rent or mine it.",
    body: "Raisebook never builds an investor database from your data and never shows one workspace's data to another.",
  },
  {
    lead: "No ads, no trackers.",
    body: "No analytics scripts, pixels or third-party cookies. Fonts are served by Raisebook.",
  },
  {
    lead: "No AI on your data unless you bring it.",
    body: "Raisebook does not send your data to any AI model. Agents you connect use your key, and every action they take is on the timeline.",
  },
  {
    lead: "Leave any time.",
    body: "Export everything as CSV and JSON. Delete your workspace or account permanently, effective immediately.",
  },
  {
    lead: "Check our work.",
    body: "Raisebook is open source under AGPL-3.0, including the code that handles your data.",
  },
];
