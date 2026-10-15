import type { Metadata } from "next";

import {
  A,
  C,
  DocHeader,
  DocPagerFor,
  DocTable,
  H2,
  Muted,
  Note,
  P,
  Ul,
} from "@/components/marketing/docs/Prose";
import { MCP_TOOL_COUNT, MCP_URL, SNIPPETS_CHECKED_ON, pageMeta } from "@/components/marketing/site";
import { clientTabs } from "@/components/marketing/snippets";
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = pageMeta("/docs/mcp");

const PROMPTS = [
  "What follow-ups are due this week in Seed?",
  "Import investors.csv into Seed as Researching, dry run first.",
  "Met Dana from Harbor Light today. Log it, move her to Diligence and remind me Friday.",
  "Write me a status update for Seed: committed vs target, who is in diligence, who went quiet.",
  "Add everyone tagged robotics who isn't in Seed yet, in New, fit 3.",
].join("\n");

function Step({ n, title }: { n: string; title: string }) {
  return (
    <h2
      id={`step-${n}`}
      className="t-display-xs mt-48 mb-12 flex scroll-mt-24 items-baseline gap-12"
    >
      <span className="font-mono text-[13px] font-medium text-muted">{n}</span>
      {title}
    </h2>
  );
}

export default function McpSetup() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · MCP"
        title="Connect an agent"
        lede={
          <p>
            Raisebook runs an MCP server, so Claude Code, Codex, Cursor or any MCP client can work
            your pipeline: log calls, move stages, set follow-ups, schedule meetings, import a list. The agent uses a
            key from your workspace, and every write lands on the timeline under its name.
          </p>
        }
      />

      <DocTable
        head={["Setting", "Value"]}
        monoFirst={false}
        minWidth={360}
        caption="Server details"
        rows={[
          [<span key="e" className="text-muted">Endpoint</span>, <C key="u">{MCP_URL}</C>],
          [<span key="t" className="text-muted">Transport</span>, "Streamable HTTP (stateless, JSON responses)"],
          [
            <span key="a" className="text-muted">Auth</span>,
            <span key="b">
              <C>Authorization: Bearer rb_live_…</C> or <C>X-API-Key: rb_live_…</C>
            </span>,
          ],
          [<span key="o" className="text-muted">Tools</span>, <A key="l" href="/docs/mcp-tools">{`${MCP_TOOL_COUNT} tools, no deletes`}</A>],
        ]}
      />

      <Step n="01" title="Create a key" />
      <P>
        In Raisebook, open Settings → API keys and choose &ldquo;Create key&rdquo;. Only a
        workspace owner can create keys, and only from the web app, so an agent can never mint or
        widen its own access.
      </P>
      <DocTable
        caption="Scopes"
        head={["Scope", "Lets the agent"]}
        minWidth={420}
        rows={[
          ["raisebook:read", "Read rounds, investors, timelines, summaries and follow-ups, and export. Always included."],
          ["raisebook:write", "Add and update investors, move stages, log activity, set follow-ups, record commitments, import. Every MCP write tool."],
          ["raisebook:admin", "Change workspace settings and delete rounds over REST. Requires write. MCP does not need it."],
        ]}
      />
      <P>
        Give the key an agent name, such as <C>claude-code</C>, so its actions are easy to tell
        apart on the timeline. The secret (<C>rb_live_</C> + 32 characters) is shown once. Store
        it in your agent&apos;s config or a password manager. Sample workspaces use{" "}
        <C>rb_test_</C> keys, which work only there.
      </P>

      <Step n="02" title="Add it to your agent" />
      <CodeBlock tabs={clientTabs()} className="mb-10" />
      <Muted>
        Replace <C>rb_live_XXXX</C> with your key, or set <C>RAISEBOOK_API_KEY</C> where the
        snippet reads it from the environment. Syntax checked against each client&apos;s own
        documentation on {SNIPPETS_CHECKED_ON}. Clients change; if a command is rejected, check
        the client&apos;s MCP docs for the current form.
      </Muted>

      <H2>Headers</H2>
      <DocTable
        caption="Request headers"
        head={["Header", "Required", "What it does"]}
        minWidth={520}
        rows={[
          ["Authorization", "yes", "Bearer rb_live_… (or send the key as X-API-Key)."],
          ["X-Agent-Name", "no", "Name shown on the timeline, e.g. claude-code. Letters, digits, space, dot, dash, underscore, up to 60. Default: the key's agent name, then the key name."],
          ["X-Agent-Model", "no", "Model shown next to the name, e.g. claude-opus-4-5. Up to 80 characters."],
        ]}
      />

      <Step n="03" title="Try it" />
      <P>Ask in plain words. The agent calls get_workspace first to learn your rounds and stage keys.</P>
      <CodeBlock code={PROMPTS} lang="text" title="Prompts to start with" className="mb-18" />

      <H2>What an agent can and cannot do</H2>
      <Ul>
        <li>
          It can read everything in the workspace the key belongs to, and nothing outside it.
        </li>
        <li>
          With write scope it can add and update investors, add them to rounds, move stages, log
          activity, set follow-ups, record commitments and import CSV.
        </li>
        <li>
          It cannot delete anything over MCP, create or revoke keys, invite or remove members, or
          change the workspace.
        </li>
        <li>
          Adding an investor twice returns the existing contact. Moving to the current stage, or
          setting the same follow-up again, changes nothing and logs nothing.
        </li>
        <li>
          CSV imports default to a dry run, so the agent shows you the counts before anything is
          written.
        </li>
      </Ul>

      <H2>Troubleshooting</H2>
      <DocTable
        caption="Common errors"
        head={["Error", "What to do"]}
        minWidth={480}
        rows={[
          ["invalid_api_key", "The key is wrong, revoked or expired. Create a new one and update the client config."],
          ["insufficient_scope", "The key lacks raisebook:write. Create a key with write scope."],
          ["round_required", "The workspace has several open rounds. Name the round in the prompt (\"in Seed\")."],
          ["ambiguous_reference", "More than one investor matches. Use the email, LinkedIn URL or \"Name @ Firm\"."],
          ["not_in_round", "Add the investor to the round first (add_to_round)."],
          ["rate_limited", "Wait for Retry-After seconds. Limits: 600 reads and 120 writes per minute per key."],
        ]}
      />
      <Note>
        <p>
          Web-only connectors (claude.ai and ChatGPT connectors) need OAuth, which Raisebook does
          not offer yet. Use a client that accepts a header, or mcp-remote.
        </p>
      </Note>

      <DocPagerFor href="/docs/mcp" />
    </>
  );
}
