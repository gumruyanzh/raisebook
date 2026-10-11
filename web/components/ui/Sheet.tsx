"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

import { useFocusTrap } from "./useFocusTrap";

/**
 * Right-side panel, min(520px, 100%) wide (SYSTEM 3.14): surface, 1px left line, scrim (no
 * shadow). Esc and the scrim close it. Focus is trapped while open, moves to the close button
 * on open and returns to the invoking element on close. Respects safe-area insets.
 */
export function Sheet({
  open,
  onClose,
  title,
  subline,
  chips,
  headerAside,
  children,
  label,
  width = 520,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subline?: ReactNode;
  /** Chip row under the title. */
  chips?: ReactNode;
  /** Right of the title, before ✕ (e.g. "Open full page ↗"). */
  headerAside?: ReactNode;
  children?: ReactNode;
  /** Accessible name when `title` is not plain text. */
  label?: string;
  width?: number;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useFocusTrap(panel, open && mounted, close);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;
  return createPortal(
    <>
      <div aria-hidden className="anim-fade fixed inset-0 z-40 bg-scrim" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
        className={cn(
          "anim-sheet fixed inset-y-0 right-0 z-50 flex flex-col border-l border-line bg-surface",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        style={{ width: `min(${width}px, 100%)` }}
      >
        <header className="flex items-start gap-10 border-b border-line px-18 pt-16 pb-12">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="t-display-s">
              {title}
            </h2>
            {subline ? <p className="mt-3 text-muted">{subline}</p> : null}
            {chips ? <div className="mt-8 flex flex-wrap gap-4">{chips}</div> : null}
          </div>
          {headerAside ? <div className="shrink-0 pt-4">{headerAside}</div> : null}
          <CloseButton ref={close} onClick={onClose} />
        </header>
        <div className="flex flex-col gap-16 overflow-y-auto px-18 pt-14 pb-24">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/** 32px square ✕ button, 1px line, radius 6. */
export function CloseButton({
  onClick,
  label = "Close",
  ref,
  className,
}: {
  onClick: () => void;
  label?: string;
  ref?: React.Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex size-32 shrink-0 items-center justify-center rounded-sm border border-line bg-surface text-muted hover:text-fg focus-visible:outline-offset-1",
        className,
      )}
    >
      ✕
    </button>
  );
}
