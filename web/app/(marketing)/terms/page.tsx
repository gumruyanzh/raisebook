import type { Metadata } from "next";

import { A, DocHeader, H2, P, Ul, slug } from "@/components/marketing/docs/Prose";
import { JsonLd } from "@/components/marketing/JsonLd";
import { AsideFacts, AsideToc, PageShell } from "@/components/marketing/PageShell";
import { pageMeta } from "@/components/marketing/site";
import { pageGraph } from "@/lib/seo/schema";

export const metadata: Metadata = pageMeta("/terms");

const SECTIONS = [
  "Who runs Raisebook",
  "The service",
  "Your account and keys",
  "Your data",
  "Fair use",
  "Availability",
  "No warranty",
  "Liability",
  "Ending",
  "Changes to these terms",
  "Law",
];

export default function Terms() {
  return (
    <>
      <JsonLd data={pageGraph("/terms")} />
      <PageShell
        aside={
          <>
            <AsideFacts
              items={[
                ["Updated", "2026-10-13"],
                ["Covers", "raisebook.org"],
                ["Status", "In effect"],
              ]}
            />
            <AsideToc items={SECTIONS.map((s) => ({ id: slug(s), label: s }))} />
          </>
        }
      >
        <DocHeader
          eyebrow="Terms"
          title="Terms of use"
          lede={
            <p>
              The short version: Raisebook is free, your data stays yours, use it for your own
              fundraising, and don&apos;t use it to hurt anyone. The longer version follows, in plain
              language.
            </p>
          }
        />


        <H2>Who runs Raisebook</H2>
        <P>
          raisebook.org is operated by Zhirayr Gumruyan, an individual based in San Francisco, California (&ldquo;we&rdquo;).
          Contact: 0@raisebook.org. By creating an account you agree to these terms.
        </P>

        <H2>The service</H2>
        <Ul>
          <li>
            Raisebook is free. There is no paid plan, and donations do not change what you get.
          </li>
          <li>
            The software is open source under the GNU Affero General Public License v3. That license
            covers the code. These terms cover your use of the hosted service at raisebook.org.
          </li>
          <li>
            We improve the service over time and may change or remove features. Changes that affect
            your data are announced in the <A href="/changelog">changelog</A>.
          </li>
        </Ul>

        <H2>Your account and keys</H2>
        <Ul>
          <li>Use an email address you control. Sign-in links go there.</li>
          <li>
            Keep API keys secret. Anything done with a key you created counts as done by your
            workspace, including actions taken by agents you connect. Revoke a key you no longer
            trust.
          </li>
          <li>
            Workspace owners decide who is a member and what role they have, and are responsible
            for those choices.
          </li>
        </Ul>

        <H2>Your data</H2>
        <Ul>
          <li>
            What you put into Raisebook stays yours. You give us only the permission we need to
            store it, show it to your workspace and run the service. The{" "}
            <A href="/privacy">privacy page</A> is part of these terms.
          </li>
          <li>
            You are responsible for having a right to the information you record about other people,
            such as investors, and for handling their requests about it.
          </li>
          <li>You can export everything and delete it at any time.</li>
        </Ul>

        <H2>Fair use</H2>
        <P>Do not use Raisebook to:</P>
        <Ul>
          <li>send spam or bulk outreach, or store data you obtained unlawfully;</li>
          <li>scrape other services, or resell access to raisebook.org;</li>
          <li>
            probe, break or overload the service, get around rate limits, or reach another
            workspace&apos;s data;
          </li>
          <li>store anything illegal, or harass anyone.</li>
        </Ul>
        <P>
          Running your own copy of the software is not reselling. That is what the license is for.
        </P>

        <H2>Availability</H2>
        <P>
          We work to keep Raisebook running and your data safe, but it is a free service run on a
          small budget, with no uptime guarantee. If we ever decide to shut raisebook.org down, we
          will give at least 60 days&apos; notice by email and keep export working until the end.
        </P>

        <H2>No warranty</H2>
        <P>
          Raisebook is provided &ldquo;as is&rdquo;, without warranties of any kind, to the extent the
          law allows. It is a tool for keeping track of a fundraise. It is not financial, legal or
          investment advice, and the numbers it shows are only as good as what is entered.
        </P>

        <H2>Liability</H2>
        <P>
          To the extent the law allows, we are not liable for indirect or consequential losses, lost
          deals or lost profits, and our total liability for anything related to the service is
          limited to US$100. Nothing here limits liability that cannot be limited by law.
        </P>

        <H2>Ending</H2>
        <P>
          You can stop using Raisebook and delete your account whenever you like. We may suspend or
          close an account that breaks these terms, and we will tell you why unless the law or the
          safety of others prevents it. Where we can, we give you a chance to export first.
        </P>

        <H2>Changes to these terms</H2>
        <P>
          We may update these terms. For changes that matter, we email account holders at least 30
          days before they take effect. If you keep using Raisebook after that, the new terms apply.
        </P>

        <H2>Law</H2>
        <P>These terms are governed by the laws of the State of California, and disputes go to the courts of San Francisco County, California.</P>
      </PageShell>
    </>
  );
}
