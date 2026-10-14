"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { Button, Combobox, Dialog, EmptyState, Field, PageHeader, SectionLabel, useToast, type ComboboxOption } from "@/components/ui";
import { listInvestors } from "@/lib/api/investors";
import { loadMeetings, type Meeting, type MeetingWrite } from "@/lib/api/meetings";
import type { Investor } from "@/lib/api/types";
import { num, plural, todayIn } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import { groupMeetings, whenLine } from "@/lib/meetings";
import { useWorkspace } from "@/lib/session";

import { MeetingRow } from "./MeetingRow";
import { ScheduleMeetingDialog } from "./ScheduleMeetingDialog";
import { useNow, useViewerTimeZone } from "./useViewerTimeZone";

const GROUPS: { key: "needsOutcome" | "today" | "week" | "later" | "past"; title: string; empty?: string }[] = [
  { key: "needsOutcome", title: "Needs an outcome" },
  { key: "today", title: "Today", empty: "Nothing today." },
  { key: "week", title: "This week", empty: "Nothing else this week." },
  { key: "later", title: "Later" },
  { key: "past", title: "Past 30 days" },
];

/**
 * The workspace's Meetings view: past meetings that still need an outcome first (a quick
 * note logs them), then today, this week and later, then the last 30 days. Times show in the
 * viewer's timezone; the form takes workspace time. Schedule (B) asks who, then when.
 */
