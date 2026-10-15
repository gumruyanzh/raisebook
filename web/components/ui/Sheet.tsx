"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

import { useFocusTrap } from "./useFocusTrap";

/**
 * Right-side panel, min(520px, 100%) wide (SYSTEM 3.14): surface, 1px left line, scrim (no
 * shadow). Esc and the scrim close it. Focus is trapped while open, moves to the close button
 * (or, with `focusTitle`, to the title, so a pointer open shows no ring) and returns to the
 * invoking element on close. Respects safe-area insets.
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
  focusTitle,
  bodyRef,
  modal = true,
  top,
  footer,
  bottomOnPhone,
}: {
  /** Pinned under the scrolling body (e.g. "Show 100 investors"). */
  footer?: ReactNode;
  /** On a phone, slide up from the bottom (a bottom sheet) instead of in from the right. */
  bottomOnPhone?: boolean;
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
  /** Focus the title on open instead of ✕ (the investor sheet). */
  focusTitle?: boolean;
  /** The scrolling body (to scroll back to the top when the content changes). */
  bodyRef?: Ref<HTMLDivElement>;
  /**
   * `false`: a split panel beside the page (no scrim, no focus trap, focus stays where it
   * is), so the list stays usable while the file is open. Esc still closes it.
   */
  modal?: boolean;
  /** Top offset for a split panel (below the app bar). */
  top?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useFocusTrap(panel, open && mounted && modal, focusTitle ? titleRef : close);

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
      {modal ? <div aria-hidden className="anim-fade fixed inset-0 z-40 bg-scrim" onClick={onClose} /> : null}
      <div
        ref={panel}
        role="dialog"
        aria-modal={modal ? "true" : "false"}
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
        className={cn(
          "anim-sheet fixed inset-y-0 right-0 z-50 flex flex-col border-l border-line bg-surface",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          bottomOnPhone &&
            "phone:anim-sheet-up phone:top-auto! phone:max-h-[88dvh] phone:w-full! phone:rounded-t-[14px] phone:border-t phone:border-l-0 phone:pt-0 phone:shadow-dialog",
          className,
        )}
        style={{ width: `min(${width}px, 100%)`, ...(top !== undefined ? { top } : null) }}
      >
        {bottomOnPhone ? <span aria-hidden className="mx-auto mt-8 hidden h-4 w-36 shrink-0 rounded-pill bg-line phone:block" /> : null}
        <header className="flex items-start gap-10 border-b border-line px-18 pt-16 pb-12">
          <div className="min-w-0 flex-1">
            <h2 ref={titleRef} id={titleId} tabIndex={focusTitle ? -1 : undefined} className="t-display-s outline-none">
              {title}
            </h2>
            {subline ? <p className="mt-3 text-muted">{subline}</p> : null}
            {chips ? <div className="mt-8 flex flex-wrap gap-4">{chips}</div> : null}
          </div>
          {headerAside ? <div className="shrink-0 pt-4">{headerAside}</div> : null}
          <CloseButton ref={close} onClick={onClose} />
        </header>
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-16 overflow-y-auto overscroll-contain px-18 pt-14 pb-24 phone:px-16">
          {children}
        </div>
        {footer ? (
          <div className="flex shrink-0 gap-8 border-t border-line bg-surface px-18 py-12 phone:px-16 phone:[&>*]:flex-1">{footer}</div>
        ) : null}
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
        "inline-flex size-32 shrink-0 items-center justify-center rounded-sm border border-line bg-surface text-muted hover:text-fg focus-visible:outline-offset-1 touch:size-44",
        className,
      )}
    >
      ✕
    </button>
  );
}
