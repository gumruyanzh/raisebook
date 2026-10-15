"use client";

import { useLayoutEffect, useRef, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { cn } from "@/lib/cn";

/**
 * The prototype table (SYSTEM 3.11). Compose:
 *   <TableScroll minWidth={980}><Table><THead><Tr><Th …/></Tr></THead><TBody>…</TBody></Table></TableScroll>
 * TableScroll is the bordered surface (radius 8) and handles horizontal overflow on phones.
 */
export function TableScroll({
  children,
  className,
  maxHeight,
  height,
  ref,
}: {
  children: ReactNode;
  className?: string;
  /** Lets sticky headers stick inside the wrapper (e.g. "70vh"). */
  maxHeight?: string;
  /** A fixed height (the pipeline table fills the viewport); rows scroll inside. */
  height?: number | string;
  ref?: Ref<HTMLDivElement>;
}) {
  const style: CSSProperties | undefined =
    maxHeight || height !== undefined ? { maxHeight, height, overflowY: "auto" } : undefined;
  return (
    <div ref={ref} className={cn("relative overflow-x-auto rounded-md border border-line bg-surface", className)} style={style}>
      {children}
    </div>
  );
}

export function Table({
  className,
  minWidth,
  style,
  stack,
  ...rest
}: ComponentProps<"table"> & {
  minWidth?: number;
  /**
   * Under 640px each row becomes a card (no sideways scroll): the first cell across the top,
   * the others in two columns, each under its column's name (read from the header).
   */
  stack?: boolean;
}) {
  const ref = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!stack || !t) return;
    const label = () => {
      // A header that is only screen-reader text ("Remove" over a Remove button) gives no label.
      const visibleText = (el: Node): string =>
        el instanceof HTMLElement && el.classList.contains("sr-only")
          ? ""
          : el.nodeType === Node.TEXT_NODE
            ? (el.textContent ?? "")
            : Array.from(el.childNodes).map(visibleText).join("");
      const heads = Array.from(t.querySelectorAll<HTMLElement>("thead tr:first-child > th")).map((th) => visibleText(th).trim());
      for (const tr of Array.from(t.querySelectorAll<HTMLTableRowElement>("tbody tr"))) {
        Array.from(tr.cells).forEach((td, i) => {
          const l = heads[i] ?? "";
          if (td.dataset.label !== l) td.dataset.label = l;
        });
      }
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(t, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [stack]);
  return (
    <table
      ref={ref}
      className={cn("w-full border-collapse text-base", stack && "rb-stack", className)}
      style={{ minWidth, ...style }}
      {...rest}
    />
  );
}

export function THead(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}

export function TBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export interface TrProps extends ComponentProps<"tr"> {
  /** Makes the row clickable: pointer, hover tint, Enter/Space activates (SYSTEM 3.11). */
  onActivate?: () => void;
  /** Selected or open: accent-soft plus a 2px inset accent rule on the left. */
  selected?: boolean;
  /** Agent-made row: 2px orchid left rule (SYSTEM §1.2). */
  agent?: boolean;
}

/** Row hover is a neutral tint, distinct from the selected accent-soft (UX pass 1, P1-2). */
export const ROW_HOVER = "hover:[&>td]:bg-[color-mix(in_oklab,var(--sunk)_55%,var(--surface))]";

/**
 * Keyboard focus on a row: a 2px inset ring drawn with cell shadows (outlines on <tr> are
 * unreliable), so sticky cells and the scroller never clip it.
 */
export const ROW_FOCUS =
  "focus-visible:outline-none " +
  "focus-visible:[&>td]:shadow-[inset_0_2px_0_var(--accent),inset_0_-2px_0_var(--accent)] " +
  "focus-visible:[&>td:first-child]:shadow-[inset_2px_0_0_var(--accent),inset_0_2px_0_var(--accent),inset_0_-2px_0_var(--accent)] " +
  "focus-visible:[&>td:last-child]:shadow-[inset_-2px_0_0_var(--accent),inset_0_2px_0_var(--accent),inset_0_-2px_0_var(--accent)]";

export function Tr({ onActivate, selected, agent, className, onKeyDown, ...rest }: TrProps) {
  const key = (e: KeyboardEvent<HTMLTableRowElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || !onActivate) return;
    if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      onActivate();
    }
  };
  return (
    <tr
      tabIndex={onActivate ? 0 : undefined}
      onClick={
        onActivate
          ? (e) => {
              // Let links, buttons and inputs inside the row do their own thing.
              if ((e.target as HTMLElement).closest("a,button,input,select,textarea,label")) return;
              onActivate();
            }
          : undefined
      }
      onKeyDown={key}
      aria-selected={selected || undefined}
      className={cn(
        "[&>td]:transition-colors [&>td]:duration-[120ms]",
        onActivate && cn("cursor-pointer", !selected && ROW_HOVER),
        selected && "[&>td]:bg-accent-soft",
        selected
          ? "[&>td:first-child]:shadow-[inset_2px_0_0_var(--accent)]"
          : agent && "[&>td:first-child]:shadow-[inset_2px_0_0_var(--agent)]",
        ROW_FOCUS,
        className,
      )}
      {...rest}
    />
  );
}

export interface ThProps extends ComponentProps<"th"> {
  /** Current sort direction of this column, if it is the sorted one. */
  sort?: "asc" | "desc" | null;
  /** Makes the header a sort button. */
  onSort?: () => void;
  align?: "left" | "right";
}

export function Th({ sort, onSort, align = "left", className, children, ...rest }: ThProps) {
  const arrow = sort === "asc" ? " ↑" : sort === "desc" ? " ↓" : "";
  return (
    <th
      scope="col"
      aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : undefined}
      className={cn(
        "t-th sticky top-0 z-[1] border-b border-line bg-surface px-10 py-8 whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        sort ? "text-fg" : "text-muted",
        className,
      )}
      {...rest}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className="t-th inline-flex items-center border-0 bg-transparent p-0 text-inherit uppercase hover:text-fg"
        >
          {children}
          {arrow ? <span aria-hidden>{arrow}</span> : null}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export interface TdProps extends ComponentProps<"td"> {
  /** Mono, tabular 12.5, right-aligned. */
  variant?: "default" | "num" | "muted";
}

export function Td({ variant = "default", className, ...rest }: TdProps) {
  return (
    <td
      className={cn(
        "border-b border-line px-10 py-8 align-top",
        variant === "num" && "t-data text-right whitespace-nowrap",
        variant === "muted" && "text-muted",
        className,
      )}
      {...rest}
    />
  );
}
