"use client";

import Link from "next/link";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
}

const TAB =
  "relative -mb-px inline-flex h-36 items-center border-b-2 px-2 font-medium whitespace-nowrap transition-colors duration-[120ms]";

/**
 * Underline tabs (SYSTEM 3.22): 2px fg underline on the active tab, muted inactive,
 * `role="tablist"` with arrow-key navigation. Render the panel yourself with
 * `id={tabPanelId(baseId, value)}`; or use `<TabLinks>` for route tabs.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
  idBase,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  /** Prefix for tab/panel ids; defaults to a generated id. */
  idBase?: string;
}) {
  const auto = useId();
  const base = idBase ?? auto;
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = items.findIndex((t) => t.value === value);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = items.length - 1;
    if (n < 0) return;
    e.preventDefault();
    const next = items[n]!;
    onChange(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className={cn("flex gap-18 overflow-x-auto border-b border-line scrollbar-none", className)}
    >
      {items.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`${base}-tab-${t.value}`}
            data-value={t.value}
            aria-selected={active}
            aria-controls={tabPanelId(base, t.value)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cn(
              TAB,
              "bg-transparent",
              active ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const tabPanelId = (base: string, value: string) => `${base}-panel-${value}`;

/** Route tabs: same look, real links with `aria-current="page"` on the active one. */
export function TabLinks({
  items,
  active,
  label,
  className,
}: {
  items: { href: string; label: ReactNode; key: string }[];
  active: string;
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn("flex gap-18 overflow-x-auto border-b border-line scrollbar-none", className)}
    >
      {items.map((t) => {
        const on = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              TAB,
              on ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
