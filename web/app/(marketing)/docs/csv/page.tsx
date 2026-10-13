import type { Metadata } from "next";

import { pageMeta } from "@/components/marketing/site";

import {
  A,
  C,
  DocHeader,
  DocPagerFor,
  DocTable,
  H2,
  Note,
  P,
  Ul,
} from "@/components/marketing/docs/Prose";
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = {
  title: "CSV import format",
  description:
    "How Raisebook reads a spreadsheet: accepted column names, list, date and money formats, dedupe and what happens to each row.",
  ...pageMeta("/docs/csv"),
};

const CONTACT_FIELDS: [string, string, string][] = [
  ["name", "name, full name, investor, investor name, contact, person", "Required. Or first name + last name."],
  ["first_name, last_name", "first name, given name; last name, surname, family name", "Joined into name when there is no name column."],
  ["firm", "firm, fund, company, organization, org, vc firm", ""],
  ["title", "title, role, position, job title", ""],
  ["type", "type, investor type, category", "VC, Angel, Family Office, Corporate VC, Accelerator, Scout, Other (and aliases such as FO, CVC, venture)."],
  ["email", "email, email address, e-mail", "Used for dedupe."],
  ["linkedin_url", "linkedin, linkedin url, linkedin profile", "Profile URLs are used for dedupe."],
  ["website_url", "website, url, site, web", ""],
  ["x_url", "x, twitter, x handle, twitter handle", "URL or @handle."],
  ["location", "location, city, based in, hq", ""],
  ["check_note", "check, check size, ticket, ticket size, cheque size", "Min and max are read from it: $250k-$1M."],
  ["check_min, check_max", "min check, check min, max check, check max", ""],
  ["stage_focus", "stage focus, stages, invests at, stage", "List. See the note on stage below."],
  ["industries", "industry, industries, sector, sectors, focus areas", "List."],
  ["tags", "tags, labels, focus", "List."],
  ["notes", "notes, note, comments, research", ""],
  ["source", "source, met at, event, list", "Where you found them."],
  ["warm_intro_by", "warm intro, intro by, introducer, referred by", ""],
];

const ROUND_FIELDS: [string, string, string][] = [
  ["stage", "pipeline stage, status, round stage", "A stage key or label in the round."],
  ["fit", "fit, priority, score", "0 to 5, or hot / warm / maybe / low (5 / 4 / 3 / 1)."],
  ["follow_up_on", "follow up, follow-up date, next follow up, follow up on", "A date."],
  ["follow_up_note", "follow up note, follow-up note", "What the follow-up is for."],
  ["amount_soft", "soft, soft circle, ask, target amount", "Money."],
  ["amount_committed", "committed, commitment, amount committed, invested", "Money."],
  ["probability", "probability, likelihood, %", "0 to 100."],
  ["next_step", "next step, next action, todo", ""],
  ["owner_email", "owner, owner email, assigned to", "Must be a member's email; otherwise ignored with a warning."],
  ["last_contacted", "last contacted, last contact, last touch, contacted on", "A date. Becomes a dated note on the timeline."],
];

const EXAMPLE = `Full name,Fund,E-mail,Type,Cheque size,Industry,Met at,Status,Priority,Follow up
Dana Whitfield,Harbor Light Ventures,dana@example.com,VC,$250k-$1M,Robotics,Robotics Demo Night,Meeting,hot,2026-10-16
Marcus Odell,Juniper Angels,marcus@example.com,Angel,$25k-$50k,Hardware; Robotics,Intro from Sam,Contacted,4,10/14/2026
Theo Brandvold,Fernhill Family Office,,Family Office,$250k,Logistics,,Committed,4,`;

