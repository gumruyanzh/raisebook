"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, SectionLabel, useToast } from "@/components/ui";
import type { ApiClient } from "@/lib/api/client";
import { listMeetings, type Meeting, type MeetingWrite } from "@/lib/api/meetings";
import type { InvestorCompact, Participant, Stage } from "@/lib/api/types";
import { todayIn } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import { whenLine } from "@/lib/meetings";

import { MeetingRow } from "./MeetingRow";
import { ScheduleMeetingDialog } from "./ScheduleMeetingDialog";
import { useNow, useViewerTimeZone } from "./useViewerTimeZone";

/**
 * "Next meeting" in the investor sheet and on the investor page: the scheduled meetings
 * (and any that ended without an outcome), with Schedule (B). Scheduling in a round may move
 * the investor to Meeting; the new participant goes back through `onParticipantChange`.
 */
export function NextMeeting({
  client,
  wsSlug,
  investor,
  round,
  stage,
  stages,
  timeZone,
  canWrite,
  hotkeys = true,
  hotkeyPriority = 1,
  onParticipantChange,
  onChanged,
}: {
  client: ApiClient;
  wsSlug: string;
  investor: Pick<InvestorCompact, "id" | "name" | "firm" | "title" | "type" | "tags">;
  round?: { id: string; name: string } | null;
  stage?: Stage | null;
  stages?: Stage[];
  timeZone: string;
  canWrite: boolean;
  /** B schedules (only while this block is the active file). */
  hotkeys?: boolean;
  hotkeyPriority?: number;
  onParticipantChange?: (p: Participant) => void;
  /** A meeting changed (refresh the timeline). */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<Meeting[] | null>(null);
  const [open, setOpen] = useState(false);
  const viewerTz = useViewerTimeZone(timeZone);
  const now = useNow();
  const today = todayIn(viewerTz, now);

  const load = useCallback(async () => {
    const [up, due] = await Promise.all([
      listMeetings(client, { investor_id: investor.id, when: "upcoming", limit: 5 }),
      listMeetings(client, { investor_id: investor.id, when: "needs_outcome", order: "desc", limit: 3 }),
    ]);
    setItems([...due.data, ...up.data]);
  }, [client, investor.id]);

  useEffect(() => {
    setItems(null);
    void load().catch(() => setItems([]));
  }, [load]);

  useHotkey("b", () => setOpen(true), {
    priority: hotkeyPriority,
    enabled: hotkeys && canWrite,
    description: "Schedule a meeting",
    group: "Investor file",
  });

  const changed = (res: MeetingWrite) => {
    if (res.participant) onParticipantChange?.(res.participant);
    void load().catch(() => {});
    onChanged?.();
  };

  return (
    <section aria-label="Next meeting">
      <SectionLabel
        aside={
          canWrite ? (
            <Button size="sm" onClick={() => setOpen(true)} kbd="B">
              Schedule
            </Button>
          ) : null
        }
      >
        Next meeting
      </SectionLabel>
      {items === null ? (
        <p className="t-body-s text-muted">Loading meetings…</p>
      ) : items.length === 0 ? (
        <p className="t-body-s text-muted">
          Nothing scheduled.{canWrite ? <span className="touch:hidden"> Press B to schedule a meeting.</span> : ""}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.map((m) => (
            <MeetingRow
              key={m.id}
              meeting={m}
              client={client}
              wsSlug={wsSlug}
              timeZone={timeZone}
              viewerTz={viewerTz}
              today={today}
              now={now}
              canWrite={canWrite}
              showInvestor={false}
              compact
              onChanged={changed}
            />
          ))}
        </ul>
      )}
      {canWrite ? (
        <ScheduleMeetingDialog
          open={open}
          onClose={() => setOpen(false)}
          client={client}
          investor={investor}
          round={round}
          stage={stage}
          stages={stages}
          timeZone={timeZone}
          onSaved={(res) => {
            setOpen(false);
            changed(res);
            const when = whenLine(res.meeting, viewerTz, today);
            const moved = res.moved_stage ? ` Moved to ${res.moved_stage.to.label}.` : "";
            const note = res.warnings[0] ? ` ${res.warnings[0]}` : "";
            toast.show(res.created ? `Meeting with ${investor.name} on ${when}.${moved}${note}` : "That meeting is already scheduled.");
          }}
        />
      ) : null}
    </section>
  );
}
