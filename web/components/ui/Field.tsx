"use client";

import {
  cloneElement,
  isValidElement,
  useId,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

/**
 * Form controls (SYSTEM 3.2). 1px line, radius 6, 32px tall. `tone="form"` (default) uses the
 * canvas background, as inside sheets and forms; `tone="toolbar"` uses surface, for controls
 * sitting on the canvas.
 */
type Tone = "form" | "toolbar" | "inline";

const CONTROL =
  "w-full min-w-0 rounded-sm border text-fg transition-[border-color,background-color] duration-[120ms] " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-bad";

/**
 * `inline` is for facts that are edited in place (the investor profile): no box until you
 * hover or focus, so the page reads as a file, not a form.
 */
const TONE: Record<Tone, string> = {
  form: "border-line bg-canvas hover:border-muted",
  toolbar: "border-line bg-surface hover:border-muted",
  inline:
    "border-transparent bg-transparent hover:border-line focus:border-accent focus:bg-canvas " +
    "disabled:opacity-100 disabled:cursor-default disabled:hover:border-transparent",
};

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
  tone?: Tone;
  size?: "sm" | "md";
  /** Mono, tabular: ids, amounts, keys. */
  mono?: boolean;
}

export function Input({ tone = "form", size = "md", mono, className, ...rest }: InputProps) {
  return (
    <input
      className={cn(
        CONTROL,
        TONE[tone],
        size === "sm" ? "h-28 px-8 text-sm" : "h-32 px-9 text-base",
        mono && "font-mono text-sm tnum",
        className,
      )}
      {...rest}
    />
  );
}

/** Search box for toolbars: type=search, flex 1 1 220px. */
export function SearchInput({ className, ...rest }: Omit<InputProps, "type">) {
  return (
    <Input
      type="search"
      tone="toolbar"
      className={cn("flex-[1_1_220px]", className)}
      {...rest}
    />
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  tone?: Tone;
}

export function Textarea({ tone = "form", className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cn(
        CONTROL,
        TONE[tone],
        "min-h-96 resize-y px-9 py-7 leading-[1.45]",
        className,
      )}
      {...rest}
    />
  );
}

export interface SelectProps extends Omit<ComponentProps<"select">, "size"> {
  tone?: Tone;
  size?: "sm" | "md";
}

/** Native <select> with a CSS chevron. */
export function Select({ tone = "form", size = "md", className, children, ...rest }: SelectProps) {
  return (
    <select
      className={cn(
        CONTROL,
        TONE[tone],
        "rb-select pr-26",
        size === "sm" ? "h-28 pl-8 text-sm" : "h-32 pl-9 text-base",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type"> {
  label?: ReactNode;
  hint?: ReactNode;
  /** A small mono note after the label, e.g. "ALWAYS ON" for a locked option. */
  badge?: ReactNode;
}

/** Native checkbox, accent-colored, with an optional label and hint. */
export function Checkbox({ label, hint, badge, className, id, ...rest }: CheckboxProps) {
  const auto = useId();
  const cid = id ?? auto;
  const box = (
    <input
      id={cid}
      type="checkbox"
      className={cn("size-16 shrink-0 accent-[var(--accent)]", !label && className)}
      {...rest}
    />
  );
  if (!label) return box;
  return (
    <label htmlFor={cid} className={cn("inline-flex items-start gap-8", className)}>
      {/* Only the box dims when disabled: the label still explains what the option does. */}
      <span className={cn("mt-2", rest.disabled && "opacity-60")}>{box}</span>
      <span>
        <span className="block">
          {label}
          {badge ? (
            <span className="ml-8 font-mono text-2xs tracking-[0.06em] text-muted uppercase">{badge}</span>
          ) : null}
        </span>
        {hint ? <span className="t-body-s block text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface RadioProps extends Omit<ComponentProps<"input">, "type"> {
  label: ReactNode;
  hint?: ReactNode;
}

/** Native radio with a label and a one-sentence explanation (import on_duplicate, scopes). */
export function Radio({ label, hint, className, id, ...rest }: RadioProps) {
  const auto = useId();
  const rid = id ?? auto;
  return (
    <label htmlFor={rid} className={cn("flex items-start gap-8", className)}>
      <input id={rid} type="radio" className="mt-3 size-16 shrink-0 accent-[var(--accent)]" {...rest} />
      <span>
        <span className="block">{label}</span>
        {hint ? <span className="t-body-s block text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface FieldError {
  message: string;
  /** The API `error.code`, shown in mono (SYSTEM §6). */
  code?: string;
}

/**
 * Label (12px muted, above) + control + hint or error. The control (a single element child)
 * gets `id`, `aria-describedby` and `aria-invalid` wired automatically.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  id,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | FieldError | null;
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  className?: string;
  id?: string;
  optional?: boolean;
}) {
  const auto = useId();
  const cid = id ?? children.props.id ?? auto;
  const noteId = `${cid}-note`;
  const err = typeof error === "string" ? { message: error } : (error ?? null);
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: cid,
        "aria-describedby": err || hint ? noteId : undefined,
        "aria-invalid": err ? true : undefined,
      })
    : children;
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <label htmlFor={cid} className="text-[12px] text-muted">
        {label}
        {optional ? <span className="text-muted"> (optional)</span> : null}
      </label>
      {control}
      {err ? (
        <p id={noteId} className="t-body-s text-bad">
          {err.message}
          {err.code ? <span className="ml-6 font-mono text-micro">{err.code}</span> : null}
        </p>
      ) : hint ? (
        <p id={noteId} className="t-body-s text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
