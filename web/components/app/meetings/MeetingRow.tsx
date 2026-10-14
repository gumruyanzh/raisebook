"use client";

import Link from "next/link";
import { useState } from "react";

import { ButtonLink, Chip, Menu, useToast, type MenuEntry } from "@/components/ui";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { downloadMeetingIcs, updateMeeting, type Meeting, type MeetingWrite } from "@/lib/api/meetings";
import { cn } from "@/lib/cn";
import { googleCalendarUrl, isLive, joinLabel, whenLine } from "@/lib/meetings";

import { CompleteMeetingDialog } from "./CompleteMeetingDialog";
import { ScheduleMeetingDialog } from "./ScheduleMeetingDialog";

const STATUS_WORD: Record<Meeting["status"], string> = {
  scheduled: "",
  done: "Done",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/** The menu every meeting has: calendar, edit, outcome, cancel, no-show. */
export function meetingMenu(
  m: Meeting,
  a: { canWrite: boolean; onEdit: () => void; onDone: () => void; onStatus: (s: "cancelled" | "no_show" | "scheduled") => void; onIcs: () => void },
): MenuEntry[] {
  const out: MenuEntry[] = [
    { label: "Download .ics", hint: "Apple, Outlook", onSelect: a.onIcs },
    {
      label: "Add to Google Calendar",
      hint: "↗",
      onSelect: () => window.open(googleCalendarUrl(m), "_blank", "noopener,noreferrer"),
    },
  ];
  if (!a.canWrite) return out;
  out.push({ type: "separator" });
  if (m.status === "scheduled") {
    out.push({ label: "Reschedule or edit…", onSelect: a.onEdit });
    out.push({ label: "Mark done…", onSelect: a.onDone });
    out.push({ label: "They didn't show", onSelect: () => a.onStatus("no_show") });
    out.push({ label: "Cancel meeting", danger: true, onSelect: () => a.onStatus("cancelled") });
  } else if (m.status !== "done") {
    out.push({ label: "Reschedule…", onSelect: a.onEdit });
    out.push({ label: "Reopen", onSelect: () => a.onStatus("scheduled") });
  }
  return out;
}

/**
 * One meeting in a list (Meetings view, Today, round overview, investor files): the time in
 * the viewer's timezone, who and where, a Join button for a video link, the brief, and a
 * menu (calendar, reschedule, done, no-show, cancel). Needing an outcome, the row offers
 * "Add outcome" first.
 */
export function MeetingRow({
  meeting: m,
  client,
  wsSlug,
  timeZone,
  viewerTz,
  today,
  now,
  canWrite,
  onChanged,
  showInvestor = true,
  compact = false,
  extra,
}: {
  meeting: Meeting;
  client: ApiClient;
  wsSlug: string;
  /** Workspace timezone (the edit form's). */
  timeZone: string;
  /** Viewer's timezone (what the row shows). */
  viewerTz: string;
  /** Viewer's today. */
  today: string;
  now: Date;
  canWrite: boolean;
  onChanged: (res: MeetingWrite) => void;
  showInvestor?: boolean;
  compact?: boolean;
  /** A line under the row (the workspace name on the all-companies Today). */
  extra?: React.ReactNode;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const investorHref = `/w/${encodeURIComponent(wsSlug)}/investors/${m.investor.id}`;
  const live = m.status === "scheduled" && isLive(m, now);
  const muted = m.status === "cancelled" || m.status === "no_show";

  const setStatus = async (status: "cancelled" | "no_show" | "scheduled") => {
    try {
      const res = await updateMeeting(client, m.id, { status });
      onChanged(res);
      toast.show(
        status === "cancelled" ? "Meeting cancelled. It stays in the history." : status === "no_show" ? "Marked as a no-show." : "Meeting reopened.",
        status === "scheduled" ? undefined : { label: "Undo", onClick: () => void updateMeeting(client, m.id, { status: "scheduled" }).then(onChanged).catch(() => {}) },
      );
    } catch (err) {
      toast.show(errorMessage(err));
    }
  };
  const ics = async () => {
    try {
      await downloadMeetingIcs(client, m.id);
    } catch (err) {
      toast.show(errorMessage(err));
    }
  };

  const who = [m.investor.name, ...m.guests.map((g) => g.name)].join(", ");
  const place = m.location || (m.video_url ? "Video call" : null);

  return (
    <li className={cn("flex flex-col gap-4 border-b border-line py-10 last:border-b-0", compact ? "px-0" : "px-14")} data-meeting={m.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-10 gap-y-6">
        <span className={cn("t-data shrink-0 tnum", muted ? "text-muted line-through" : "text-fg")}>{whenLine(m, viewerTz, today)}</span>
        {live ? <Chip tone="soon">Now</Chip> : null}
        {m.needs_outcome ? <Chip tone="due">Needs outcome</Chip> : null}
        {STATUS_WORD[m.status] ? <Chip tone="type">{STATUS_WORD[m.status]}</Chip> : null}
        <span className="ml-auto flex shrink-0 items-center gap-6">
          {m.status === "scheduled" && m.video_url && !m.needs_outcome ? (
            <ButtonLink href={m.video_url} external size="sm" variant={live ? "primary" : "secondary"}>
              {joinLabel(m.video_url)}
            </ButtonLink>
          ) : null}
          {m.needs_outcome && canWrite ? (
            <button type="button" className="link t-body-s" onClick={() => setCompleting(true)}>
              Add outcome
            </button>
          ) : null}
          <Link href={`${investorHref}#dossier`} className="link t-body-s whitespace-nowrap" prefetch={false}>
            Open brief
          </Link>
          <Menu
            label={`Meeting with ${m.investor.name}`}
            align="end"
            trigger={<span aria-hidden>⋯</span>}
            triggerClassName="inline-flex size-28 items-center justify-center rounded-sm border border-line bg-surface text-muted hover:text-fg"
            items={meetingMenu(m, { canWrite, onEdit: () => setEditing(true), onDone: () => setCompleting(true), onStatus: (s) => void setStatus(s), onIcs: () => void ics() })}
          />
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {showInvestor ? (
          <Link href={investorHref} className="min-w-0 truncate font-semibold hover:underline">
            {who}
            {m.investor.firm ? <span className="font-normal text-muted"> · {m.investor.firm}</span> : null}
          </Link>
        ) : (
          <span className="min-w-0 truncate font-medium">{m.title}</span>
        )}
        <span className="t-body-s flex min-w-0 flex-wrap gap-x-6 text-muted [&>*+*]:before:mr-6 [&>*+*]:before:content-['·']">
          {showInvestor && m.title !== `Meeting with ${m.investor.name}${m.investor.firm ? ` (${m.investor.firm})` : ""}` ? (
            <span className="min-w-0 truncate">{m.title}</span>
          ) : null}
          {place ? <span className="min-w-0 truncate">{place}</span> : null}
          {m.round ? <span className="shrink-0">{m.round.name}</span> : null}
          {m.created_by.type === "agent" ? <span className="shrink-0 text-agent">by {m.created_by.label}</span> : null}
        </span>
        {m.status === "done" && m.outcome ? <p className="t-body-s line-clamp-2 text-fg/80">{m.outcome}</p> : null}
        {m.agenda && m.status === "scheduled" && !compact ? <p className="t-body-s line-clamp-2 text-muted">{m.agenda}</p> : null}
        {extra}
      </div>
      <ScheduleMeetingDialog
        open={editing}
        onClose={() => setEditing(false)}
        client={client}
        investor={m.investor}
        round={m.round ?? null}
        timeZone={timeZone}
        meeting={m}
        onSaved={(res) => {
          setEditing(false);
          onChanged(res);
          toast.show(res.changed ? `Meeting with ${m.investor.name} saved.` : "Nothing changed.");
        }}
      />
      <CompleteMeetingDialog
        open={completing}
        onClose={() => setCompleting(false)}
        client={client}
        meeting={m}
        timeZone={timeZone}
        onSaved={(res) => {
          setCompleting(false);
          onChanged(res);
          toast.show(res.warnings[0] ?? `Outcome saved on ${m.investor.name}'s timeline.`);
        }}
      />
    </li>
  );
}
