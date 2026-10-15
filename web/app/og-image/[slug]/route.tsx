import { renderOg } from "@/components/marketing/og/render";
import { PAGES, ogSlug, pageForOgSlug } from "@/lib/seo/pages";

/**
 * One share card per public page (1200×630 PNG), rendered at build time from the page
 * registry: /og-image/home, /og-image/docs-mcp, /og-image/compare-visible… pageMeta() points
 * og:image and twitter:image here.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((p) => ({ slug: ogSlug(p.path) }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = pageForOgSlug(slug);
  if (!p) return new Response("Not found", { status: 404 });
  const res = await renderOg(p.og);
  res.headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res;
}

