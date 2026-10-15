import Link from "next/link";
import type { ReactNode } from "react";

import { JsonLd } from "@/components/marketing/JsonLd";
import { cn } from "@/lib/cn";
import { pageGraph } from "@/lib/seo/schema";

import { DOCS_NAV } from "./nav";

/**
 * Docs and legal page building blocks (SYSTEM §4.15): display-l H1, display-xs H2 with an
 * anchor that appears on hover or focus, body-l paragraphs at a 680px measure, ruled tables
 * with mono names. Server components only (no handlers), so pages stay static.
 */

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function DocHeader({
  eyebrow,
  title,
  lede,
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
}) {
  return (
    <header className="mb-32">
      {eyebrow ? <p className="t-label mb-10">{eyebrow}</p> : null}
      <h1 className="t-display-l">{title}</h1>
      {lede ? <div className="t-body-l mt-14 text-muted">{lede}</div> : null}
    </header>
  );
}

export function H2({ children, id }: { children: string; id?: string }) {
  const anchor = id ?? slug(children);
  return (
    <h2 id={anchor} className="group t-display-xs mt-48 mb-12 scroll-mt-24">
      {children}
      <a
        href={`#${anchor}`}
        aria-label={`Link to ${children}`}
        className="ml-8 font-mono text-[14px] font-normal text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        #
      </a>
    </h2>
  );
}

export function H3({ children, id, mono }: { children: string; id?: string; mono?: boolean }) {
  const anchor = id ?? slug(children);
  return (
    <h3
      id={anchor}
      className={cn(
        "group mt-32 mb-8 scroll-mt-24",
        mono ? "font-mono text-[15px] font-medium" : "text-[16px] font-semibold",
      )}
    >
      {children}
      <a
        href={`#${anchor}`}
        aria-label={`Link to ${children}`}
        className="ml-8 font-mono text-[13px] font-normal text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        #
      </a>
    </h3>
  );
}

export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("t-body-l mb-14", className)}>{children}</p>;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("t-body-s mb-14 text-muted", className)}>{children}</p>;
}

export function Ul({ children, ordered }: { children: ReactNode; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={cn(
        "t-body-l mb-14 flex flex-col gap-6 pl-20",
        ordered ? "list-decimal marker:font-mono marker:text-[13px] marker:text-muted" : "list-disc marker:text-faint",
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * Inline code: mono on sunk. Short tokens never break ("X-API-Key" stays whole); only long
 * ones (URLs, long paths) may wrap, so a phone never scrolls sideways.
 */
export function C({ children }: { children: ReactNode }) {
  const short = typeof children === "string" && children.length <= 32;
  return (
    <code
      className={
        "rounded-xs bg-sunk px-4 py-1 font-mono text-[0.86em] " +
        (short ? "whitespace-nowrap" : "[overflow-wrap:anywhere]")
      }
    >
      {children}
    </code>
  );
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="link">
        {children} <span aria-hidden>↗</span>
      </a>
    );
  }
  return (
    <Link href={href} className="link">
      {children}
    </Link>
  );
}

/** A note set off by a left rule. `tone="warn"` uses warm for things to fill in before launch. */
export function Note({
  children,
  tone = "info",
  label,
}: {
  children: ReactNode;
  tone?: "info" | "warn";
  label?: string;
}) {
  return (
    <aside
      className={cn(
        "mb-18 border-l-2 py-4 pl-14",
        tone === "warn" ? "border-warm" : "border-accent",
      )}
    >
      {label ? (
        <p className="t-label mb-4">{label}</p>
      ) : null}
      <div className="t-body-s text-fg [&_p+p]:mt-6">{children}</div>
    </aside>
  );
}

/**
 * A ruled reference table on a surface. The first column is mono by default (parameter and
 * field names). Wide tables scroll inside their own box on phones.
 */
export function DocTable({
  head,
  rows,
  monoFirst = true,
  minWidth = 520,
  caption,
  className,
  widths,
}: {
  head: string[];
  rows: ReactNode[][];
  monoFirst?: boolean;
  minWidth?: number;
  caption?: string;
  className?: string;
  /** Column widths (CSS lengths), for tables that repeat down a page. */
  widths?: string[];
}) {
  return (
    <div className={cn("mb-18 overflow-x-auto rounded-md border border-line bg-surface", className)}>
      <table
        className={cn("w-full border-collapse text-13", widths && "table-fixed")}
        style={{ minWidth }}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {widths ? (
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
        ) : null}
        <thead className={head.some(Boolean) ? undefined : "sr-only"}>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="t-th border-b border-line px-10 py-8 text-left whitespace-nowrap text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="[&:last-child>*]:border-b-0">
              {r.map((cell, j) => {
                // A blank first header means the first column labels the rows: render it as <th scope="row">.
                const Cell = j === 0 && head[0] === "" ? "th" : "td";
                return (
                <Cell
                  key={j}
                  scope={Cell === "th" ? "row" : undefined}
                  className={cn(
                    "border-b border-line px-10 py-8 align-top",
                    Cell === "th" && "text-left font-normal",
                    j === 0 && monoFirst && "font-mono text-[12.5px] text-fg [overflow-wrap:anywhere]",
                    j === 0 && monoFirst && !widths && "whitespace-nowrap",
                    j > 0 && "text-fg",
                  )}
                >
                  {cell}
                </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous / next links at the bottom of a docs page. */
export function DocPager({
  prev,
  next,
}: {
  prev?: { href: string; label: string };
  next?: { href: string; label: string };
}) {
  return (
    <nav aria-label="More docs" className="mt-64 flex flex-wrap justify-between gap-14 border-t border-line pt-18">
      {prev ? (
        <Link href={prev.href} className="group flex flex-col">
          <span className="t-label">Previous</span>
          <span className="link mt-2">← {prev.label}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={next.href} className="group flex flex-col text-right">
          <span className="t-label">Next</span>
          <span className="link mt-2">{next.label} →</span>
        </Link>
      ) : null}
    </nav>
  );
}

/**
 * Pager computed from the docs nav order. Every docs page ends with it, so it also carries the
 * page's structured data (TechArticle + BreadcrumbList, from lib/seo/pages.ts).
 */
export function DocPagerFor({ href }: { href: string }) {
  const pages = DOCS_NAV.filter((n) => n.href.startsWith("/docs"));
  const i = pages.findIndex((n) => n.href === href);
  return (
    <>
      <JsonLd data={pageGraph(href)} />
      <DocPager prev={i > 0 ? pages[i - 1] : undefined} next={i >= 0 ? pages[i + 1] : undefined} />
    </>
  );
}

/** Renders `backticked` spans of spec text as inline code. */
export function Ticks({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <C key={i}>{p}</C> : <span key={i}>{p}</span>))}
    </>
  );
}
