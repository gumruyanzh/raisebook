import type { MetadataRoute } from "next";

import { SITE_URL } from "@/components/marketing/site";
import { PAGES } from "@/lib/seo/pages";

/**
 * Every public page from the registry (lib/seo/pages.ts), with the date its text last
 * changed. The app, auth flows and /design are disallowed in robots.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({
    url: `${SITE_URL}${p.path === "/" ? "" : p.path}`,
    lastModified: new Date(`${p.updated}T00:00:00Z`),
    changeFrequency: p.path === "/" || p.path === "/changelog" ? "weekly" : "monthly",
    priority:
      p.path === "/" ? 1 : p.section === "product" || p.section === "compare" ? 0.8 : p.section === "guide" || p.section === "docs" ? 0.7 : 0.5,
  }));
}
