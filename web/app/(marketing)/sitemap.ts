import type { MetadataRoute } from "next";

import { DOCS_NAV } from "@/components/marketing/docs/nav";
import { SITE_URL } from "@/components/marketing/site";

/** Public pages only. The app, auth flows and /design are disallowed in robots.ts. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-10-10");
  const paths = [
    "/",
    ...DOCS_NAV.map((n) => n.href).filter((h) => h.startsWith("/docs")),
    "/privacy",
    "/terms",
    "/support",
    "/changelog",
  ];
  return paths.map((p) => ({
    url: `${SITE_URL}${p === "/" ? "" : p}`,
    lastModified,
    changeFrequency: p === "/" || p === "/changelog" ? "weekly" : "monthly",
    priority: p === "/" ? 1 : p.startsWith("/docs") ? 0.7 : 0.5,
  }));
}
