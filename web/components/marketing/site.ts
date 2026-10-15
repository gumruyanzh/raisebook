/**
 * Public site constants (SPEC §10). Values come from NEXT_PUBLIC_* env at build time, with the
 * production defaults. Snippets on the landing page and in the docs use PUBLIC_API_URL.
 */

import type { Metadata } from "next";

import { ogPath, page } from "@/lib/seo/pages";

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

/** Number of MCP tools every server serves (SPEC §6.4 and the meeting tools of §6.8). */
export const MCP_TOOL_COUNT = 21;

/**
 * Metadata for a public page from the registry in lib/seo/pages.ts: title, description,
 * canonical URL, and the share card (og:url, og:title, og:description, og:image, twitter).
 * Each page has its own generated card at /og-image/<slug> (app/og-image/[slug]/route.tsx).
 */
export function pageMeta(path: string): Metadata {
  const p = page(path);
  const fullTitle = p.absoluteTitle ?? `${p.title} · Raisebook`;
  const image = {
    url: ogPath(path),
    width: 1200,
    height: 630,
    alt: `Raisebook share card: ${p.og.title} ${p.og.subtitle}`,
  };
  return {
    title: p.absoluteTitle ? { absolute: p.absoluteTitle } : p.title,
    description: p.description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Raisebook",
      locale: "en_US",
      url: path,
      title: fullTitle,
      description: p.description,
      images: [image],
    },
    twitter: { card: "summary_large_image", title: fullTitle, description: p.description, images: [image] },
  };
}
