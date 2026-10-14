"use client";

import { Kbd, useToast } from "@/components/ui";
import type { Round } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact } from "@/lib/format";
import { introFitLine } from "@/lib/pipeline";

/** Who the reach-out row is for: the trimmed row, filled in from the full investor when it has come. */
export interface ReachPerson {
  name: string;
  firm?: string | null;
  fit: number;
  email?: string | null;
  linkedin_url?: string | null;
  website_url?: string | null;
  x_url?: string | null;
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/**
 * The intro email (critique 3): a subject that says why, and a body with the ask. The "why
 * you" line follows the fit the founder gave (critique 4), so a fit-0 investor is not told
 * they "came up as a strong fit".
 */
export function draftHref(person: ReachPerson, ctx: { workspaceName: string; round: Round; sender: string | null }): string | null {
  const email = person.email ?? null;
  if (!email) return null;
  const raise = `${moneyCompact(ctx.round.target_amount, ctx.round.currency)} ${ctx.round.name}`;
  const why = introFitLine(person.firm, person.fit);
  const body = [
    `Hi ${firstName(person.name)},`,
    "",
    `I'm raising a ${raise} for ${ctx.workspaceName}.${why ? ` ${why}` : ""}`,
    "",
    `[One line on what ${ctx.workspaceName} does and why now.]`,
    "",
    "Would you be open to a 20-minute call in the next two weeks? Happy to send the deck first.",
    "",
    "Thanks,",
    ctx.sender ? firstName(ctx.sender) : "",
  ].join("\n");
  const subject = `${ctx.workspaceName}: raising a ${raise}`;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.trimEnd() + "\n")}`;
}

/**
 * The reach-out row, the same in Triage, the investor sheet and on phones (critiques 3 and 4):
 * LinkedIn (or a LinkedIn search) first, then the intro email, the address to copy, website
 * and X. One neutral button style; cobalt stays for the decision itself.
 */
export function ReachOut({
  person,
  draft,
  onDrafted,
  kbd = false,
  big = false,
  className,
  fromResearch,
}: {
  person: ReachPerson;
  draft: string | null;
  onDrafted?: () => void;
  /** Show the `L` key on LinkedIn (Triage). */
  kbd?: boolean;
  /** 40px targets (phones). */
  big?: boolean;
  className?: string;
  /** Fields research filled in (R7): their buttons carry a "from research" mark. */
  fromResearch?: readonly string[];
}) {
  const toast = useToast();
  const linkedin = person.linkedin_url ?? null;
  const search = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([person.name, person.firm].filter(Boolean).join(" "))}`;
  const email = person.email ?? null;
  const web = [
    ...(person.website_url ? [{ href: person.website_url, label: "Website", field: "website_url" }] : []),
    ...(person.x_url ? [{ href: person.x_url, label: "X", field: "x_url" }] : []),
  ].filter((l) => /^https?:\/\//i.test(l.href));
  const researched = (field: string) =>
    fromResearch?.includes(field) ? (
      <span className="t-micro shrink-0 text-muted" title="Filled in by research. Check it before you use it; edit it and the mark goes away.">
        from research
      </span>
    ) : null;
  const btn = cn(
    "inline-flex max-w-full min-w-0 items-center gap-6 rounded-sm border border-line bg-surface text-fg hover:border-accent",
    big ? "h-40 px-12" : "h-32 px-12 text-base",
  );
  const arrow = (
    <span aria-hidden className="text-muted">
      ↗
    </span>
  );
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-6", className)}>
      <a href={linkedin ?? search} target="_blank" rel="noopener noreferrer" className={btn}>
        {linkedin ? "LinkedIn" : "Search LinkedIn"} {arrow}
        {linkedin ? researched("linkedin_url") : null}
        {kbd ? <Kbd>L</Kbd> : null}
      </a>
      {draft ? (
        <a href={draft} className={btn} onClick={onDrafted}>
          Draft intro email {arrow}
        </a>
      ) : null}
      {email ? (
        <button
          type="button"
          className={btn}
          title={`Copy ${email}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(email);
              toast.show("Email copied.");
            } catch {
              toast.show(email);
            }
          }}
        >
          <span className="min-w-0 truncate text-muted">{email}</span>
          {researched("email")}
          <span className="shrink-0">Copy</span>
        </button>
      ) : null}
      {web.map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className={btn}>
          {l.label} {arrow}
          {researched(l.field)}
        </a>
      ))}
    </div>
  );
}
