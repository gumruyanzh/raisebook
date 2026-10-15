import { llmsFullTxt } from "@/lib/seo/llms";

/** /llms-full.txt (llmstxt.org): Raisebook described for AI assistants, built from the site's own facts. */
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsFullTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
