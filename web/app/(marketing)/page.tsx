// STUB by Foundation-web. Owner: Landing+Docs (docs/OWNERSHIP.md) — replace freely.
import { ButtonLink, TextLink } from "@/components/ui";

export default function Landing() {
  return (
    <section className="max-w-[640px]">
      <p className="t-label mb-14">Free forever · Open source · AGPL-3.0</p>
      <h1 className="t-display-xl">Run your raise from one ledger.</h1>
      <p className="t-body-l mt-18 text-muted">
        Raisebook tracks every investor through every round: stages, follow-ups, notes and
        commitments. It&apos;s free forever, and your coding agent can work the pipeline with you
        over MCP.
      </p>
      <div className="mt-24 flex flex-wrap items-center gap-14">
        <ButtonLink href="/signin" variant="primary" size="lg">Start your raise</ButtonLink>
        <TextLink href="/docs">Connect Claude Code →</TextLink>
      </div>
    </section>
  );
}
