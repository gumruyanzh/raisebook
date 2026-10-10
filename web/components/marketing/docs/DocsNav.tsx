"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Select } from "@/components/ui";
import { cn } from "@/lib/cn";

import { DOCS_NAV } from "./nav";

/** Docs navigation: a sticky 220px list from 1024px, a select on smaller screens. */
export function DocsNav() {
  const path = usePathname() ?? "/docs";
  const router = useRouter();
  const current = DOCS_NAV.find((n) => n.href === path)?.href ?? "/docs";
  return (
    <>
      <div className="xl:hidden">
        <label htmlFor="docs-nav" className="t-label mb-6 block">
          Docs
        </label>
        <Select
          id="docs-nav"
          tone="toolbar"
          value={current}
          onChange={(e) => router.push(e.target.value)}
        >
          {DOCS_NAV.map((n) => (
            <option key={n.href} value={n.href}>
              {n.label}
            </option>
          ))}
        </Select>
      </div>
      <nav aria-label="Docs" className="sticky top-24 hidden xl:block">
        <p className="t-label mb-10">Docs</p>
        <ul className="m-0 flex list-none flex-col border-l border-line p-0">
          {DOCS_NAV.map((n) => {
            const on = n.href === path;
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "-ml-px block border-l-2 py-6 pl-12 transition-colors duration-[120ms]",
                    on
                      ? "border-accent font-medium text-fg"
                      : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
