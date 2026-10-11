"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Button,
  CodeBlock,
  SecretReveal,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type CodeTab,
} from "@/components/ui";
import { MCP_URL } from "@/lib/api/settings";
import { useWorkspace } from "@/lib/session";

import { KeyFields, submitKey, type KeyDraft } from "./CreateKeyDialog";

export const MCP_TOOLS: { name: string; does: string; write: boolean }[] = [
  { name: "get_workspace", does: "Workspace, today's date, rounds and their stage keys. Agents call it first.", write: false },
  { name: "list_rounds", does: "Rounds with target, committed amount and counts per stage kind.", write: false },
  { name: "get_round_summary", does: "Committed vs target, funnel, due follow-ups, quiet conversations, warnings.", write: false },
  { name: "search_investors", does: "Find investors by text, stage, fit, tags, industries or follow-up.", write: false },
  { name: "get_investor", does: "One investor's fields, every round they're in, and their timeline.", write: false },
  { name: "add_investor", does: "Add a contact, or return the existing one (dedupes by email, LinkedIn, name + firm).", write: true },
  { name: "update_investor", does: "Change contact fields, add or remove tags, append dated notes.", write: true },
  { name: "add_to_round", does: "Put an investor on a round's board, or update their round fields.", write: true },
  { name: "move_stage", does: "Move an investor to another stage, with a note on the timeline.", write: true },
  { name: "log_activity", does: "Record a note, email, call or meeting.", write: true },
  { name: "set_follow_up", does: "Set or clear the next follow-up date and what it's for.", write: true },
  { name: "list_due_follow_ups", does: "Overdue, today and upcoming follow-ups across open rounds.", write: false },
  { name: "record_commitment", does: "Record a committed amount and move them to Committed.", write: true },
  { name: "import_investors_csv", does: "Import CSV text, with a dry-run preview first.", write: true },
  { name: "export_round", does: "A round's pipeline as CSV or JSON.", write: false },
];

const PLACEHOLDER = "rb_live_XXXX";

export function snippetTabs(secret: string | null, sandbox: boolean, agentName?: string): CodeTab[] {
  const key = secret ?? (sandbox ? "rb_test_XXXX" : PLACEHOLDER);
  const name = (fallback: string) => agentName?.trim() || fallback;
  return [
    {
      label: "Claude Code",
      lang: "shell",
      code: `claude mcp add --transport http raisebook ${MCP_URL} \\\n  --header "Authorization: Bearer ${key}" \\\n  --header "X-Agent-Name: ${name("claude-code")}"`,
      caption: "Run once in a terminal. Then ask Claude Code about your raise; it lists the raisebook tools with /mcp.",
    },
    {
      label: "Codex",
      lang: "toml",
      code: `# ~/.codex/config.toml\n[mcp_servers.raisebook]\nurl = "${MCP_URL}"\nbearer_token_env_var = "RAISEBOOK_API_KEY"\nhttp_headers = { "X-Agent-Name" = "${name("codex")}" }\n\n# then, in your shell profile:\n# export RAISEBOOK_API_KEY=${key}`,
      caption: "Codex reads the key from RAISEBOOK_API_KEY, so the secret stays out of the config file.",
    },
    {
      label: "Cursor",
      lang: "json",
      code: `{\n  "mcpServers": {\n    "raisebook": {\n      "url": "${MCP_URL}",\n      "headers": {\n        "Authorization": "Bearer \${env:RAISEBOOK_API_KEY}",\n        "X-Agent-Name": "${name("cursor")}"\n      }\n    }\n  }\n}`,
      caption: `.cursor/mcp.json in a project, or ~/.cursor/mcp.json for all of them. Set RAISEBOOK_API_KEY=${secret ? "<your key>" : key} in your environment.`,
    },
    {
      label: "Other",
      lang: "shell",
      code: `# Any MCP client that speaks streamable HTTP:\n#   URL:     ${MCP_URL}\n#   Header:  Authorization: Bearer ${key}\n#   Header:  X-Agent-Name: my-agent\n\n# Clients that only run local (stdio) servers:\nnpx -y mcp-remote ${MCP_URL} \\\n  --header "Authorization: Bearer ${key}"`,
      caption: "X-Agent-Name is how your agent's actions are labeled on the timeline. X-Agent-Model is optional.",
    },
  ];
}

