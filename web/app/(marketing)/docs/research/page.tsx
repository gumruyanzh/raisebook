import type { Metadata } from "next";

import { A, C, DocHeader, DocPagerFor, DocTable, H2, Note, P, Ul } from "@/components/marketing/docs/Prose";
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = {
  title: "Investor research",
  description:
    "How Raisebook's investor research works: your own OpenRouter key, identity first, cited dossiers, presets and costs, the monthly limit, and save_dossier for agents.",
  alternates: { canonical: "/docs/research" },
};

const DOSSIER_EXAMPLE = `{
  "schema_version": 1,
  "identity": {
    "name": "Dana Whitfield",
    "firm": "Harbor Light Ventures",
    "title": "Partner",
    "linkedin_url": "https://www.linkedin.com/in/example-dana-whitfield",
    "firm_website": "https://harborlight.example"
  },
  "sources": [
    { "id": "s1", "url": "https://harborlight.example/news/brightquay-seed",
      "title": "Harbor Light leads Brightquay's seed", "published_at": "2026-08-14" }
  ],
  "facts": [
    { "key": "f1", "section": "activity", "kind": "deal", "date": "2026-08-14",
      "text": "Led the $3M seed round in Brightquay Robotics.", "source_ids": ["s1"] }
  ],
  "analysis": {
    "brief": {
      "verdict": "strong",
      "why": "Leads seed rounds in robotics at our check size.",
      "best_way_in": "Brightquay's founders, whose round she led.",
      "opener": "Saw your Brightquay seed; we automate the same warehouses.",
      "risk": "May see us as close to Brightquay.",
      "fact_keys": ["f1"]
    },
    "ways_in": [{ "text": "Brightquay's founders", "basis": "public", "fact_keys": ["f1"] }],
    "talking_points": [{ "text": "Lead with the warehouse pilots.", "fact_keys": ["f1"] }]
  },
  "suggestions": { "check_min": { "value": 250000, "fact_keys": ["f1"] } }
}`;

export default function ResearchDocs() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · Research"
        title="Investor research"
        lede={
          <p>
            Research turns an investor in your pipeline into a short, cited dossier: who they are, what they invested in lately, what
            they talk about, a way in, an opener and a risk. It runs only when you press a button, on your own OpenRouter key.
          </p>
        }
      />

      <H2>How it works</H2>
      <Ul ordered>
        <li>
          <b>Identity first.</b> A cheap search works out who the investor is professionally (LinkedIn, firm website, title). A clear
          match is saved; an unclear one shows &ldquo;Is this them?&rdquo; with two or three candidates, and nothing deeper runs until
          you pick. A LinkedIn URL you entered yourself is trusted without a search.
        </li>
        <li>
          <b>Search.</b> Three searches read recent deals, posts and talks, and the fund. Pages that do not match the confirmed
          identity, other people&apos;s profiles and personal social sites are thrown away.
        </li>
        <li>
          <b>Write.</b> The writer model reads the pages that were kept and writes the dossier. Every fact cites one of those pages;
          what it cannot cite goes to a collapsed &ldquo;Unverified&rdquo; section.
        </li>
        <li>
          <b>Check.</b> Raisebook checks every citation again and strips phones, addresses and private topics before anything is
          saved.
        </li>
      </Ul>
      <P>
        Empty investor fields (check size, stage focus, title…) are filled and marked &ldquo;from research&rdquo;. A field you already
        filled is never changed: research suggests the new value, and you accept or ignore it, one at a time or all at once (
        <C>A</C> in Triage).
      </P>

      <H2>Presets and cost</H2>
      <DocTable
        caption="Presets"
        head={["Preset", "Search", "Writer"]}
        minWidth={460}
        rows={[
          ["Best (default)", "Sonar Pro", "Claude Opus"],
          ["Balanced", "Sonar", "Claude Sonnet"],
          ["Budget", "Sonar", "a fast, cheap writer"],
        ]}
      />
      <P>
        Settings → AI research shows the estimate per dossier for each preset from OpenRouter&apos;s current prices, usually cents.
        Matching an identity costs about a cent. Advanced lets you pick any OpenRouter model for each step. The cost OpenRouter
        reports for each call is recorded on the run.
      </P>

      <H2>The monthly limit</H2>
      <P>
        Each workspace has a monthly limit, $25 by default; owners change it. Before every model call Raisebook sets aside that
        call&apos;s worst case under the limit, and settles the real cost afterwards, so parallel runs never go over it. A run that
        reaches the limit stops cleanly, keeps what it gathered, and can be resumed. Bulk research shows the count, who is left out
        and the total before you confirm, and offers the part that fits.
      </P>

      <H2>Keeping dossiers fresh</H2>
      <Ul>
        <li>A dossier older than 90 days shows &ldquo;May be stale&rdquo;.</li>
        <li>
          Moving someone to Meeting with a dossier older than 30 days offers &ldquo;Refresh before your meeting?&rdquo;. It never runs
          by itself.
        </li>
        <li>A refresh shows &ldquo;New since&rdquo; with what changed at the top, and the last five versions are kept.</li>
      </Ul>

      <H2>Agents: save_dossier</H2>
      <P>
        An agent such as Claude Code can research with its own web tools and save the result with <C>save_dossier</C> (or{" "}
        <C>POST /v1/investors/{"{id}"}/dossier</C>). It needs no OpenRouter key and costs the workspace nothing. The dossier goes
        through the same checks as a model&apos;s and is shown &ldquo;by claude-code&rdquo;. Facts without a source the agent fetched
        are dropped and listed in the answer.
      </P>
      <CodeBlock code={DOSSIER_EXAMPLE} lang="json" title="DossierDoc v1" className="mb-18" />
      <P>
        Sections: <C>profile</C>, <C>fit</C>, <C>activity</C>, <C>thesis</C>, <C>red_flags</C>. The other MCP tools are{" "}
        <C>get_dossier</C>, <C>research_investor</C>, <C>match_identity</C> and <C>list_research_runs</C>.{" "}
        <A href="/docs/mcp-tools">MCP tools reference</A>.
      </P>

      <H2>Privacy</H2>
      <P>
        Research sends the investor&apos;s name, firm, title and links, your company profile and the round&apos;s terms to OpenRouter.
        It never sends notes, emails, amounts or timelines. Dossiers hold professional information only and stay private to your
        workspace. Investors can ask for removal through the <A href="/research-policy">Research Policy</A>.
      </P>
      <Note label="Self-hosting">
        <p>
          Research needs <C>RAISEBOOK_SECRETS_KEK</C> set on the API and the worker (<C>rbctl secrets gen-kek</C>), and the{" "}
          <C>worker</C> service running. Without the key the app works and research says it is unavailable.
        </p>
      </Note>

      <DocPagerFor href="/docs/research" />
    </>
  );
}
