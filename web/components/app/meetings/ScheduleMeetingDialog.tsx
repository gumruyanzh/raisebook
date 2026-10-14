"use client";

import { useEffect, useMemo, useState } from "react";

import { Button, Checkbox, Dialog, Field, Input, Segmented, Textarea } from "@/components/ui";
import { DateField } from "@/components/ui/DateField";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { listInvestors } from "@/lib/api/investors";
import { scheduleMeeting, updateMeeting, type Meeting, type MeetingWrite } from "@/lib/api/meetings";
import type { InvestorCompact, Stage } from "@/lib/api/types";
import {
  clock,
  dayOf,
  DURATIONS,
  durationLabel,
  localValue,
  nextSlot,
  parseTime,
  splitLocal,
  viewerTimeZone,
  whenLine,
  zonedToUtc,
} from "@/lib/meetings";
import { todayIn } from "@/lib/format";

/** Same firm after the light normalization the API uses (case, punctuation, "Ventures"…). */
function firmKey(firm: string | null | undefined): string {
  const words = (firm ?? "").toLowerCase().replace(/&/g, " and ").match(/[a-z0-9]+/g) ?? [];
  while (words.length && ["capital", "ventures", "partners", "vc", "fund", "llc", "lp"].includes(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

/**
 * Schedule a meeting with an investor, or reschedule / edit one (`meeting`). The date and
 * time are entered in the workspace timezone (the form says which, and shows the viewer's
 * own time when it differs). In a round, "Move to Meeting" is on by default when the investor
 * is earlier in the pipeline. Guests are other people at the same firm.
 */
export function ScheduleMeetingDialog({
  open,
  onClose,
  client,
  investor,
  round,
  stage,
  stages,
  timeZone,
  meeting,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  investor: Pick<InvestorCompact, "id" | "name" | "firm">;
  /** The round it is for (id or slug and name); omitted: the investor's only open round. */
  round?: { id: string; name: string } | null;
  /** The investor's current stage in that round, and the round's stages (for the move offer). */
  stage?: Stage | null;
  stages?: Stage[];
  timeZone: string;
  /** Edit or reschedule this meeting instead of scheduling a new one. */
  meeting?: Meeting | null;
  onSaved: (res: MeetingWrite) => void;
}) {
  const editing = Boolean(meeting);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [timeText, setTimeText] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [location, setLocation] = useState("");
  const [video, setVideo] = useState("");
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [guestIds, setGuestIds] = useState<string[]>([]);
  const [colleagues, setColleagues] = useState<InvestorCompact[]>([]);
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fill the form each time it opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (meeting) {
      const s = splitLocal(meeting.starts_at, timeZone);
      setDay(s.day);
      setTime(s.time);
      setTimeText(s.time);
      setMinutes(meeting.duration_minutes);
      setLocation(meeting.location ?? "");
      setVideo(meeting.video_url ?? "");
      setTitle(meeting.title);
      setAgenda(meeting.agenda ?? "");
      setGuestIds(meeting.guests.map((g) => g.id));
    } else {
      const slot = nextSlot(new Date(), timeZone);
      // Tomorrow 10:00 reads better than "in 30 minutes" as a default.
      const tomorrow = todayIn(timeZone, new Date(Date.now() + 86_400_000));
      setDay(slot.time >= "18:00" || slot.time < "08:00" ? tomorrow : slot.day);
      setTime(slot.time >= "18:00" || slot.time < "08:00" ? "10:00" : slot.time);
      setTimeText(slot.time >= "18:00" || slot.time < "08:00" ? "10:00" : slot.time);
      setMinutes(30);
      setLocation("");
      setVideo("");
      setTitle("");
      setAgenda("");
      setGuestIds([]);
      setMove(true);
    }
  }, [open, meeting, timeZone]);

  // Colleagues at the same firm, for guests.
  useEffect(() => {
    if (!open || !investor.firm) {
      setColleagues([]);
      return;
    }
    let live = true;
    listInvestors(client, { q: investor.firm, limit: 50 })
      .then((page) => {
        if (!live) return;
        const key = firmKey(investor.firm);
        setColleagues(page.data.filter((i) => i.id !== investor.id && key && firmKey(i.firm) === key));
      })
      .catch(() => live && setColleagues([]));
    return () => {
      live = false;
    };
  }, [open, client, investor.firm, investor.id]);

  const meetingStage = useMemo(
    () => stages?.find((s) => s.key === "meeting") ?? stages?.find((s) => s.label.toLowerCase() === "meeting") ?? null,
    [stages],
  );
  const offerMove =
    !editing &&
    Boolean(round && meetingStage) &&
    (!stage || ((stage.kind === "open" || stage.kind === "active") && stage.position < meetingStage!.position));

  const viewerTz = typeof window === "undefined" ? timeZone : viewerTimeZone();
  const valid = Boolean(day && time);
  const startsLocal = valid ? localValue(day, time) : "";
  // What the viewer will see, when their zone differs from the workspace's.
  const viewerHint = useMemo(() => {
    if (!valid || viewerTz === timeZone) return null;
    try {
      const asUtc = zonedToUtc(day, time, timeZone);
      if (!asUtc) return null;
      const end = new Date(Date.parse(asUtc) + minutes * 60_000).toISOString();
      return `${whenLine({ starts_at: asUtc, ends_at: end }, viewerTz, todayIn(viewerTz))} your time`;
    } catch {
      return null;
    }
  }, [valid, day, time, minutes, timeZone, viewerTz]);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      let res: MeetingWrite;
      if (meeting) {
        const startChanged = dayOf(meeting.starts_at, timeZone) !== day || clock(meeting.starts_at, timeZone) !== time;
        res = await updateMeeting(client, meeting.id, {
          ...(startChanged ? { starts_at: startsLocal } : {}),
          ...(minutes !== meeting.duration_minutes ? { duration_minutes: minutes } : {}),
          title: title.trim() || null,
          location: location.trim() || null,
          video_url: video.trim() || null,
          agenda: agenda.trim() || null,
          guest_ids: guestIds,
        });
      } else {
        res = await scheduleMeeting(client, {
          investor_id: investor.id,
          starts_at: startsLocal,
          duration_minutes: minutes,
          round: round?.id,
          title: title.trim() || undefined,
          location: location.trim() || undefined,
          video_url: video.trim() || undefined,
          agenda: agenda.trim() || undefined,
          guest_ids: guestIds.length ? guestIds : undefined,
          move_to_meeting_stage: offerMove ? move : false,
        });
      }
      onSaved(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={520}
      scrollBody
      title={editing ? `Edit meeting with ${investor.name}` : `Schedule a meeting with ${investor.name}`}
      description={`Times are in ${timeZone.replace(/_/g, " ")}, the workspace timezone.`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} busy={busy ? "Saving…" : false}>
            {editing ? "Save meeting" : "Schedule"}
          </Button>
        </>
      }
    >
      <div className="mt-14 flex flex-col gap-12">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-[1fr_120px]">
          <Field label="Date">
            <DateField value={day || null} onChange={(iso) => setDay(iso ?? "")} timeZone={timeZone} quickPicks="followup" clearable={false} />
          </Field>
          <Field label="Time" error={timeText && !parseTime(timeText) ? "Like 14:30 or 2:30pm" : null}>
            <Input
              value={timeText}
              inputMode="numeric"
              placeholder="10:00"
              onChange={(e) => {
                setTimeText(e.target.value);
                const t = parseTime(e.target.value);
                setTime(t ?? "");
              }}
              onBlur={() => time && setTimeText(time)}
              mono
            />
          </Field>
        </div>
        {viewerHint ? <p className="t-body-s -mt-4 text-muted">{viewerHint}</p> : null}
        <Field label="Length">
          <Segmented
            label="Length"
            size="sm"
            value={String(minutes)}
            onChange={(v) => setMinutes(Number(v))}
            options={[...new Set([...DURATIONS, minutes])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: durationLabel(m) }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
          <Field label="Place" optional>
            <Input value={location} maxLength={500} placeholder="Their office, a café…" onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label="Video link" optional>
            <Input value={video} maxLength={1000} placeholder="https://…" inputMode="url" onChange={(e) => setVideo(e.target.value)} />
          </Field>
        </div>
        <Field label="Title" optional>
          <Input
            value={title}
            maxLength={200}
            placeholder={`Meeting with ${investor.name}${investor.firm ? ` (${investor.firm})` : ""}`}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Agenda" optional>
          <Textarea value={agenda} maxLength={5000} placeholder="What you want to cover" onChange={(e) => setAgenda(e.target.value)} className="min-h-64" />
        </Field>
        {colleagues.length ? (
          <fieldset className="flex flex-col gap-6">
            <legend className="mb-4 text-[12px] text-muted">Also from {investor.firm}</legend>
            {colleagues.slice(0, 10).map((g) => (
              <Checkbox
                key={g.id}
                label={g.name}
                hint={g.title ?? undefined}
                checked={guestIds.includes(g.id)}
                onChange={(e) => setGuestIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))}
              />
            ))}
          </fieldset>
        ) : null}
        {offerMove && meetingStage ? (
          <Checkbox
            label={`Move ${investor.name.split(/\s+/)[0]} to ${meetingStage.label}`}
            hint={stage ? `Now in ${stage.label} in ${round!.name}.` : `Adds them to ${round!.name}.`}
            checked={move}
            onChange={(e) => setMove(e.target.checked)}
          />
        ) : null}
        {error ? <p className="t-body-s text-bad">{error}</p> : null}
      </div>
    </Dialog>
  );
}
