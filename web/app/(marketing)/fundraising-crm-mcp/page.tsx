import type { Metadata } from "next";

import { A, C, H2, Note, P, Ul } from "@/components/marketing/docs/Prose";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { MCP_URL, pageMeta } from "@/components/marketing/site";
import { claudeCodeSnippet } from "@/components/marketing/snippets";
import { CodeBlock } from "@/components/ui";
import { MCP_CORE_TOOLS, MCP_TOOLS_WITH_RESEARCH } from "@/lib/seo/facts";
import { MORE_FAQ } from "@/lib/seo/faq";

export const metadata: Metadata = pageMeta("/fundraising-crm-mcp");

const PROMPTS = [
  "What follow-ups are due this week in Seed?",
  "Import investors.csv into Seed as Researching, dry run first.",
  "Met Dana from Harbor Light today. Log it, move her to Diligence and remind me Friday.",
  "Schedule a call with Marcus on Tuesday at 3pm and put it on my calendar.",
  "Write me a status update for Seed: committed vs target, who is in diligence, who went quiet.",
];

export default function FundraisingCrmMcp() {
  return (
    <SeoPage
      path="/fundraising-crm-mcp"
      eyebrow="MCP · Agents"
      title="A fundraising CRM your AI agent can work"
      answer={
        <p>
          Raisebook is a fundraising CRM with an MCP server. Connect Claude Code, Codex, Cursor or any MCP client with a workspace
          API key, and the agent can read the pipeline, add investors, move stages, log calls and emails, set follow-ups, schedule
          meetings and record commitments. It is free, it has no delete tools, and every write shows on the investor&apos;s timeline
          under the agent&apos;s name.
        </p>
      }
      toc={["Connect in one command", "What to ask", "What the agent can and cannot do", "Which clients work"]}
      faq={MORE_FAQ[1].items}
      related={[
        { href: "/docs/mcp", label: "MCP setup for every client" },
        { href: "/docs/mcp-tools", label: "MCP tools reference" },
        { href: "/docs/api", label: "REST API" },
      ]}
    >
      <H2>Connect in one command</H2>
      <P>Create a key in Settings → Connect an agent (it is shown once), then in a terminal:</P>
      <CodeBlock code={claudeCodeSnippet()} lang="shell" title="Claude Code" className="mb-18" />
      <P>
        The server is at <C>{MCP_URL}</C> (streamable HTTP). Codex and Cursor setups are in <A href="/docs/mcp">the MCP guide</A>.
      </P>

      <H2>What to ask</H2>
      <Ul>
        {PROMPTS.map((p) => (
          <li key={p}>&ldquo;{p}&rdquo;</li>
        ))}
      </Ul>

      <H2>What the agent can and cannot do</H2>
      <Ul>
        <li>
          {`${MCP_CORE_TOOLS} tools (${MCP_TOOLS_WITH_RESEARCH} with research on, as on raisebook.org): workspace and round summaries, investor search, add investors (up to 50 at once, deduped), move stages, log activity, set follow-ups, record commitments, import CSV (dry run first), and schedule, update and complete meetings.`}
        </li>
        <li>No deletes, no API keys, no invites. A read-only key sees only the read tools.</li>
        <li>Every write is recorded on the timeline with the agent&apos;s name and model, in its own color.</li>
        <li>Agents can save investor research they did with their own web tools, at no cost to the workspace.</li>
      </Ul>

      <H2>Which clients work</H2>
      <P>
        Any MCP client that speaks streamable HTTP and can send an API key header: Claude Code, Codex and Cursor have ready
        snippets, and clients that only start local servers, such as Claude Desktop, connect through <C>mcp-remote</C>.
      </P>
      <Note label="Not yet">
        <p>
          Web-only connectors (claude.ai and ChatGPT connectors) need OAuth, which Raisebook does not offer yet. The REST API under{" "}
          <C>/v1</C> works from anything that can make HTTP requests.
        </p>
      </Note>
    </SeoPage>
  );
}
