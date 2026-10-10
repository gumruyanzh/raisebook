import type { Metadata } from "next";

import { A, C, DocHeader, DocTable, H2, Note, P, Ul, slug } from "@/components/marketing/docs/Prose";
import { AsideFacts, AsideToc, PageShell } from "@/components/marketing/PageShell";
import { PRIVACY_PROMISE } from "@/components/marketing/promise";
import { RuledList } from "@/components/marketing/Section";
import { REPO_URL } from "@/components/marketing/site";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "Raisebook's privacy promise and the details behind it: what is stored, what is never collected, cookies, logs, email, backups and deletion.",
  alternates: { canonical: "/privacy" },
};

const SECTIONS = [
  "The promise",
  "What Raisebook stores",
  "What Raisebook never collects",
  "Cookies and browser storage",
  "Logs",
  "Email",
  "Hosting and backups",
  "Agents and AI",
  "Your rights",
  "Investor data you enter",
  "Changes",
  "Contact",
];

export default function Privacy() {
  return (
    <PageShell
      aside={
        <>
          <AsideFacts
            items={[
              ["Updated", "2026-10-10"],
              ["Covers", "raisebook.org"],
              ["Status", "Draft before launch"],
            ]}
          />
          <AsideToc items={SECTIONS.map((s) => ({ id: slug(s), label: s }))} />
        </>
      }
    >
      <DocHeader
        eyebrow="Privacy"
        title="Your raise is your business."
        lede={
          <p>
            Raisebook holds some of the most sensitive data a founder has: who you are talking to,
            what they said and how much they might invest. This page says plainly what happens to
            it. The code is public, so you can check every line of it.
          </p>
        }
      />

      <Note tone="warn" label="Before launch">
        <p>
          Text in [brackets] is a placeholder for details that are not decided yet: the operating
          entity, the hosting provider and the email provider. They are filled in before
          raisebook.org opens to the public.
        </p>
      </Note>

      <H2>The promise</H2>
      <RuledList items={PRIVACY_PROMISE} className="mb-18" />

      <H2>What Raisebook stores</H2>
      <DocTable
        caption="Data stored"
        head={["What", "Why"]}
        monoFirst={false}
        minWidth={460}
        rows={[
          ["Your email address and, if you add it, your name", "To sign you in and show who did what to your co-founders."],
          ["Sign-in sessions: when they started, the browser's user agent and IP address", "To keep you signed in, and so you can see and end sessions."],
          ["Your workspaces: rounds, stages, investors, notes, follow-ups, amounts and the timeline", "This is the product. It is shown only to the workspace's members and keys."],
          ["API keys, stored as a one-way hash, plus their name, scopes and last use", "To let your agents in without storing a usable secret."],
          ["Short-lived counters per key, per IP and per hashed email", "Rate limits. They are deleted after a day."],
        ]}
      />

      <H2>What Raisebook never collects</H2>
      <Ul>
        <li>No analytics, tracking pixels, session replay, heatmaps or advertising IDs.</li>
        <li>No third-party scripts or cookies. Fonts are served from raisebook.org itself.</li>
        <li>No data from other sites: Raisebook does not scrape LinkedIn or enrich contacts.</li>
        <li>
          No sharing between workspaces: no &ldquo;investors you might know&rdquo;, no benchmarks,
          no shared contact graph. No query in the code reads more than one workspace&apos;s rows,
          except counts of rows per table for capacity planning.
        </li>
      </Ul>

      <H2>Cookies and browser storage</H2>
      <DocTable
        caption="Cookies and storage"
        head={["Name", "Kind", "Purpose"]}
        minWidth={460}
        rows={[
          ["rb_session", "cookie, HttpOnly", "Keeps you signed in. 30 days, renewed while you use the app."],
          ["rb_csrf", "cookie", "Protects your account from forged requests."],
          ["rb-theme", "localStorage", "Light, dark or system."],
          ["rb-last-ws", "localStorage", "Opens the workspace you used last."],
        ]}
      />
      <P>That is the whole list. None of them is used for tracking, and there is no cookie banner because there is nothing to consent to.</P>

      <H2>Logs</H2>
      <P>
        Each request is logged with its request id, method, route template, status, duration,
        workspace id, actor type and API key prefix. Logs never contain request bodies, query
        strings, investor fields, email addresses or tokens. When a log line has to refer to an
        email, it uses a hash. Logs are kept for [N days].
      </P>

      <H2>Email</H2>
      <P>
        Raisebook sends two kinds of email: sign-in links and workspace invites. They go through
        [email provider]. Only the recipient&apos;s address and the message leave Raisebook.
        Raisebook never emails your investors.
      </P>

      <H2>Hosting and backups</H2>
      <P>
        Raisebook runs on [hosting provider] in [region]. The database is backed up nightly, and
        backups are kept for at most 14 days. When you delete something, it is removed from the
        live database at once and leaves the backups as they expire, within 14 days.
      </P>

      <H2>Agents and AI</H2>
      <P>
        Raisebook does not run AI models and does not send your data to any AI provider. When you
        connect an agent such as Claude Code, Codex or Cursor, it reads and writes through your
        API key, and what it reads goes to the AI provider you chose, under that provider&apos;s
        terms. Every change an agent makes is on the timeline under its name. Revoke the key and
        the access ends.
      </P>

      <H2>Your rights</H2>
      <Ul>
        <li>
          <b>See and take your data.</b> Export any round as CSV or JSON, all investors as CSV and
          the whole workspace as JSON, at any time. <A href="/docs/export">Export and delete</A>.
        </li>
        <li>
          <b>Correct it.</b> Everything you entered can be edited in the app.
        </li>
        <li>
          <b>Delete it.</b> Delete an investor, a round, a workspace or your account. Deletes are
          permanent and immediate.
        </li>
        <li>
          <b>Ask.</b> For anything you cannot do in the app, write to [privacy contact email]. We
          answer within [30] days.
        </li>
      </Ul>

      <H2>Investor data you enter</H2>
      <P>
        The people in your pipeline are real, and their details are personal data. You decide what
        to record about them and why, and Raisebook stores it for you and does nothing else with
        it. In data-protection terms, you are the controller of that data and [legal entity] acts
        as your processor. If an investor asks you to delete what you hold about them, delete the
        investor in Raisebook and it is gone.
      </P>

      <H2>Changes</H2>
      <P>
        If this page changes in a way that matters, the change is listed in the{" "}
        <A href="/changelog">changelog</A> and announced to account holders by email before it
        takes effect. The full history is in the{" "}
        <A href={REPO_URL}>repository</A>.
      </P>

      <H2>Contact</H2>
      <P>
        [Legal entity name], [postal address]. Privacy questions: [privacy contact email].
        Security reports: see <C>SECURITY.md</C> in the repository.
      </P>
      <P>
        This page covers the hosted service at raisebook.org. A self-hosted copy is run by whoever
        hosts it, under their own policy.
      </P>
    </PageShell>
  );
}
