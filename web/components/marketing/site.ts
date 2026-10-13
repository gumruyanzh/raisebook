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
/**
 * Where donations go. Empty (the default) until a sponsor page is live: every "Support
 * Raisebook" button is then hidden and /support says donations are not open yet. Donations
 * never buy features.
 */
export const SPONSOR_URL = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "").trim();

/** The date the MCP client snippets were last checked against each client's own docs. */
export const SNIPPETS_CHECKED_ON = "2026-10-10";

/** Number of MCP tools (SPEC §6.4). */
export const MCP_TOOL_COUNT = 17;

/**
 * Canonical URL plus the share card (og:url, og:type, og:site_name, og:image) for a public
 * page. A page that sets `openGraph` replaces its parents' (including the generated
 * opengraph-image), so the image is named here: public/og/*.png are the renders of
 * app/(marketing)/opengraph-image.tsx and docs/opengraph-image.tsx (re-save them when those
 * change). "/" and "/docs" still get the generated image from their own segment.
 */
export function pageMeta(path: string) {
  const image = path.startsWith("/docs") ? "/og/docs.png" : "/og/home.png";
  return {
    alternates: { canonical: path },
    openGraph: {
      type: "website" as const,
      siteName: "Raisebook",
      locale: "en_US",
      url: path,
      images: [{ url: image, width: 1200, height: 630, alt: "Raisebook" }],
    },
  };
}
