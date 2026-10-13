"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";

import type { RoundStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";

import { Menu, type MenuEntry } from "./Menu";

export interface RoundPickerItem {
  slug: string;
  name: string;
  status: RoundStatus;
}

const PILL =
  "inline-flex h-26 shrink-0 items-center rounded-pill px-12 font-medium whitespace-nowrap transition-colors duration-[120ms]";

/** "closed" in mono after a closed round's name: full-strength muted, never faded (≥ 4.5:1). */
function ClosedSuffix() {
  return <span className="t-micro ml-6 font-normal text-muted">closed</span>;
}

function roundMenuItems(
  ordered: RoundPickerItem[],
  active: string | null | undefined,
  hrefFor: (slug: string) => string,
  newRound?: { href?: string; onSelect?: () => void },
): MenuEntry[] {
  const open = ordered.filter((r) => r.status === "open");
  const closed = ordered.filter((r) => r.status !== "open");
  const item = (r: RoundPickerItem): MenuEntry => ({
    label: r.name,
    textValue: r.name,
    href: hrefFor(r.slug),
    selected: r.slug === active,
  });
  return [
    ...open.map(item),
    ...(closed.length ? [{ type: "label", label: "Closed" } as MenuEntry, ...closed.map(item)] : []),
    ...(newRound?.href || newRound?.onSelect
      ? [{ type: "separator" } as MenuEntry, { label: "+ New round", textValue: "New round", ...newRound } as MenuEntry]
      : []),
  ];
}

/**
 * The prototype `.round-pick` (SYSTEM 3.4): a sunk pill track with surface-pill active items,
 * then "+ Round" for editors. Open rounds first; closed rounds last with a mono "closed"
 * suffix. Overflows into a menu after `max` rounds.
 *
 * `collapse="auto"` (the desktop top bar) measures the space it has with a ResizeObserver
 * and, when the track would not fit, collapses to one "Seed ▾" pill whose menu lists every
 * round (closed ones under CLOSED) and "+ New round". `collapse="never"` keeps the track and
 * lets it scroll sideways (the phone row).
 */
export function RoundPicker({
  rounds,
  active,
  hrefFor,
  newRoundHref,
  onNewRound,
  className,
  max = 4,
  collapse = "never",
}: {
  rounds: RoundPickerItem[];
  active?: string | null;
  hrefFor: (slug: string) => string;
  /** Shown to editors and owners. */
  newRoundHref?: string;
  /** Opens the new-round dialog in place (wins over `newRoundHref`). */
  onNewRound?: () => void;
  className?: string;
  max?: number;
  collapse?: "auto" | "never";
}) {
  const ordered = [...rounds.filter((r) => r.status === "open"), ...rounds.filter((r) => r.status !== "open")];
  let visible = ordered.slice(0, max);
  const activeRound = ordered.find((r) => r.slug === active);
  if (activeRound && !visible.includes(activeRound)) visible = [...visible.slice(0, max - 1), activeRound];
  const overflow = ordered.filter((r) => !visible.includes(r));
  const newRound = onNewRound ? { onSelect: onNewRound } : newRoundHref ? { href: newRoundHref } : undefined;

  const slot = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLElement>(null);
  const natural = useRef(0);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    if (collapse !== "auto") return;
    const el = slot.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const avail = el.clientWidth;
      const t = track.current;
      if (t) {
        natural.current = t.scrollWidth;
        if (t.scrollWidth > avail + 1) setCollapsed(true);
      } else if (natural.current && avail >= natural.current) {
        setCollapsed(false);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapse, collapsed, rounds.length, active]);

  // Round names can change; re-measure the full track next time.
  const sig = ordered.map((r) => `${r.slug}:${r.status}:${r.name}`).join("|");
  const lastSig = useRef(sig);
  useLayoutEffect(() => {
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    natural.current = 0;
    setCollapsed(false);
  }, [sig]);

  const trackEl = (
    <nav
      ref={track}
      aria-label="Rounds"
      className={cn(
        "inline-flex max-w-full items-center gap-2 overflow-x-auto rounded-pill bg-sunk p-3 [scrollbar-width:none]",
        collapse === "never" && className,
      )}
    >
      {visible.map((r) => {
        const on = r.slug === active;
        return (
          <Link
            key={r.slug}
            href={hrefFor(r.slug)}
            aria-current={on ? "page" : undefined}
            className={cn(PILL, on ? "bg-surface text-fg shadow-pill" : "text-muted hover:text-fg")}
          >
            {r.name}
            {r.status === "closed" ? <ClosedSuffix /> : null}
          </Link>
        );
      })}
      {overflow.length ? (
        <Menu
          label="More rounds"
          trigger={<>{overflow.length} more ▾</>}
          triggerClassName={cn(PILL, "border-0 bg-transparent text-muted hover:text-fg")}
          items={roundMenuItems(overflow, active, hrefFor)}
        />
      ) : null}
      {newRound?.onSelect ? (
        <button type="button" onClick={newRound.onSelect} className={cn(PILL, "border-0 bg-transparent text-muted hover:bg-surface/60 hover:text-fg")}>
          + Round
        </button>
      ) : newRound?.href ? (
        <Link href={newRound.href} className={cn(PILL, "text-muted hover:bg-surface/60 hover:text-fg")}>
          + Round
        </Link>
      ) : null}
    </nav>
  );

  if (collapse === "never") return trackEl;

  const current = activeRound ?? null;
  return (
    <div ref={slot} className={cn("min-w-0 flex-1 items-center", className ?? "flex")}>
      {collapsed ? (
        <nav aria-label="Rounds" className="inline-flex rounded-pill bg-sunk p-3">
          <Menu
            label="Rounds"
            minWidth={220}
            trigger={
              <>
                <span className="max-w-[18ch] truncate">{current ? current.name : "Rounds"}</span>
                {current?.status === "closed" ? <ClosedSuffix /> : null}
                <span aria-hidden className="ml-6 text-muted">
                  ▾
                </span>
              </>
            }
            triggerClassName={cn(PILL, "border-0", current ? "bg-surface text-fg shadow-pill" : "bg-transparent text-muted hover:text-fg")}
            items={roundMenuItems(ordered, active, hrefFor, newRound)}
          />
        </nav>
      ) : (
        trackEl
      )}
    </div>
  );
}
