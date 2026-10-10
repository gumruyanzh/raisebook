import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Kbd } from "./Kbd";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  // One primary per view: the main action (SYSTEM 3.1).
  primary: "bg-accent text-accent-ink border border-accent hover:brightness-110",
  secondary: "bg-surface text-fg border border-line hover:border-muted",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-sunk hover:text-fg",
  // Only inside confirm dialogs (at most one solid red element per view).
  danger: "bg-bad text-accent-ink border border-bad hover:brightness-110",
  "danger-quiet": "bg-surface text-bad border border-line hover:border-bad",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-28 px-10 text-sm gap-6",
  md: "h-32 px-12 text-base gap-8",
  lg: "h-40 px-16 text-base gap-8",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-sm font-body font-medium whitespace-nowrap",
    "transition-[background-color,border-color,color,filter] duration-[120ms] ease-out",
    "disabled:opacity-55 disabled:hover:brightness-100 aria-disabled:opacity-55",
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keyboard hint on the right, e.g. "⌘↵". */
  kbd?: ReactNode;
}

export interface ButtonProps extends CommonProps, ComponentProps<"button"> {
  /**
   * Loading state: pass the label to show while busy ("Saving…"). The button is disabled and
   * keeps its width; there is no spinner (SYSTEM 3.1).
   */
  busy?: ReactNode | false;
}

export function Button({
  variant = "secondary",
  size = "md",
  kbd,
  busy,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const isBusy = busy !== undefined && busy !== false;
  return (
    <button
      type={type}
      disabled={disabled || isBusy}
      aria-busy={isBusy || undefined}
      className={buttonClasses(variant, size, cn("relative", className))}
      {...rest}
    >
      {isBusy ? (
        <>
          {/* The idle label keeps the width; the busy label sits on top. */}
          <span className="invisible inline-flex items-center gap-[inherit]" aria-hidden>
            {children}
          </span>
          <span className="absolute inset-0 flex items-center justify-center">{busy}</span>
        </>
      ) : (
        <>
          {children}
          {kbd ? <Kbd className="ml-2">{kbd}</Kbd> : null}
        </>
      )}
    </button>
  );
}

export interface ButtonLinkProps extends CommonProps, Omit<ComponentProps<typeof Link>, "href"> {
  href: string;
  /** Opens in a new tab with rel=noopener and an ↗ suffix. */
  external?: boolean;
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  kbd,
  external,
  className,
  children,
  href,
  ...rest
}: ButtonLinkProps) {
  const cls = buttonClasses(variant, size, className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
        <span aria-hidden>↗</span>
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
      {kbd ? <Kbd className="ml-2">{kbd}</Kbd> : null}
    </Link>
  );
}

/** Inline text link in accent (SYSTEM: cobalt = you can act). */
export function TextLink({
  href,
  external,
  className,
  children,
}: {
  href: string;
  external?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cn("link", className)}>
        {children} <span aria-hidden>↗</span>
      </a>
    );
  }
  return (
    <Link href={href} className={cn("link", className)}>
      {children}
    </Link>
  );
}
