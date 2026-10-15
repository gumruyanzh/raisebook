import type { Metadata } from "next";

import { JsonLd } from "@/components/marketing/JsonLd";
import { A, DocHeader, H2, Note, P, Ul, slug } from "@/components/marketing/docs/Prose";
import { AsideFacts, AsideToc, PageShell } from "@/components/marketing/PageShell";
import { REPO_URL, SPONSOR_URL, pageMeta } from "@/components/marketing/site";
import { ButtonLink, TextLink } from "@/components/ui";
import { pageGraph } from "@/lib/seo/schema";

export const metadata: Metadata = pageMeta("/support");

const SECTIONS = ["What a donation pays for", "What it never buys", "Other ways to help", "Need help?"];

export default function Support() {
  return (
    <>
      <JsonLd data={pageGraph("/support")} />
      <PageShell
        aside={
          <>
            <AsideFacts
              items={[
                ["Price", "$0, forever"],
                ["Donations", "Optional"],
                ["Sponsorship", SPONSOR_URL ? "Open" : "Not open yet"],
              ]}
            />
            <AsideToc items={SECTIONS.map((s) => ({ id: slug(s), label: s }))} />
          </>
        }
      >
        <DocHeader
          eyebrow="Support"
          title="Keep Raisebook free."
          lede={
            <p>
              Raisebook costs nothing to use and never will. If it saved you a subscription or kept a
              follow-up from slipping, you can help pay for the server it runs on.
            </p>
          }
        />

        {SPONSOR_URL ? null : (
          <Note label="Not open yet">
            <p>
              Donations are not open yet; the maintainer pays the running costs for now. This page
              will link the one official sponsor page when it opens. Please do not send money
              anywhere else in Raisebook&apos;s name.
            </p>
          </Note>
        )}

        <div className="mb-32 flex flex-wrap items-center gap-x-18 gap-y-12">
          {SPONSOR_URL ? (
            <ButtonLink href={SPONSOR_URL} external size="lg">
              Support Raisebook
            </ButtonLink>
          ) : null}
          <TextLink href={REPO_URL} external>
            Star the repository
          </TextLink>
        </div>

        <H2>What a donation pays for</H2>
        <Ul>
          <li>The server and the database that hold the hosted service.</li>
          <li>Backups, kept for 14 days and no longer.</li>
          <li>The email service that delivers sign-in links and invites.</li>
          <li>The domain.</li>
        </Ul>
        <P>
          Once donations open, the monthly costs and what donations covered will be published here,
          so you can see where the money goes.
        </P>

        <H2>What it never buys</H2>
        <Ul>
          <li>Features. Everyone gets all of them, with the same limits.</li>
          <li>Priority, a badge or a different deal on your data.</li>
          <li>A say over another founder&apos;s workspace. Nobody gets that.</li>
        </Ul>

        <H2>Other ways to help</H2>
        <Ul>
          <li>
            <b>Tell a founder who is raising.</b> Most of them are paying for a CRM or living in a
            spreadsheet.
          </li>
          <li>
            <b>Report what is broken or confusing.</b> Open an issue in the{" "}
            <A href={REPO_URL}>repository</A>.
          </li>
          <li>
            <b>Contribute.</b> Code, docs and fixes are welcome. Start with CONTRIBUTING.md.
          </li>
          <li>
            <b>Run your own copy</b> and tell us what self-hosting was like.{" "}
            <A href="/docs/self-hosting">Self-hosting</A>.
          </li>
        </Ul>

        <H2>Need help?</H2>
        <P>
          Start with the <A href="/docs">docs</A>. For questions and bugs, open an issue in the
          repository. Privacy questions go to the contact on the <A href="/privacy">privacy page</A>.
        </P>
      </PageShell>
    </>
  );
}