export function MeetingsView({ initial }: { initial: Meeting[] }) {
  const { workspace, client, canWrite } = useWorkspace();
  const toast = useToast();
  const tz = workspace.timezone;
  const viewerTz = useViewerTimeZone(tz);
  const now = useNow();
  const today = todayIn(viewerTz, now);
  const [items, setItems] = useState(initial);
  const [picking, setPicking] = useState(false);
  const [who, setWho] = useState<Investor | null>(null);

  const groups = useMemo(() => groupMeetings(items, now, viewerTz), [items, now, viewerTz]);
  const upcoming = groups.today.length + groups.week.length + groups.later.length;

  const reload = useCallback(async () => {
    try {
      setItems(await loadMeetings(client));
    } catch {
      // Keep the list on screen; the next change retries.
    }
  }, [client]);

  const changed = useCallback(
    (res: MeetingWrite) => {
      setItems((list) => {
        const rest = list.filter((m) => m.id !== res.meeting.id);
        return [...rest, res.meeting];
      });
      void reload();
    },
    [reload],
  );

  useHotkey("b", () => setPicking(true), { enabled: canWrite, description: "Schedule a meeting", group: "Meetings", blockedByModals: true });

  return (
    <div className="flex flex-col gap-14">
      <PageHeader
        className="mb-0"
        title="Meetings"
        aside={`${plural(upcoming, "upcoming meeting")}${groups.needsOutcome.length ? ` · ${num(groups.needsOutcome.length)} need an outcome` : ""}`}
        actions={
          <>
            <Link href="/account#calendar" className="link t-body-s whitespace-nowrap max-sm:hidden">
              Subscribe in your calendar
            </Link>
            {canWrite ? (
              <Button variant="primary" kbd="B" onClick={() => setPicking(true)}>
                Schedule
              </Button>
            ) : null}
          </>
        }
      />
      {viewerTz !== tz ? (
        <p className="t-body-s -mt-6 text-muted">
          Times are in your timezone ({viewerTz.replace(/_/g, " ")}). The workspace runs on {tz.replace(/_/g, " ")}.
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="No meetings yet"
          actions={
            canWrite ? (
              <Button variant="primary" onClick={() => setPicking(true)}>
                Schedule a meeting
              </Button>
            ) : null
          }
        >
          Schedule meetings from an investor&apos;s file (press B) or here. They show on Today, on the board and in your calendar.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-14 xl:grid-cols-12 xl:items-start">
          <div className="flex min-w-0 flex-col gap-14 xl:col-span-8">
            {GROUPS.filter((g) => g.key !== "past").map((g) => {
              const list = groups[g.key];
              if (!list.length && !g.empty) return null;
              return (
                <section key={g.key} aria-label={g.title} className="rounded-md border border-line bg-surface">
                  <div className="px-14 pt-12 pb-4">
                    <SectionLabel className="mb-0" aside={list.length ? <span className="t-micro text-muted">{num(list.length)}</span> : null}>
                      {g.title}
                    </SectionLabel>
                  </div>
                  {list.length ? (
                    <ul className="m-0 list-none border-t border-line p-0">
                      {list.map((m) => (
                        <MeetingRow
                          key={m.id}
                          meeting={m}
                          client={client}
                          wsSlug={workspace.slug}
                          timeZone={tz}
                          viewerTz={viewerTz}
                          today={today}
                          now={now}
                          canWrite={canWrite}
                          onChanged={changed}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="t-body-s px-14 pb-12 text-muted">{g.empty}</p>
                  )}
                </section>
              );
            })}
          </div>
          <aside className="flex min-w-0 flex-col gap-14 xl:col-span-4" aria-label="Past meetings">
            <section className="rounded-md border border-line bg-surface">
              <div className="px-14 pt-12 pb-4">
                <SectionLabel className="mb-0">Past 30 days</SectionLabel>
              </div>
              {groups.past.length ? (
                <ul className="m-0 list-none border-t border-line p-0">
                  {groups.past.map((m) => (
                    <MeetingRow
                      key={m.id}
                      meeting={m}
                      client={client}
                      wsSlug={workspace.slug}
                      timeZone={tz}
                      viewerTz={viewerTz}
                      today={today}
                      now={now}
                      canWrite={canWrite}
                      onChanged={changed}
                    />
                  ))}
                </ul>
              ) : (
                <p className="t-body-s px-14 pb-12 text-muted">Done, cancelled and no-show meetings show here.</p>
              )}
            </section>
          </aside>
        </div>
      )}

      <PickInvestorDialog
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(inv) => {
          setPicking(false);
          setWho(inv);
        }}
      />
      {who ? (
        <ScheduleMeetingDialog
          open={Boolean(who)}
          onClose={() => setWho(null)}
          client={client}
          investor={who}
          timeZone={tz}
          stages={undefined}
          round={null}
          onSaved={(res) => {
            setWho(null);
            changed(res);
            const moved = res.moved_stage ? ` Moved to ${res.moved_stage.to.label}.` : "";
            toast.show(`Meeting with ${res.meeting.investor.name}, ${whenLine(res.meeting, viewerTz, today)}.${moved}`);
          }}
        />
      ) : null}
    </div>
  );
}

/** "Who is the meeting with?": a contact search (name, firm, email). */
function PickInvestorDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (inv: Investor) => void }) {
  const { client } = useWorkspace();
  const [found, setFound] = useState<Record<string, Investor>>({});
  return (
    <Dialog open={open} onClose={onClose} title="Schedule a meeting" description="Who is it with?">
      <div className="mt-14">
        <Field label="Investor">
          <Combobox<string>
            value={null}
            placeholder="Search your contacts…"
            searchPlaceholder="Name, firm or email"
            loadOptions={async (q) => {
              const page = await listInvestors(client, { q: q || undefined, limit: 30, sort: q ? undefined : "updated", order: q ? undefined : "desc" });
              setFound((f) => ({ ...f, ...Object.fromEntries(page.data.map((i) => [i.id, i])) }));
              return page.data.map((i): ComboboxOption<string> => ({ value: i.id, label: i.name, description: i.firm ?? undefined }));
            }}
            emptyText={(q) => (q ? `No contact matches “${q}”.` : "No contacts yet.")}
            onChange={(id) => {
              const inv = id ? found[id] : null;
              if (inv) onPick(inv);
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}
