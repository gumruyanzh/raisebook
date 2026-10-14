"use client";

import { useEffect, useState } from "react";

import { Button, ConfirmDialog, SecretReveal, SectionLabel, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { createCalendarFeed, getCalendarFeed, revokeCalendarFeed, type CalendarFeed, type CalendarFeedCreated } from "@/lib/api/meetings";
import { formatDate, relativeTime } from "@/lib/format";

/**
 * Account → Calendar: a private ICS feed of every meeting in every workspace you belong to,
 * for Google, Apple or Outlook Calendar to subscribe to. The URL is a secret shown once;
 * "New URL" replaces it and "Turn off" revokes it. No Google sign-in is involved.
 */
export function CalendarFeedSettings({ today }: { today: string }) {
  const toast = useToast();
  const [feed, setFeed] = useState<CalendarFeed | null>(null);
  const [created, setCreated] = useState<CalendarFeedCreated | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "off" | null>(null);

  useEffect(() => {
    getCalendarFeed(api)
      .then(setFeed)
      .catch(() => setFeed({ active: false }));
  }, []);

  const make = async () => {
    setBusy(true);
    try {
      const res = await createCalendarFeed(api);
      setCreated(res);
      setFeed(res);
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const off = async () => {
    setBusy(true);
    try {
      await revokeCalendarFeed(api);
      setCreated(null);
      setFeed({ active: false });
      toast.show("Calendar feed turned off. Subscribed calendars stop updating.");
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <section aria-label="Calendar" id="calendar" className="scroll-mt-80">
      <SectionLabel>Calendar</SectionLabel>
      <p className="t-body-s max-w-[68ch] text-muted">
        Subscribe to your meetings from Google Calendar, Apple Calendar or Outlook. The feed covers every workspace you belong to and
        updates when a meeting moves or is cancelled. Anyone with the URL can read it, so keep it to yourself.
      </p>
      <div className="mt-10 flex flex-col gap-10">
        {created ? (
          <>
            <SecretReveal secret={created.url} label="Your calendar feed URL (shown once)" />
            <p className="t-body-s text-muted">
              Google Calendar: Other calendars → <b className="font-medium text-fg">From URL</b>, paste it. Apple Calendar:{" "}
              <a className="link" href={created.webcal_url}>
                open in Calendar
              </a>
              . Calendars refresh on their own schedule (Google: every few hours).
            </p>
          </>
        ) : feed?.active ? (
          <p className="t-body-s">
            A feed URL ending in <span className="t-data">…{feed.token_hint}</span> is on
            {feed.created_at ? `, created ${formatDate(feed.created_at.slice(0, 10), today)}` : ""}
            {feed.last_used_at ? `, last read ${relativeTime(feed.last_used_at)}` : ", not read by a calendar yet"}.
          </p>
        ) : feed ? (
          <p className="t-body-s">No feed yet.</p>
        ) : null}
        <div className="flex flex-wrap gap-8">
          {feed?.active ? (
            <>
              <Button onClick={() => setConfirm("rotate")} disabled={busy}>
                New URL
              </Button>
              <Button variant="danger-quiet" onClick={() => setConfirm("off")} disabled={busy}>
                Turn off
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => void make()} busy={busy ? "Creating…" : false} disabled={!feed}>
              Create calendar feed
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "off" ? "Turn off the calendar feed?" : "Replace the feed URL?"}
        confirmLabel={confirm === "off" ? "Turn off" : "Replace URL"}
        busyLabel={confirm === "off" ? "Turning off…" : "Replacing…"}
        busy={busy}
        danger={confirm === "off"}
        onConfirm={() => (confirm === "off" ? off() : make())}
      >
        {confirm === "off"
          ? "Calendars subscribed to it stop updating. You can create a new feed any time."
          : "The current URL stops working; subscribe again with the new one."}
      </ConfirmDialog>
    </section>
  );
}
