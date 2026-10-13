import type { Metadata } from "next";

import { DocHeader } from "@/components/marketing/docs/Prose";
import { PageShell } from "@/components/marketing/PageShell";
import { VerifyRemoval } from "@/components/marketing/research/VerifyRemoval";

export const metadata: Metadata = {
  title: "Confirm removal",
  robots: { index: false },
};

/** The emailed confirmation link for a research removal request lands here. */
export default async function VerifyRemovalPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <PageShell>
      <DocHeader eyebrow="Research Policy" title="Confirm your removal request" />
      <VerifyRemoval token={token ?? null} />
    </PageShell>
  );
}
