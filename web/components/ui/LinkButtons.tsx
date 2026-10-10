"use client";

import { cn } from "@/lib/cn";

import { useToast } from "./Toast";

export interface LinkButtonItem {
  href: string;
  label: string;
}

const BTN =
  "inline-flex h-28 items-center rounded-sm border border-line bg-surface px-9 text-sm text-accent hover:border-accent";

/**
 * The prototype `.links` (SYSTEM 3.32): small bordered link buttons with accent text
 * ("LinkedIn ↗", "Website ↗", "X ↗") and "name@example.com · copy".
 */
export function LinkButtons({
  linkedin,
  website,
  x,
  email,
  extra = [],
  className,
}: {
  linkedin?: string | null;
  website?: string | null;
  x?: string | null;
  email?: string | null;
  extra?: LinkButtonItem[];
  className?: string;
}) {
  const toast = useToast();
  const links: LinkButtonItem[] = [
    ...(linkedin ? [{ href: linkedin, label: "LinkedIn" }] : []),
    ...(website ? [{ href: website, label: "Website" }] : []),
    ...(x ? [{ href: x, label: "X" }] : []),
    ...extra,
  ].filter((l) => /^https?:\/\//i.test(l.href));
  if (!links.length && !email) return null;
  return (
    <div className={cn("flex flex-wrap gap-6", className)}>
      {links.map((l) => (
        <a key={l.href + l.label} href={l.href} target="_blank" rel="noopener noreferrer" className={BTN}>
          {l.label} <span aria-hidden className="ml-4">↗</span>
        </a>
      ))}
      {email ? (
        <button
          type="button"
          className={BTN}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(email);
              toast.show("Email copied.");
            } catch {
              toast.show(email);
            }
          }}
        >
          {email} · copy
        </button>
      ) : null}
    </div>
  );
}
