/**
 * Public site constants (SPEC §10). Values come from NEXT_PUBLIC_* env at build time, with the
 * production defaults. Snippets on the landing page and in the docs use PUBLIC_API_URL.
 */

const strip = (u: string) => u.replace(/\/+$/, "");

export const SITE_URL = strip(process.env.NEXT_PUBLIC_SITE_URL ?? "https://raisebook.org");
export const PUBLIC_API_URL = strip(
  process.env.NEXT_PUBLIC_PUBLIC_API_URL ?? "https://api.raisebook.org",
);
export const MCP_URL = `${PUBLIC_API_URL}/mcp`;
export const REPO_URL = strip(
  process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/gumruyanzh/raisebook",
);
/** Placeholder until sponsorship is set up. Donations never buy features. */
export const SPONSOR_URL =
  process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://github.com/sponsors/gumruyanzh";

/** The date the MCP client snippets were last checked against each client's own docs. */
export const SNIPPETS_CHECKED_ON = "2026-10-10";

/** Number of MCP tools (SPEC §6.4). */
export const MCP_TOOL_COUNT = 15;
