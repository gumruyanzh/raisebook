import type { Metadata } from "next";

import { A, C, DocHeader, DocPagerFor, DocTable, H2, Note, P, Ul } from "@/components/marketing/docs/Prose";
import { pageMeta } from "@/components/marketing/site";

export const metadata: Metadata = pageMeta("/docs/meetings");

export default function MeetingsDocs() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · Meetings"
        title="Meetings and the calendar feed"
        lede={
          <p>
            Schedule investor meetings where the investor lives, see what is on today, record how each one went, and keep every
            meeting in Google Calendar, Apple Calendar or Outlook with a private feed.
          </p>
        }
      />

      <H2>Schedule a meeting</H2>
      <P>
        Open an investor&apos;s file and schedule a meeting, or press <C>B</C> on the Meetings page. A meeting has a time, a length
        (30 minutes by default), and optionally a title, location, video link, agenda and up to 10 guests from the same firm. Times
        are entered in the workspace timezone and shown in yours.
      </P>
      <Ul>
        <li>
          Scheduling in a round moves the investor to the round&apos;s Meeting stage when they are earlier in the pipeline. A later
          stage (Diligence) is never moved back, and a closed round is never touched.
        </li>
        <li>Scheduling the same investor at the same start again returns the existing meeting, so retries are safe.</li>
        <li>Meetings can be up to a year back and two years ahead.</li>
      </Ul>

      <H2>Today, the board and the Meetings page</H2>
      <P>
        Today lists the day&apos;s meetings; board cards show an investor&apos;s next meeting; the Meetings page lists what is
        upcoming and which past meetings still need an outcome.
      </P>

      <H2>Record the outcome</H2>
      <P>
        After the meeting, mark it done and write the outcome and the next step. The outcome lands on the investor&apos;s timeline,
        and the next step can set the follow-up date. A meeting can also be cancelled or marked as a no-show; cancelling keeps the
        history, and rescheduling brings it back.
      </P>

      <H2>Calendar files and the feed</H2>
      <DocTable
        caption="Calendar options"
        head={["Option", "What it does"]}
        monoFirst={false}
        minWidth={420}
        rows={[
          [<b key="a" className="font-semibold">.ics per meeting</b>, "Download one meeting as a calendar file."],
          [
            <b key="b" className="font-semibold">Private feed</b>,
            "Account → Calendar creates a feed URL (shown once). It covers every workspace you belong to, 60 days back to 400 days ahead, and updates when a meeting moves or is cancelled.",
          ],
        ]}
      />
      <Ul>
        <li>
          <b>Google Calendar:</b> Other calendars → From URL, paste the feed URL. Google refreshes it every few hours.
        </li>
        <li>
          <b>Apple Calendar:</b> use the &ldquo;open in Calendar&rdquo; link (a <C>webcal://</C> URL).
        </li>
        <li>
          <b>Outlook:</b> add a calendar from the internet and paste the feed URL.
        </li>
      </Ul>
      <Note label="Keep the URL to yourself">
        <p>
          Anyone with the feed URL can read it. Creating a new one replaces the old URL, and turning the feed off stops it at once.
        </p>
      </Note>

      <H2>From an agent or the API</H2>
      <P>
        Agents use <C>schedule_meeting</C>, <C>list_meetings</C>, <C>update_meeting</C> and <C>complete_meeting</C> (
        <A href="/docs/mcp-tools">MCP tools</A>). The REST API has <C>/v1/meetings</C>, <C>/v1/meetings/{"{id}"}/ics</C> and{" "}
        <C>/v1/me/calendar-feed</C> (<A href="/docs/api">REST API</A>). Times without an offset are read in the workspace timezone.
      </P>

      <DocPagerFor href="/docs/meetings" />
    </>
  );
}
