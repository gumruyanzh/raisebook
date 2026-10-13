"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ButtonLink, Chip, PageHeader, SectionLabel, StageDot } from "@/components/ui";
import type { FollowUpItem, Workspace } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { daysBetween, formatDate, num, plural } from "@/lib/format";
import { readLastWorkspace } from "@/lib/session";

import { lastRouteFor } from "./AppKeyboard";

export interface HomeCompany {
  workspace: Workspace;
  today: string;
  due: FollowUpItem[];
  counts: { overdue: number; today: number; upcoming: number };
  rounds: { slug: string; name: string; participant_count: number }[];
}

const enc = encodeURIComponent;

/**
 * The all-companies home (UX-PASS-1 P2-2): each workspace with what is due there, then one
 * Today list across them (overdue first), each row opening the investor's sheet in its
 * round. "Continue in …" returns to the page last used in the last workspace.
 */
export function HomeToday({ companies }: { companies: HomeCompany[] }) {
  const [last, setLast] = useState<{ slug: string; href: string } | null>(null);
  useEffect(() => {
    const slug = readLastWorkspace();
    const c = companies.find((x) => x.workspace.slug === slug) ?? companies[0];
    if (c) setLast({ slug: c.workspace.slug, href: lastRouteFor(c.workspace.slug) ?? `/w/${enc(c.workspace.slug)}` });
  }, [companies]);
  const lastName = companies.find((c) => c.workspace.slug === last?.slug)?.workspace.name;

  const totalDue = companies.reduce((n, c) => n + c.counts.overdue + c.counts.today, 0);
  const items = useMemo(
    () =>
      companies
        .flatMap((c) => c.due.map((f) => ({ c, f, late: daysBetween(f.follow_up_on, c.today) })))
        .sort((a, b) => b.late - a.late || a.f.investor.name.localeCompare(b.f.investor.name)),
    [companies],
  );

  return (
    <div className="flex flex-col gap-14">
      <PageHeader
        title="Today"
        aside={`${plural(totalDue, "follow-up")} due across ${plural(companies.length, "company", "companies")}`}
        actions={
          last && lastName ? (
            <ButtonLink href={last.href} variant="primary">
              Continue in {lastName} →
            </ButtonLink>
          ) : null
        }
      />

      <section aria-label="Companies" className="grid grid-cols-1 gap-10 sm:grid-cols-2 2xl:grid-cols-3">
        {companies.map((c) => {
          const w = c.workspace;
          const due = c.counts.overdue + c.counts.today;
          const href = `/w/${enc(w.slug)}`;
          // The whole card opens the company: straight to its pipeline when there is one round.
          const open = c.rounds.length === 1 ? `${href}/r/${enc(c.rounds[0]!.slug)}` : href;
          return (
            <div
              key={w.slug}
              className="relative flex flex-col gap-8 rounded-md border border-line bg-surface p-14 transition-colors hover:border-accent focus-within:border-accent"
            >
              <div className="flex min-w-0 items-baseline gap-8">
                <Link
                  href={open}
                  className="min-w-0 truncate font-semibold after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:outline-none"
                >
                  {w.name}
                </Link>
                {w.is_sandbox ? <Chip tone="mode">Sandbox</Chip> : null}
                {w.role && w.role !== "owner" ? <span className="t-micro text-muted">{w.role}</span> : null}
                <span className={cn("t-micro ml-auto shrink-0", due ? "text-bad" : "text-muted")}>
                  {due ? `${num(due)} due` : "Nothing due"}
                </span>
              </div>
              {c.rounds.length ? (
                <ul className="m-0 flex list-none flex-wrap gap-x-12 gap-y-4 p-0">
                  {c.rounds.map((r) => (
                    <li key={r.slug} className="t-body-s">
                      <Link href={`${href}/r/${enc(r.slug)}/overview`} className="link relative z-10">
                        {r.name}
                      </Link>{" "}
                      <span className="text-muted">· {plural(r.participant_count, "investor")}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="t-body-s text-muted">No open round.</p>
              )}
              <p className="t-micro text-muted">
                {num(c.counts.overdue)} overdue · {num(c.counts.today)} today
              </p>
            </div>
          );
        })}
      </section>

      <section aria-label="Due today across companies" className="rounded-md border border-line bg-surface">
        <div className="px-14 pt-12 pb-8">
          <SectionLabel className="mb-0">Due now</SectionLabel>
        </div>
        {items.length === 0 ? (
          <p className="t-body-s px-14 pb-14 text-muted">Nothing is overdue or due today in any company.</p>
        ) : (
          <ul className="m-0 list-none border-t border-line p-0">
            {items.map(({ c, f, late }) => (
              <li key={`${c.workspace.slug}:${f.round.id}:${f.investor.id}`} className="border-b border-line last:border-b-0">
                <Link
                  href={`/w/${enc(c.workspace.slug)}/r/${enc(f.round.slug)}?investor=${enc(f.investor.id)}`}
                  className="flex min-h-48 flex-col justify-center gap-2 px-14 py-8 hover:bg-[color-mix(in_oklab,var(--sunk)_55%,var(--surface))]"
                >
                  <span className="flex min-w-0 items-center gap-8">
                    <StageDot color={f.stage.color} />
                    <span className="min-w-0 truncate font-semibold">{f.investor.name}</span>
                    <span className="t-body-s min-w-0 truncate text-muted">
                      {[f.investor.firm, f.stage.label].filter(Boolean).join(" · ")}
                    </span>
                    <span className="t-micro ml-auto shrink-0 text-bad">
                      {late > 0 ? `${plural(late, "day")} late` : "Today"}
                    </span>
                  </span>
                  <span className="t-body-s flex min-w-0 gap-6 pl-17 text-muted">
                    <span className="shrink-0 text-fg">{c.workspace.name}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{f.round.name}</span>
                    {f.follow_up_note || f.next_step ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="min-w-0 truncate">{f.follow_up_note || f.next_step}</span>
                      </>
                    ) : (
                      <span className="sr-only">due {formatDate(f.follow_up_on, c.today)}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
