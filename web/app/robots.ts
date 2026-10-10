import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://raisebook.org").replace(/\/$/, "");

/** Index the marketing site and docs; keep crawlers out of the app and auth flows. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/w/", "/app", "/account", "/onboarding", "/signin", "/auth/", "/invite/", "/design", "/kit"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
