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
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = {
  title: "Export and delete",
  description:
    "Take your data out of Raisebook as CSV or JSON at any time, and delete an investor, a round, a workspace or your account permanently.",
  alternates: { canonical: "/docs/export" },
};

const ROUND_COLUMNS =
  "investor_id, name, firm, title, type, email, linkedin_url, website_url, x_url, location, check_min, check_max, check_note, stage_focus, industries, tags, source, warm_intro_by, stage, stage_label, fit, priority, probability, amount_soft, amount_committed, committed_on, follow_up_on, follow_up_note, next_step, owner_email, last_activity_at, notes";

const WORKSPACE_JSON = `{
  "format": "raisebook.export",
  "version": 1,
  "exported_at": "2026-10-10T17:04:05Z",
  "workspace": { "id": "…", "slug": "kestrel-k7p2", "name": "Kestrel Robotics", … },
  "members": [{ "email": "sam@example.com", "name": "Sam Rivera", "role": "owner" }],
  "rounds": [ … ],
  "investors": [ … ],
  "participants": [{ "round_id": "…", "investor_id": "…", "stage_key": "dd", "fit": 5, … }],
  "activities": [ … ],
  "import_runs": [ … ]
}`;

export default function ExportDelete() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · Your data"
        title="Export and delete"
        lede={
          <p>
            Your data leaves with you whenever you want, in formats other tools can read. Deleting
            is permanent and takes effect at once.
          </p>
        }
      />

      <H2>Exports</H2>
      <DocTable
        caption="Export formats"
        head={["Export", "Where", "Format"]}
        monoFirst={false}
        minWidth={520}
        rows={[
          ["One round", "Round settings, or Settings → Data", "CSV or JSON"],
          ["All investors", "Investors, or Settings → Data", "CSV, with a rounds summary column"],
          ["The whole workspace", "Settings → Data", "JSON"],
        ]}
      />
      <P>
        Any member can export, including viewers. Over the API the same files come from{" "}
        <C>GET /v1/rounds/{"{round}"}/export?format=csv|json</C>,{" "}
        <C>GET /v1/investors/export?format=csv</C> and <C>GET /v1/export?format=json</C>, and an
        agent can call <A href="/docs/mcp-tools#export_round">export_round</A>.
      </P>

      <H2>Round CSV</H2>
      <P>
        One row per investor in the round, with these columns in this order. Lists are joined with{" "}
        <C>; </C>. The file is named <C>raisebook-&lt;workspace&gt;-&lt;round&gt;-&lt;YYYYMMDD&gt;.csv</C>.
        The header names are Raisebook&apos;s field names, so the file imports back as is.
      </P>
      <CodeBlock code={ROUND_COLUMNS.split(", ").join("\n")} lang="text" title="columns" className="mb-18" />
      <Note>
        <p>
          A cell that starts with <C>=</C>, <C>+</C>, <C>-</C>, <C>@</C>, a tab or a carriage
          return gets a leading <C>&apos;</C>, so a spreadsheet will not run it as a formula.
        </p>
      </Note>

      <H2>Workspace JSON</H2>
      <P>
        The full record: workspace settings, members, rounds with their stages, investors,
        participation in each round, the whole timeline and the import history. API keys,
        sessions and sign-in tokens are never exported.
      </P>
      <CodeBlock code={WORKSPACE_JSON} lang="json" title="raisebook.export v1" className="mb-18" />

      <H2>Deleting</H2>
      <DocTable
        caption="What each delete removes"
        head={["Delete", "Who", "Removes"]}
        monoFirst={false}
        minWidth={560}
        rows={[
          ["An investor", "Editors and owners", "The contact, their place in every round, and their timeline."],
          ["A round", "Owners (typed confirmation)", "The round, its stages, its participants and their round timeline."],
          ["A workspace", "Owners (type the workspace slug)", "Everything in it: rounds, investors, timeline, members, invites, API keys and import history."],
          ["Your account", "You (type your email)", "Your account, and every workspace where you are the only member."],
        ]}
      />
      <Ul>
        <li>
          Deletes are hard deletes in one transaction. There is no trash, no soft-delete flag and
          no tombstone.
        </li>
        <li>
          If you own a workspace that has other members, transfer ownership before deleting your
          account. Raisebook tells you which workspaces need it.
        </li>
        <li>
          On the hosted service, backups are kept for at most 14 days, so deleted data is gone
          from backups within 14 days.
        </li>
        <li>Over MCP, nothing can be deleted.</li>
      </Ul>

      <DocPagerFor href="/docs/export" />
    </>
  );
}
