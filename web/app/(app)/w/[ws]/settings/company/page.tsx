import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional, workspaceFor } from "@/components/app/load";
import { CompanyProfileSettings } from "@/components/app/research/CompanyProfileSettings";
import { getAiSettings, getCompanyProfile } from "@/lib/api/research";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Company profile" };

/** Settings → Company profile (RESEARCH-PLAN §8.2): the R6 fields, with a website/deck prefill. */
export default async function CompanyProfilePage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { client } = await workspaceFor(ws);
  const res = await load(async () => {
    const [profile, ai] = await Promise.all([getCompanyProfile(client), optional(getAiSettings(client), null)]);
    return { profile, ai };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="The company profile could not load" retryHref={`/w/${ws}/settings/company`} />;
  return <CompanyProfileSettings {...res.data} />;
}
