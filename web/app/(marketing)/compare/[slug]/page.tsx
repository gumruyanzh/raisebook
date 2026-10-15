import type { Metadata } from "next";

import { ComparePage } from "@/components/marketing/seo/ComparePage";
import { pageMeta } from "@/components/marketing/site";
import { COMPARISONS } from "@/lib/seo/competitors";

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return pageMeta(`/compare/${slug}`);
}

export default async function Compare({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ComparePage slug={slug} />;
}