export default function CsvFormat() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · Import"
        title="CSV import format"
        lede={
          <p>
            Raisebook imports the spreadsheet you already keep. Export it as CSV from Google
            Sheets, Excel, Airtable or Notion, then import it from the round page or the
            Investors page. You see a preview of every row before anything is written.
          </p>
        }
      />

      <H2>The file</H2>
      <Ul>
        <li>UTF-8 with a header row. A byte-order mark is fine.</li>
        <li>
          Commas, semicolons or tabs as delimiters (detected automatically), with standard CSV
          quoting.
        </li>
        <li>Up to 5,000 rows and 5 MB per import. The MCP tool takes up to 2 MB of CSV text.</li>
        <li>
          Lists (tags, industries, stage focus) split on <C>;</C> or <C>|</C>, and on commas only
          when neither appears in the cell.
        </li>
        <li>
          Dates: <C>2026-10-14</C>, <C>10/14/2026</C>, <C>14.10.2026</C>, <C>Oct 14 2026</C>,{" "}
          <C>14 Oct 2026</C>. An ambiguous date like <C>03/04/2026</C> is read month first, with a
          warning.
        </li>
        <li>
          Money: <C>$250k</C>, <C>250K</C>, <C>1.5M</C>, <C>250,000</C>, <C>€500k</C>. The
          symbol is ignored and the round&apos;s currency is assumed, with a warning when they
          differ.
        </li>
        <li>An empty cell never clears data you already have.</li>
      </Ul>

      <CodeBlock code={EXAMPLE} lang="text" title="investors.csv" className="mb-18" />

      <H2>Columns</H2>
      <P>
        Headers are matched without regard to case, spaces or punctuation, so{" "}
        <C>E-mail</C>, <C>email</C> and <C>Email Address</C> all map to email. You can change any
        mapping, or ignore a column, before importing. The field names themselves are
        recognized too, so a CSV exported from Raisebook imports back without any mapping.
      </P>
      <DocTable
        caption="Contact fields"
        head={["Field", "Headers it recognizes", "Notes"]}
        minWidth={620}
        rows={CONTACT_FIELDS.map(([f, a, n]) => [f, <span key="a" className="text-muted">{a}</span>, n])}
      />
      <P>
        These fields apply when you import into a round. Without a round, Raisebook imports
        contacts only and tells you which round columns it ignored.
      </P>
      <DocTable
        caption="Round fields"
        head={["Field", "Headers it recognizes", "Notes"]}
        minWidth={620}
        rows={ROUND_FIELDS.map(([f, a, n]) => [f, <span key="a" className="text-muted">{a}</span>, n])}
      />
      <Note>
        <p>
          A column named just <C>stage</C> maps to the round stage when its values match your
          stage keys or labels (Meeting, Diligence…), and to stage focus otherwise (seed,
          series-a…).
        </p>
      </Note>

      <H2>Duplicates</H2>
      <P>
        Each row is matched against your contacts, and against earlier rows in the same file, in
        this order: same email, then same LinkedIn profile, then same name and firm. Choose what a
        match does:
      </P>
      <DocTable
        caption="When a row matches"
        head={["Option", "What happens"]}
        minWidth={420}
        rows={[
          ["skip", "Default. The contact stays as it is, but is still added to the round if it is not there yet."],
          ["fill_empty", "Fills fields that are empty and merges tags and industries."],
          ["update", "Overwrites fields with the non-empty cells, and may move the stage."],
        ]}
      />

      <H2>What happens to each row</H2>
      <DocTable
        caption="Row actions"
        head={["Action", "When"]}
        minWidth={420}
        rows={[
          ["create", "No match. A new contact is created."],
          ["update", "A match, and the option you chose would change something."],
          ["skip", "A match and nothing to change."],
          ["error", "No name, or a row that cannot be read at all. The row is left out and listed with the reason."],
        ]}
      />
      <P>
        A bad optional cell never costs you the row. An unreadable date, an invalid email or
        link, a fit or probability out of range, an amount that is not a number, or a minimum
        check above the maximum is left empty, and the row imports with a warning that names
        the cell (&ldquo;follow-up left empty: &lsquo;next week&rsquo; is not a date&rdquo;). The review counts
        them, and you can download the rows with problems as a CSV to fix them later.
      </P>
      <P>
        Your own pipeline words work too. When a stage or fit column has values Raisebook does
        not know (&ldquo;Intro requested&rdquo;, &ldquo;Meeting booked&rdquo;), the review lists each one with a suggested
        stage you can change. Without a type column, the type is guessed from the title or firm
        (&ldquo;Angel&rdquo;, &ldquo;… Ventures&rdquo;, &ldquo;… Capital&rdquo;), and the row says so.
      </P>
      <P>
        The import itself runs in one transaction. Every created or changed investor gets a
        timeline entry marked as an import, under your name or your agent&apos;s.
      </P>

      <H2>Importing from the prototype</H2>
      <P>
        If you kept your pipeline in the single-file Raisebook prototype, import its JSON
        directly: an array of investor objects, or <C>{"{investors: [...]}"}</C>. Raisebook maps{" "}
        <C>industry</C>, <C>tags</C>, <C>check</C> and <C>stageFocus</C> to their fields, folds{" "}
        <C>summary</C>, <C>bio</C>, <C>notes</C>, <C>ig</C> and events into labelled paragraphs of
        notes, and maps each round in <C>p</C> (stage, follow-up, amount, log) onto a Raisebook
        round you pick. LinkedIn search URLs are dropped with a warning.
      </P>

      <H2>With an agent</H2>
      <P>
        Ask: &ldquo;Import investors.csv into Seed as Researching, dry run first.&rdquo; The{" "}
        <A href="/docs/mcp-tools#import_investors_csv">import_investors_csv</A> tool returns the
        preview counts and waits for a second call with <C>dry_run=false</C>.
      </P>

      <DocPagerFor href="/docs/csv" />
    </>
  );
}
