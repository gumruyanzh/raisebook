import type { Metadata } from "next";

import { A, C, DocTable, H2, Note, P } from "@/components/marketing/docs/Prose";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { pageMeta } from "@/components/marketing/site";
import type { FaqItem } from "@/lib/seo/faq";

export const metadata: Metadata = pageMeta("/seed-round-tracker");

const STAGES: [string, string][] = [
  ["New", "On the list, not looked at yet. Triage decides who moves on."],
  ["Researching", "Worth a look: check their recent deals, check size and thesis."],
  ["Contacted", "You sent the first email or asked for an intro."],
  ["Replied", "They answered. Book the meeting."],
  ["Meeting", "A meeting is scheduled or happened. Record the outcome and the next step."],
  ["Diligence", "They are digging in: data room, references, partner meeting."],
  ["Committed", "They said yes. Record the amount against the target."],
  ["Passed", "A no, or a not now. Keep the history: they may fit the next round."],
];

const FAQ: FaqItem[] = [
  {
    q: "Is there a free seed round tracker template?",
    a: "Yes. Download the Raisebook CSV template, fill it in a spreadsheet, and import it into Raisebook when you are ready. It has the columns this guide recommends.",
    link: { href: "/templates/raisebook-investors-template.csv", label: "Download the CSV template" },
  },
  {
    q: "Can I track more than one round?",
    a: "Yes. A workspace holds up to 50 rounds. Investors are contacts shared across rounds, so someone who passed at pre-seed keeps their history when you add them to the seed round.",
  },
  {
    q: "Can my co-founder and I split the list?",
    a: "Yes. Each investor in a round can have an owner, and the Table has an Owner column you can sort by. Filters live in the URL, so you can send a view to each other.",
  },
];

export default function SeedRoundTracker() {
  return (
    <SeoPage
      path="/seed-round-tracker"
      eyebrow="Guide · Seed round"
      title="How to track your seed round"
      answer={
        <p>
          To track a pre-seed or seed round, keep one list of investors with a stage, a fit score, an owner and a dated next
          follow-up for each, log every email, call and meeting against the investor, and add up commitments against the round
          target. Raisebook does this for free: create a round, import your list, and work it from the Triage, Board and Table
          views, or let your coding agent update it over MCP.
        </p>
      }
      toc={["1. Set up the round", "2. Build the list", "3. Move investors through stages", "4. Follow up on a cadence", "5. Run the meetings", "6. Watch the ledger"]}
      faq={FAQ}
      related={[
        { href: "/investor-crm", label: "What an investor CRM does" },
        { href: "/ai-investor-research", label: "Research investors with AI" },
        { href: "/compare/spreadsheet", label: "Spreadsheet vs investor CRM" },
        { href: "/docs/csv", label: "CSV import format" },
      ]}
    >
      <H2>1. Set up the round</H2>
      <P>
        Give the round a name (&ldquo;Seed&rdquo;), a target amount, an instrument (SAFE, priced round, convertible note), a cap or
        pre-money valuation and a target close date. Those numbers frame everything else: every commitment is counted against the
        target, and the close date tells you how much time is left.
      </P>

      <H2>2. Build the list</H2>
      <P>
        Start from what you have: a spreadsheet, a list from an accelerator, names from your network. Export it as CSV and import
        it; Raisebook reads common headers (Name, Fund, E-mail, Cheque size, Met at, Status), lets you map the rest, previews every
        row and dedupes on email, LinkedIn and name + firm. No list yet? Start from the{" "}
        <A href="/templates/raisebook-investors-template.csv">CSV template</A>.
      </P>
      <P>
        Then triage. Triage shows new investors one at a time; you decide with the number keys and can undo. Give each a fit score
        from 0 to 5 so the best matches rise to the top of every view.
      </P>

      <H2>3. Move investors through stages</H2>
      <DocTable
        caption="Default stages of a round"
        head={["Stage", "What it means"]}
        monoFirst={false}
        minWidth={420}
        rows={STAGES.map(([k, v]) => [<b key="k" className="font-semibold">{k}</b>, v])}
      />
      <P>
        Rename, recolor or reorder stages to match how you work. On the Board you drag cards between stages (or press{" "}
        <C>Alt+←</C> and <C>Alt+→</C>); the Table sorts and filters the whole round at once.
      </P>

      <H2>4. Follow up on a cadence</H2>
      <P>
        Most rounds are lost to silence, not to a no. Give every active investor a dated follow-up with a one-line note (&ldquo;send
        the deck&rdquo;, &ldquo;ask about partner meeting&rdquo;). Today and the ledger strip list who is due or overdue, so the
        morning starts with the right list. A simple rule that works: never leave an investor in Contacted, Replied, Meeting or
        Diligence without a next date.
      </P>

      <H2>5. Run the meetings</H2>
      <P>
        Schedule a meeting from the investor&apos;s file and they move to Meeting. Today&apos;s meetings show on Today and on the
        board cards. After the call, record the outcome and the next step, which becomes the next follow-up. A private calendar feed
        puts every meeting in Google Calendar, Apple Calendar or Outlook. <A href="/docs/meetings">Meetings docs</A>.
      </P>

      <H2>6. Watch the ledger</H2>
      <P>
        The ledger strip above the pipeline shows committed against target, the funnel by stage and the follow-ups due. When an
        investor commits, record the amount; the strip adds it up.
      </P>
      <Note label="With an agent">
        <p>
          Connect Claude Code, Codex or Cursor and say &ldquo;Met Dana from Harbor Light today. Log it, move her to Diligence and
          remind me Friday.&rdquo; Every write shows on the timeline under the agent&apos;s name.{" "}
          <A href="/fundraising-crm-mcp">Raisebook for AI agents</A>.
        </p>
      </Note>
    </SeoPage>
  );
}
