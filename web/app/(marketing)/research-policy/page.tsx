import type { Metadata } from "next";

import { A, C, DocHeader, DocTable, H2, P, Ul, slug } from "@/components/marketing/docs/Prose";
import { AsideFacts, AsideToc, PageShell } from "@/components/marketing/PageShell";
import { RemovalForm } from "@/components/marketing/research/RemovalForm";
import { REPO_URL } from "@/components/marketing/site";

export const metadata: Metadata = {
  title: "Research Policy",
  description:
    "What Raisebook's investor research does, who starts it, what it collects and never collects, who can see it, how long it is kept, and how to ask for removal.",
  alternates: { canonical: "/research-policy" },
};

const SECTIONS = [
  "What research does",
  "Who starts it",
  "What it collects",
  "What it never collects",
  "Who can see it",
  "How long it is kept",
  "Ask us to remove you",
];

/** The public Research Policy (R13; RESEARCH-PLAN §8.8), with the removal request form. */
export default function ResearchPolicy() {
  return (
    <PageShell
      aside={
        <>
          <AsideFacts
            items={[
              ["Updated", "2026-10-13"],
              ["Covers", "Investor research"],
              ["Removal", "By email confirmation"],
            ]}
          />
          <AsideToc items={SECTIONS.map((s) => ({ id: slug(s), label: s }))} />
        </>
      }
    >
      <DocHeader
        eyebrow="Research Policy"
        title="Professional facts, cited, and nothing else."
        lede={
          <p>
            Founders use Raisebook to track the investors they talk to. Research helps them prepare: it reads public pages about an
            investor&apos;s work and writes a short dossier where every claim links to its source. This page is for founders and for the
            investors they research.
          </p>
        }
      />

      <H2>What research does</H2>
      <P>
        Research first works out who an investor is professionally: their firm, title, firm website and LinkedIn page. When it is not
        sure, it asks the founder to pick, and nothing deeper runs until they do. Then it searches the public web for that person&apos;s
        recent investments, fund news and public talks, and writes a dossier. A claim that no fetched page supports is dropped, or shown
        apart and marked as unverified. Pages about someone else with the same name are thrown away.
      </P>

      <H2>Who starts it</H2>
      <Ul>
        <li>Only a founder, by pressing a button, for an investor already in their own workspace. It never runs on import or on its own.</li>
        <li>
          It runs on the founder&apos;s own OpenRouter key and is paid for by them. Raisebook never runs or pays for AI models, and its
          servers never fetch the pages themselves: the search happens at the AI provider.
        </li>
        <li>
          A founder&apos;s agent (such as Claude Code) can also save a dossier it researched with its own tools. It goes through the same
          checks below and is marked with the agent&apos;s name.
        </li>
      </Ul>

      <H2>What it collects</H2>
      <P>Professional information only, about the person in their professional role:</P>
      <DocTable
        caption="Collected"
        head={["What", "Example"]}
        monoFirst={false}
        minWidth={420}
        rows={[
          ["Firm, role and title", "Partner at Harbor Light Ventures"],
          ["Investments, funds and partner moves", "Led a $3M seed round in August 2026"],
          ["Public posts, talks, podcasts and interviews in a professional capacity", "A podcast episode on backing robotics founders"],
          ["Stated focus: stage, sectors, check size", "Seed, robotics and climate, $250k to $1M"],
          ["A publicly listed work email on the firm's own domain", "dana@harborlight.example"],
          ["Publicly documented reputation in their work", "A public report of a fund near the end of its life"],
        ]}
      />
      <P>Every fact keeps the address of the page it came from, so the founder can read the source.</P>

      <H2>What it never collects</H2>
      <Ul>
        <li>Personal phone numbers or home addresses. A filter strips them from every dossier, whoever wrote it.</li>
        <li>Family, health, politics or religion. Those topics are dropped.</li>
        <li>Personal social accounts. Pages on personal social sites are never used as sources.</li>
        <li>Anything behind a login, and nothing scraped by Raisebook&apos;s own servers.</li>
      </Ul>
      <P>
        These rules are in the instructions given to the models and are enforced again in code on the result, for dossiers written by a
        model and by an agent alike. The code is <A href={REPO_URL}>open source</A>.
      </P>

      <H2>Who can see it</H2>
      <P>
        A dossier is private to the founder&apos;s workspace: its members, and the API keys its owners create. It is never shared with
        other workspaces, never pooled into an investor database, never sold and never used to train models. Raisebook keeps public
        facts apart from a founder&apos;s private notes about fit, so that this stays true.
      </P>

      <H2>How long it is kept</H2>
      <Ul>
        <li>Until the founder deletes the investor or the workspace; both delete the research at once.</li>
        <li>Each investor keeps at most the five latest dossiers; older versions are deleted.</li>
        <li>Until you ask us to remove it, below.</li>
      </Ul>

      <H2>Ask us to remove you</H2>
      <P>
        If you are an investor and want Raisebook to delete the research it stores about you, in every workspace, and to refuse future
        research about you, send the form. We email you a link to confirm it is you; nothing happens until you open it. The founders&apos;
        own contact entries (your name and email in their address book) are theirs, and stay. We answer every request the same way, so
        this form never reveals whether anything is stored about you.
      </P>
      <RemovalForm />
      <P className="mt-14">
        Questions: see the <A href="/privacy">privacy page</A>. Operators of a self-hosted copy handle requests with <C>rbctl research removals</C>.
      </P>
    </PageShell>
  );
}
