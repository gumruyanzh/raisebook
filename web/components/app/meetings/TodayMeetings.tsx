"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { SectionLabel } from "@/components/ui";
import { api } from "@/lib/api/client";
import type { Meeting, MeetingWrite } from "@/lib/api/meetings";
import type { Workspace } from "@/lib/api/types";
import { num, todayIn } from "@/lib/format";
import { dayOf } from "@/lib/meetings";

import { MeetingRow } from "./MeetingRow";
import { useNow, useViewerTimeZone } from "./useViewerTimeZone";

export interface CompanyMeetings {
  workspace: Workspace;
  meetings: Meeting[];
}

/**
 * Today's meetings at the top of Today (every company): time in the viewer's timezone, who,
 * where, Join and Open brief. Meetings that ended today without an outcome stay, marked.
 * Renders nothing on a day without meetings.
 */
export function TodayMeetings({ companies, className }: { companies: CompanyMeetings[]; className?: string }) {
  const fallback = companies[0]?.workspace.timezone ?? "UTC";
  const viewerTz = useViewerTimeZone(fallback);
  const now = useNow();
  const today = todayIn(viewerTz, now);
  const [patched, setPatched] = useState<Record<string, Meeting>>({});

  const rows = useMemo(
    () =>
      companies
        .flatMap((c) => c.meetings.map((m) => ({ c, m: patched[m.id] ?? m })))
        .filter(({ m }) => m.status !== "cancelled" && dayOf(m.starts_at, viewerTz) === today)
        .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at)),
    [companies, patched, viewerTz, today],
  );
  if (!rows.length) return null;
  const several = companies.length > 1;

  return (
    <section aria-label="Today's meetings" className={className ?? "rounded-md border border-line bg-surface"}>
      <div className="px-14 pt-12 pb-4">
        <SectionLabel className="mb-0" aside={<span className="t-micro text-muted">{num(rows.length)}</span>}>
          Meetings today
        </SectionLabel>
      </div>
      <ul className="m-0 list-none border-t border-line p-0">
        {rows.map(({ c, m }) => (
          <MeetingRow
            key={m.id}
            meeting={m}
            client={api.ws(c.workspace.slug)}
            wsSlug={c.workspace.slug}
            timeZone={c.workspace.timezone}
            viewerTz={viewerTz}
            today={today}
            now={now}
            canWrite={c.workspace.role !== "viewer"}
            onChanged={(res: MeetingWrite) => setPatched((p) => ({ ...p, [res.meeting.id]: res.meeting }))}
            extra={
              several ? (
                <Link href={`/w/${encodeURIComponent(c.workspace.slug)}/meetings`} className="t-body-s text-muted hover:underline">
                  {c.workspace.name}
                </Link>
              ) : null
            }
          />
        ))}
      </ul>
    </section>
  );
}
