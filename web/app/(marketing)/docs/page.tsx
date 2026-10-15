import type { Metadata } from "next";

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
import { pageMeta } from "@/components/marketing/site";
import { Kbd, StagePill } from "@/components/ui";

export const metadata: Metadata = pageMeta("/docs");

const STAGES = [
  ["new", "New", "slate", "open"],
  ["research", "Researching", "violet", "open"],
  ["contacted", "Contacted", "cobalt", "active"],
  ["replied", "Replied", "teal", "active"],
  ["meeting", "Meeting", "amber", "active"],
  ["dd", "Diligence", "orange", "active"],
  ["committed", "Committed", "green", "won"],
  ["passed", "Passed", "gray", "lost"],
] as const;

export default function GettingStarted() {
  return (
    <>
      <DocHeader
        eyebrow="Docs"
        title="Getting started"
        lede={
          <p>
            Raisebook keeps your raise in one ledger: every investor, in every round, with stage,
            fit, follow-up, notes and commitment. This page takes you from sign-in to a working
            pipeline in about ten minutes.
          </p>
        }
      />

      <H2>1. Sign in</H2>
      <P>
        Enter your email at <A href="/signin">raisebook.org/signin</A>. Raisebook sends a sign-in
        link that works once and expires in 15 minutes. There is no password. The first sign-in
        creates your account.
      </P>

      <H2>2. Create a workspace</H2>
      <P>
        A workspace is one company. Everything you add lives inside it and is visible only to its
        members and to the API keys its owners create. Pick the timezone you work in: follow-up
        dates and &ldquo;today&rdquo; are counted in it. The default currency is used for check
        sizes.
      </P>
      <P>
        Just looking? Open a sample workspace instead. It is called &ldquo;Kestrel Robotics
        (sample)&rdquo; and comes with one Seed round and about 40 fictional investors in every
        stage. Sample workspaces are marked SANDBOX and can be deleted like any other.
      </P>

      <H2>3. Open your first round</H2>
      <P>
        A round has a name (&ldquo;Seed&rdquo;), a target amount, an instrument (SAFE, priced
        round, convertible note or other), an optional valuation cap or pre-money valuation, and a
        target close date. Amounts are whole units of the round&apos;s currency: 250000 means
        $250k.
      </P>
      <P>Every round starts with these stages. You can rename, recolor, reorder and add stages later.</P>
      <DocTable
        caption="Default stages"
        head={["Key", "Stage", "Kind"]}
        monoFirst
        minWidth={360}
        rows={STAGES.map(([key, label, color, kind]) => [
          key,
          <StagePill key={key} color={color} label={label} />,
          <span key={`${key}-k`} className="font-mono text-[12.5px] text-muted">
            {kind}
          </span>,
        ])}
      />
      <P>
        The kind decides the numbers. <b>open</b> means on the list but not contacted yet.{" "}
        <b>active</b> means in conversation. <b>won</b> (exactly one per round) is the committed
        stage, and only investors in it count toward the committed total. <b>lost</b> (exactly one
        per round) is passed or dead, and is left out of soft and weighted totals.
      </P>

      <H2>4. Bring your investors</H2>
      <Ul>
        <li>
          <b>Import a spreadsheet.</b> Export it as CSV and import it into the round. You map
          columns, see a preview with what will be created, updated or skipped, and only then
          write. See <A href="/docs/csv">CSV import format</A>.
        </li>
        <li>
          <b>Add them one at a time.</b> &ldquo;Add investor&rdquo; on the pipeline. If the person
          is already in your contacts (same email, LinkedIn profile, or name and firm), Raisebook
          tells you and offers to add the existing contact to the round.
        </li>
        <li>
          <b>Ask your agent.</b> &ldquo;Add the 12 angels from investors.csv to Seed as
          Researching.&rdquo; See <A href="/docs/mcp">Connect an agent</A>.
        </li>
      </Ul>
      <P>
        Investors are workspace contacts. The same person can sit in several rounds, with a
        separate stage, fit, follow-up and amounts in each, and one shared history.
      </P>

      <H2>5. Work the pipeline</H2>
      <P>
        The round page has a ledger strip on top: committed against target, the funnel by stage,
        and the follow-ups that are due. Below it, the pipeline as a board or a table. Click a
        name to open the investor&apos;s file in a side sheet.
      </P>
      <DocTable
        caption="Board keyboard shortcuts"
        head={["Keys", "What it does"]}
        monoFirst={false}
        minWidth={360}
        rows={[
          [<Kbd key="t">Tab</Kbd>, "Move between cards, column by column."],
          [<Kbd key="e">↵</Kbd>, "Open the focused investor's file."],
          [
            <span key="a" className="inline-flex gap-4">
              <Kbd>Alt</Kbd>
              <Kbd>→</Kbd>
            </span>,
            "Move the focused card to the next stage (Alt+← for the previous one). Passed is reached only through the menu.",
          ],
          [<Kbd key="m">M</Kbd>, "Open the card's Move to… menu with every stage."],
          [
            <span key="l" className="inline-flex gap-4">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>,
            "Log the note you are typing in the sheet.",
          ],
        ]}
      />
      <P>
        Follow-ups drive the day. A follow-up date before today is <b>overdue</b>, today is{" "}
        <b>today</b>, and the next seven days are <b>soon</b>. Overdue and today show in the
        ledger&apos;s &ldquo;Follow up now&rdquo; strip.
      </P>
      <P>
        Fit is 0 to 5 and sets the priority chip: 5 is Hot, 4 Warm, 3 Maybe, and 0 to 2 Low fit.
        Committed money comes from the commitment you record. Soft circled is the sum of soft
        amounts in open and active stages, and the weighted pipeline multiplies each active soft
        amount by its probability.
      </P>

      <H2>6. Invite your co-founder</H2>
      <DocTable
        caption="Roles"
        head={["Role", "Can"]}
        minWidth={360}
        rows={[
          ["owner", "Everything, including members, API keys and deleting the workspace."],
          ["editor", "Add and change rounds, stages, investors and activity. Import and export."],
          ["viewer", "Read everything and export. Good for an advisor."],
        ]}
      />
      <P>
        Owners invite people by email from Settings → Members. Invites expire after seven days. A
        workspace holds up to 20 members.
      </P>

      <H2>7. Connect an agent</H2>
      <P>
        Create an API key in Settings → API keys and add it to Claude Code, Codex, Cursor or
        another MCP client. Everything the agent does lands on the timeline under its name, in
        orchid. <A href="/docs/mcp">Connect an agent (MCP)</A>.
      </P>
      <Note label="Limits">
        <p>
          Per workspace: 50 rounds, 20,000 investors, 20 members (pending invites included), 20
          active API keys and 1,000,000 timeline entries. Raisebook returns{" "}
          <C>limit_reached</C> past a limit. The limits are the same for everyone, and there is no
          paid tier.
        </p>
      </Note>

      <DocPagerFor href="/docs" />
    </>
  );
}
