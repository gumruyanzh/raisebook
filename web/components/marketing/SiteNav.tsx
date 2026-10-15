"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { REPO_URL } from "./site";

const LINKS: { href: string; label: string; match: (p: string) => boolean; wide?: boolean }[] = [
  { href: "/docs", label: "Docs", match: (p: string) => p === "/docs" || (p.startsWith("/docs/") && !p.startsWith("/docs/mcp")) },
  { href: "/docs/mcp", label: "MCP", match: (p: string) => p.startsWith("/docs/mcp") },
  { href: "/compare", label: "Compare", match: (p: string) => p.startsWith("/compare") },
  { href: "/pricing", label: "Pricing", match: (p: string) => p === "/pricing" },
  { href: "/privacy", label: "Privacy", match: (p: string) => p === "/privacy", wide: true },
];

/** The marketing nav links (SYSTEM §4.14 item 1). The active link gets fg and an accent rule. */
export function SiteNav({ className }: { className?: string }) {
  const path = usePathname() ?? "/";
  return (
    <nav aria-label="Site" className={cn("items-center gap-20", className)}>
      {LINKS.map((l) => {
        const on = l.match(path);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative py-6 font-medium transition-colors duration-[120ms]",
              l.wide && "hidden xl:inline",
              on
                ? "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-2 after:bg-accent"
                : "text-muted hover:text-fg",
            )}
          >
            {l.label}
          </Link>
        );
      })}
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden py-6 font-medium text-muted transition-colors duration-[120ms] hover:text-fg xl:inline"
      >
        GitHub <span aria-hidden>↗</span>
      </a>
    </nav>
  );
}
