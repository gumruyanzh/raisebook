"use client";

import { useEffect, useState } from "react";

import { Button, Dialog, Field, Input, Textarea } from "@/components/ui";
import { DateField } from "@/components/ui/DateField";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { completeMeeting, type Meeting, type MeetingWrite } from "@/lib/api/meetings";
import { todayIn } from "@/lib/format";
import { addDays } from "@/lib/dates";

/**
 * "How did it go?": marking a meeting done asks for a quick outcome (logged as a meeting on
 * the timeline) and, for an investor in a round, the next step and the follow-up date (one
 * week out by default).
 */
export function CompleteMeetingDialog({
  open,
  onClose,
  client,
  meeting,
  timeZone,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  meeting: Meeting | null;
  timeZone: string;
  onSaved: (res: MeetingWrite) => void;
}) {
  const [outcome, setOutcome] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [follow, setFollow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inRound = Boolean(meeting?.round);

  useEffect(() => {
    if (!open) return;
    setOutcome("");
    setNextStep("");
    setFollow(addDays(todayIn(timeZone), 7));
    setError(null);
  }, [open, timeZone]);

  const save = async () => {
    if (!meeting || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await completeMeeting(client, meeting.id, {
        outcome: outcome.trim() || undefined,
        next_step: inRound ? nextStep.trim() || undefined : undefined,
        follow_up_on: inRound ? follow || undefined : undefined,
      });
      onSaved(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const first = meeting?.investor.name.split(/\s+/)[0] ?? "them";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={meeting ? `How did it go with ${first}?` : "Meeting outcome"}
      description="A line or two is enough. It goes on the timeline as the meeting."
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy ? "Saving…" : false} kbd="⌘↵">
            Mark done
          </Button>
        </>
      }
    >
      <div className="mt-14 flex flex-col gap-12">
        <Field label="Outcome">
          <Textarea
            autoFocus
            value={outcome}
            maxLength={5000}
            placeholder="Interested; wants the cohort data before a partner meeting."
            onChange={(e) => setOutcome(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            className="min-h-96"
          />
        </Field>
        {inRound ? (
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-[1fr_190px]">
            <Field label="Next step" optional>
              <Input value={nextStep} maxLength={500} placeholder="Send the cohort data" onChange={(e) => setNextStep(e.target.value)} />
            </Field>
            <Field label="Follow up" optional>
              <DateField value={follow} onChange={setFollow} timeZone={timeZone} quickPicks="followup" />
            </Field>
          </div>
        ) : (
          <p className="t-body-s text-muted">Not tied to a round, so there is no next step or follow-up to set.</p>
        )}
        {error ? <p className="t-body-s text-bad">{error}</p> : null}
      </div>
    </Dialog>
  );
}
