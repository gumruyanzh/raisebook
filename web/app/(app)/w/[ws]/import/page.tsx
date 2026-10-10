import type { Metadata } from "next";

import { ImportFlow } from "@/components/data/ImportFlow";
import { PageHeader, TextLink } from "@/components/ui";

export const metadata: Metadata = { title: "Import investors" };

/** Import (SYSTEM §4.10). `?round=<slug>` preselects the round (from a pipeline's empty state). */
export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ round?: string | string[] }>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const round = Array.isArray(sp.round) ? sp.round[0] : sp.round;
  return (
    <>
      <PageHeader
        title="Import investors"
        subline={
          <>
            A CSV from any spreadsheet, or a Raisebook prototype JSON file. You see every row before anything is
            written. <TextLink href={`/w/${ws}/settings/data`}>Import history and exports</TextLink>
          </>
        }
      />
      <ImportFlow initialRound={round} />
    </>
  );
}
