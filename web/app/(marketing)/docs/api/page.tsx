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
import { ERROR_CODES, RATE_LIMITS, REST_GROUPS, SHAPES } from "@/components/marketing/docs/rest";
import { PUBLIC_API_URL } from "@/components/marketing/site";
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = {
  title: "REST API",
  description:
    "The Raisebook REST API under /v1: authentication with workspace API keys, conventions, errors, rate limits and every endpoint.",
  alternates: { canonical: "/docs/api" },
};

const EXAMPLE = [
  `curl ${PUBLIC_API_URL}/v1/rounds/seed/summary \\`,
  `  -H "Authorization: Bearer $RAISEBOOK_API_KEY"`,
  "",
  `curl -X POST ${PUBLIC_API_URL}/v1/investors \\`,
  `  -H "Authorization: Bearer $RAISEBOOK_API_KEY" \\`,
  `  -H "Content-Type: application/json" \\`,
  `  -H "X-Agent-Name: weekly-sync" \\`,
  `  -d '{"name": "Dana Whitfield", "firm": "Harbor Light Ventures", "email": "dana@example.com", "type": "vc"}'`,
].join("\n");

const ERROR_EXAMPLE = `{"error": {"code": "not_in_round",
  "message": "Dana Whitfield is not in round Seed. Add them with POST /v1/rounds/seed/participants.",
  "details": {"investor_id": "…", "round": "seed"},
  "request_id": "req_01J…"}}`;

export default function RestApi() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · REST"
        title="REST API"
        lede={
          <p>
            Everything the app and the MCP server can do is a JSON endpoint under{" "}
            <C>{PUBLIC_API_URL}/v1</C>. Use it for scripts, syncs and your own tools. The MCP
            tools call the same code, so the rules match.
          </p>
        }
      />

      <H2>Authentication</H2>
      <P>
        Send a workspace API key as <C>Authorization: Bearer rb_live_…</C> or{" "}
        <C>X-API-Key: rb_live_…</C>. The key decides the workspace; there is nothing else to
        select. Owners create keys in Settings → API keys (<A href="/docs/mcp">scopes</A>).
        Requests made with a key are recorded as agent actions: add <C>X-Agent-Name</C> and{" "}
        <C>X-Agent-Model</C> to label them on the timeline.
      </P>
      <CodeBlock code={EXAMPLE} lang="shell" title="Two requests" className="mb-18" />
      <P>
        The web app uses a session cookie instead, with an <C>X-CSRF-Token</C> header on every
        write and <C>X-Workspace: &lt;slug&gt;</C> to pick the workspace. You do not need either
        with a key.
      </P>

      <H2>Conventions</H2>
      <Ul>
        <li>JSON in and out. CSV exports are <C>text/csv; charset=utf-8</C> attachments.</li>
        <li>
          Ids are UUIDs. <C>{"{round}"}</C> in a path accepts the round id or its slug.
        </li>
        <li>
          Timestamps are RFC 3339 in UTC. Dates are <C>YYYY-MM-DD</C> in the workspace timezone.
          Amounts are integers in whole units of the round&apos;s currency.
        </li>
        <li>
          PATCH: a missing key leaves the field alone; <C>null</C> clears it.
        </li>
        <li>
          Lists take <C>?limit=</C> (default 50, max 200) and <C>?cursor=</C>, and return{" "}
          <C>{"{data, next_cursor}"}</C>.
        </li>
        <li>
          Request bodies are capped at 1 MB, or 6 MB for imports. Every response carries{" "}
          <C>X-Request-ID</C>.
        </li>
        <li>
          The OpenAPI document is at <C>/v1/openapi.json</C>.
        </li>
      </Ul>

      <H2>Errors</H2>
      <P>
        Errors share one envelope. The message is a full sentence that says what to do next, so it
        can be shown to a person or handed to an agent as is.
      </P>
      <CodeBlock code={ERROR_EXAMPLE} lang="json" title="Error" className="mb-18" />
      <DocTable
        caption="Error codes"
        head={["HTTP", "Code", "When"]}
        minWidth={600}
        rows={ERROR_CODES.map(([http, code, when]) => [
          http,
          <span key="c" className="font-mono text-[12px] [overflow-wrap:anywhere]">
            {code}
          </span>,
          when,
        ])}
      />
      <P>
        An id or slug from another workspace returns <C>404 not_found</C>, never 403, so
        Raisebook does not reveal that it exists.
      </P>

      <H2>Rate limits</H2>
      <DocTable
        caption="Rate limits"
        head={["Bucket", "Limit"]}
        monoFirst={false}
        minWidth={420}
        rows={RATE_LIMITS.map(([b, l]) => [
          b,
          <span key="l" className="font-mono text-[12.5px] whitespace-nowrap">
            {l}
          </span>,
        ])}
      />
      <P>
        Limited responses carry <C>RateLimit-Limit</C>, <C>RateLimit-Remaining</C> and{" "}
        <C>RateLimit-Reset</C>. A 429 also carries <C>Retry-After</C>.
      </P>

      <H2>Endpoints</H2>
      <P>
        <b>Auth</b> is the scope a key needs (<C>read</C>, <C>write</C>, <C>admin</C>), or a
        session rule for actions that only a signed-in person can take.
      </P>
      {REST_GROUPS.map((g) => (
        <section key={g.id} className="mt-32">
          <h3 id={g.id} className="group mb-8 scroll-mt-24 text-[16px] font-semibold">
            {g.title}
            <a
              href={`#${g.id}`}
              aria-label={`Link to ${g.title}`}
              className="ml-8 font-mono text-[13px] font-normal text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              #
            </a>
          </h3>
          {g.intro ? <p className="t-body-s mb-10 text-muted">{g.intro}</p> : null}
          <ul className="m-0 list-none rounded-md border border-line bg-surface p-0">
            {g.endpoints.map((e) => (
              <li
                key={`${e.method} ${e.path}`}
                className="border-b border-line px-12 py-10 last:border-b-0"
              >
                <p className="flex flex-wrap items-baseline gap-x-10 gap-y-2">
                  <span className="w-52 shrink-0 font-mono text-[11.5px] font-medium text-muted">
                    {e.method}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere]">
                    {e.path}
                  </span>
                  <span className="t-micro rounded-pill border border-line px-6 text-muted">
                    {e.auth}
                  </span>
                </p>
                {e.request ? (
                  <p className="t-body-s mt-4 text-muted sm:pl-62">
                    <span className="sr-only">Request: </span>
                    <span className="font-mono text-[12px] [overflow-wrap:anywhere]">
                      {e.request}
                    </span>
                  </p>
                ) : null}
                <p className="t-body-s mt-4 sm:pl-62">
                  <span className="sr-only">Response: </span>
                  {e.response}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <H2>Shapes</H2>
      <P>The objects the endpoints return. A field with ? may be absent or null.</P>
      <CodeBlock code={SHAPES} lang="text" title="types" className="mb-18" />
      <Note>
        <p>
          Import and export formats are on their own pages: <A href="/docs/csv">CSV import format</A>{" "}
          and <A href="/docs/export">Export and delete</A>.
        </p>
      </Note>

      <DocPagerFor href="/docs/api" />
    </>
  );
}
