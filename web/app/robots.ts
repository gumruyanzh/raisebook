import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://raisebook.org").replace(/\/$/, "");

/**
 * Index the marketing site, docs, /llms.txt and the share cards; keep crawlers out of the app
 * and the one-time auth links. /signin is crawlable on purpose: it carries noindex, and a
 * crawler has to fetch it to see that. AI and answer-engine crawlers get the same rules by
 * name, because some only read a group that names them.
 */
const DISALLOW = ["/w/", "/app", "/account", "/onboarding", "/auth/", "/invite/", "/design", "/kit", "/research-policy/verify"];

const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "Bingbot",
  "CCBot",
  "DuckAssistBot",
  "MistralAI-User",
  "Meta-ExternalAgent",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: DISALLOW },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
