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
import { REPO_URL } from "@/components/marketing/site";
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = {
  title: "Self-hosting",
  description:
    "Run Raisebook on your own server with Docker Compose: Postgres, the API and MCP server, the web app and Caddy for TLS.",
  alternates: { canonical: "/docs/self-hosting" },
};

const INSTALL = [
  `git clone ${REPO_URL}.git`,
  "cd raisebook",
  "cp deploy/.env.example deploy/.env",
  "# edit deploy/.env: hosts, POSTGRES_PASSWORD, RAISEBOOK_SESSION_SECRET, SMTP",
  "docker compose -f deploy/docker-compose.yml up -d --build",
].join("\n");

const SECRETS = [
  "# POSTGRES_PASSWORD",
  "openssl rand -base64 36 | tr -d '/+=' | cut -c1-40",
  "",
  "# RAISEBOOK_SESSION_SECRET (changing it later signs everyone out)",
  `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`,
].join("\n");

const UPDATE = [
  "cd raisebook && git pull",
  "docker compose -f deploy/docker-compose.yml up -d --build",
  "# the migrate service applies database migrations before the API starts",
].join("\n");

const LOCAL = [
  "# API and MCP on :8000 (needs Postgres 17 on localhost)",
  "cd backend && uv sync",
  "RAISEBOOK_DATABASE_URL=postgresql://localhost/raisebook_dev uv run alembic upgrade head",
  "RAISEBOOK_ENV=dev uv run uvicorn --factory raisebook.main:create_app --reload",
  "",
  "# web on :3000",
  "cd web && npm ci && npm run dev",
  "",
  "# a sample workspace with fictional investors",
  "cd backend && uv run rbctl seed-demo --email you@example.com",
].join("\n");

export default function SelfHosting() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · Operations"
        title="Self-hosting"
        lede={
          <p>
            Raisebook is one repository and one Docker Compose file. If you would rather keep your
            investor list on a machine you control, run your own copy. It is the same software as
            raisebook.org, with nothing held back.
          </p>
        }
      />

      <H2>What you need</H2>
      <Ul>
        <li>A Linux server with Docker and the Compose plugin. A small VM is enough to start.</li>
        <li>
          Two hostnames pointing at it, one for the web app and one for the API (for example{" "}
          <C>raise.example.com</C> and <C>api.raise.example.com</C>). Ports 80 and 443 open.
        </li>
        <li>
          An SMTP provider for sign-in links and invites. Any provider works; set up its SPF and
          DKIM records for your sending domain.
        </li>
      </Ul>

      <H2>Install</H2>
      <CodeBlock code={INSTALL} lang="shell" title="On the server" className="mb-14" />
      <P>Generate the two secrets:</P>
      <CodeBlock code={SECRETS} lang="shell" title="Secrets" className="mb-18" />
      <P>
        Caddy requests TLS certificates on its own once DNS points at the server. Open the web
        host, sign in with your email, and create your workspace.
      </P>

      <H2>What runs</H2>
      <DocTable
        caption="Compose services"
        head={["Service", "What it does"]}
        minWidth={420}
        rows={[
          ["postgres", "Postgres 17 with a named volume. Not exposed outside the compose network."],
          ["migrate", "Runs alembic upgrade head once, then exits. The API waits for it."],
          ["api", "FastAPI: the REST API under /v1 and the MCP server at /mcp."],
          ["web", "The Next.js app and this site."],
          ["caddy", "TLS and reverse proxy. The only service that publishes ports."],
        ]}
      />

      <H2>Configuration</H2>
      <P>
        Everything lives in <C>deploy/.env</C> (the template is <C>deploy/.env.example</C>). The
        main settings:
      </P>
      <DocTable
        caption="Main settings"
        head={["Variable", "What it sets"]}
        minWidth={520}
        rows={[
          ["WEB_HOST, API_HOST", "Your two hostnames. MCP is served at https://API_HOST/mcp."],
          ["POSTGRES_PASSWORD", "Database password. Required."],
          ["RAISEBOOK_SESSION_SECRET", "Signs session cookies and CSRF tokens. Required."],
          ["RAISEBOOK_SESSION_COOKIE_DOMAIN", "The parent domain both hosts share, so the session reaches the API."],
          ["RAISEBOOK_SMTP_HOST, _PORT, _USERNAME, _PASSWORD", "Your SMTP provider."],
          ["RAISEBOOK_EMAIL_FROM", 'Sender, e.g. "Raisebook <login@raise.example.com>".'],
          ["RAISEBOOK_RATE_LIMIT_BACKEND", "postgres (default), memory or off."],
          ["NEXT_PUBLIC_SPONSOR_URL", "The Support link. Point it anywhere, or at nothing."],
        ]}
      />
      <Note>
        <p>
          The web image bakes in its public settings at build time. After changing a host or a{" "}
          <C>NEXT_PUBLIC_</C> value, rebuild with <C>up -d --build</C>.
        </p>
      </Note>

      <H2>Updating</H2>
      <CodeBlock code={UPDATE} lang="shell" title="Update" className="mb-18" />

      <H2>Backups</H2>
      <P>
        <C>deploy/backup.sh</C> dumps the database nightly and deletes dumps older than{" "}
        <C>BACKUP_RETENTION_DAYS</C> (14 by default). The hosted service promises that deleted
        data leaves backups within 14 days; keep the same limit if you make that promise to your
        team. Run it from cron, as the comment at the top of the script shows.
      </P>

      <H2>Run it locally</H2>
      <P>For development, run the API and the web app directly against a local Postgres 17:</P>
      <CodeBlock code={LOCAL} lang="shell" title="Development" className="mb-14" />
      <P>
        In development, the &ldquo;check your inbox&rdquo; page shows the sign-in link, so you do
        not need SMTP. Contributing? Read <A href={`${REPO_URL}/blob/main/CONTRIBUTING.md`}>CONTRIBUTING.md</A>.
      </P>

      <H2>The license</H2>
      <P>
        Raisebook is AGPL-3.0. You can run, change and share it freely. If you change it and let
        other people use your version over a network, you must offer them its source code. Running an
        unmodified copy asks nothing more of you than keeping the license notices.
      </P>

      <DocPagerFor href="/docs/self-hosting" />
    </>
  );
}
