"use client";

import Link from "next/link";

import type { RoundStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";

import { Menu } from "./Menu";

export interface RoundPickerItem {
  slug: string;
  name: string;
  status: RoundStatus;
}

/**
 * The prototype `.round-pick` (SYSTEM 3.4): a sunk pill track with surface-pill active items,
 * then "+ Round" for editors. Overflows into a menu after 4 rounds. Closed rounds show at 60%
 * opacity and are listed last.
 */
export function RoundPicker({
  rounds,
  active,
  hrefFor,
  newRoundHref,
  className,
  max = 4,
}: {
  rounds: RoundPickerItem[];
  active?: string | null;
  hrefFor: (slug: string) => string;
  /** Shown to editors and owners. */
  newRoundHref?: string;
  className?: string;
  max?: number;
}) {
  const ordered = [...rounds.filter((r) => r.status === "open"), ...rounds.filter((r) => r.status !== "open")];
  let visible = ordered.slice(0, max);
  const activeRound = ordered.find((r) => r.slug === active);
  if (activeRound && !visible.includes(activeRound)) visible = [...visible.slice(0, max - 1), activeRound];
  const overflow = ordered.filter((r) => !visible.includes(r));

  const pill = "inline-flex h-26 shrink-0 items-center rounded-pill px-12 font-medium whitespace-nowrap transition-colors duration-[120ms]";
  // Many or long round names scroll sideways inside the track instead of widening the page.
  return (
    <nav
      aria-label="Rounds"
      className={cn(
        "inline-flex max-w-full items-center gap-2 overflow-x-auto rounded-pill bg-sunk p-3 [scrollbar-width:none]",
        className,
      )}
    >
      {visible.map((r) => {
        const on = r.slug === active;
        return (
          <Link
            key={r.slug}
            href={hrefFor(r.slug)}
            aria-current={on ? "page" : undefined}
            className={cn(
              pill,
              on ? "bg-surface text-fg shadow-pill" : "text-muted hover:text-fg",
              r.status === "closed" && "opacity-60",
            )}
            title={r.status === "closed" ? `${r.name} (closed)` : undefined}
          >
            {r.name}
          </Link>
        );
      })}
      {overflow.length ? (
        <Menu
          label="More rounds"
          trigger={<>{overflow.length} more ▾</>}
          triggerClassName={cn(pill, "border-0 bg-transparent text-muted hover:text-fg")}
          items={overflow.map((r) => ({
            label: r.name,
            href: hrefFor(r.slug),
            hint: r.status === "closed" ? "Closed" : undefined,
          }))}
        />
      ) : null}
      {newRoundHref ? (
        <Link href={newRoundHref} className={cn(pill, "text-muted hover:bg-surface/60 hover:text-fg")}>
          + Round
        </Link>
      ) : null}
    </nav>
  );
}