const PROMPTS = (round: string) =>
  [
    `What follow-ups are due this week in ${round}?`,
    `Import investors.csv into ${round} as Researching, dry run first.`,
    `Met Dana from Harbor Light today. Move her to Diligence, remind me Friday.`,
    `Who has gone quiet in ${round}? Draft a short nudge for each.`,
  ].join("\n");

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-12 border-b border-line py-20 first:pt-4 last:border-b-0">
      <span className="t-micro pt-3 text-muted" aria-hidden>
        {n}
      </span>
      <div className="min-w-0">
        <h2 className="t-display-xs">{title}</h2>
        <div className="mt-10">{children}</div>
      </div>
    </li>
  );
}

/** Settings → Connect an agent (SYSTEM §4.9): create a key, add it to the agent, try it. */
export function ConnectAgent() {
  const { workspace, client, isOwner, rounds } = useWorkspace();
  const [d, setD] = useState<KeyDraft>({ name: "Claude Code", agentName: "claude-code", write: true, admin: false, expires: "never" });
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const round = rounds.find((r) => r.status === "open")?.name ?? "Seed";

  return (
    <div className="flex max-w-[880px] flex-col gap-24">
      <p className="t-body-l measure text-muted">
        Raisebook has an MCP server, so Claude Code, Codex, Cursor or any MCP client can read and work your pipeline
        with you. Every action an agent takes shows on the timeline in{" "}
        <span className="text-agent">its own color</span>, under its name.
      </p>
      <ol className="m-0 list-none rounded-md border border-line bg-surface px-16 py-4">
        <Step n="01" title="Create a key">
          {!isOwner ? (
            <p className="t-body-s text-muted">Only an owner of {workspace.name} can create keys. Ask one for a key, then continue with step 02.</p>
          ) : secret ? (
            <div className="flex flex-col gap-8">
              <SecretReveal secret={secret} label={d.name} />
              <p className="t-body-s text-muted">
                The snippets below now include this key. Leaving or reloading the page hides it for good.
              </p>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                const res = await submitKey(client, d);
                setBusy(false);
                if (res.error) setError(res.error);
                else if (res.secret) setSecret(res.secret);
              }}
            >
              <KeyFields d={d} set={setD} compact />
              <div className="mt-12 flex flex-wrap items-center gap-10">
                <Button type="submit" variant="primary" busy={busy ? "Creating…" : false}>
                  Create key
                </Button>
                <Link href={`${base}/settings/api-keys`} className="link t-body-s">
                  Manage keys
                </Link>
              </div>
              {error ? <p className="t-body-s mt-8 text-bad">{error}</p> : null}
            </form>
          )}
        </Step>
        <Step n="02" title="Add it to your agent">
          <CodeBlock tabs={snippetTabs(secret, workspace.is_sandbox, d.agentName)} />
          {!secret ? (
            <p className="t-body-s mt-8 text-muted">
              Replace <span className="font-mono">{workspace.is_sandbox ? "rb_test_XXXX" : PLACEHOLDER}</span> with your key. Keys
              are shown once, when you create them.
            </p>
          ) : null}
        </Step>
        <Step n="03" title="Try it">
          <p className="t-body-s mb-8 text-muted">Ask your agent in plain words. A few to start:</p>
          <CodeBlock code={PROMPTS(round)} title="Prompts" />
        </Step>
      </ol>

      <section aria-label="Tools">
        <h2 className="t-display-xs mb-4">The 15 tools</h2>
        <p className="t-body-s mb-10 text-muted">
          Agents get these through MCP. There are no delete tools; deleting stays with you.
        </p>
        <TableScroll>
          <Table minWidth={620}>
            <THead>
              <Tr>
                <Th>Tool</Th>
                <Th>What it does</Th>
                <Th>Access</Th>
              </Tr>
            </THead>
            <TBody>
              {MCP_TOOLS.map((t) => (
                <Tr key={t.name}>
                  <Td className="t-data whitespace-nowrap">{t.name}</Td>
                  <Td variant="muted">{t.does}</Td>
                  <Td className="t-micro whitespace-nowrap text-muted">{t.write ? "write" : "read"}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      </section>
    </div>
  );
}
