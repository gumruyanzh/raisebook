"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./Button";
import { Field, Input } from "./Field";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One line under the title (muted). */
  description?: ReactNode;
  children?: ReactNode;
  /** Right-aligned actions: secondary first, then primary. */
  actions?: ReactNode;
  /** false: Esc and the backdrop do nothing (a one-time secret is on screen). */
  dismissible?: boolean;
  /** Wrap the body in a <form>; Enter submits. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  width?: number;
  className?: string;
}

/**
 * Native <dialog> with showModal(): focus trap, Esc and inert background for free
 * (SYSTEM 3.15). Surface, radius 8, dialog shadow, max-width 480.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  dismissible = true,
  onSubmit,
  width = 480,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const body = (
    <>
      <div className="px-20 pt-18 pb-16">
        <h2 id={titleId} className="t-display-s">
          {title}
        </h2>
        {description ? <p className="mt-4 text-muted">{description}</p> : null}
        {children ? <div className="mt-14">{children}</div> : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap justify-end gap-8 border-t border-line px-20 py-12">
          {actions}
        </div>
      ) : null}
    </>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (!openRef.current) return;
        if (dismissible) onClose();
        // The browser can close a modal on its own; if the parent still wants it open, reopen.
        else
          requestAnimationFrame(() => {
            const d = ref.current;
            if (d && openRef.current && !d.open) d.showModal();
          });
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-32px)] rounded-md border border-line bg-surface p-0 text-fg shadow-dialog",
        className,
      )}
      style={{ maxWidth: width }}
    >
      {onSubmit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(e);
          }}
        >
          {body}
        </form>
      ) : (
        body
      )}
    </dialog>
  );
}

/**
 * Confirmation for destructive actions. With `typed`, the user must type that exact text
 * (the slug, name or email) before the danger button enables.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  busyLabel = "Deleting…",
  typed,
  typedLabel,
  busy,
  error,
  danger = true,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  typed?: string;
  typedLabel?: ReactNode;
  busy?: boolean;
  error?: ReactNode;
  /** false renders a primary (cobalt) confirm, for non-destructive confirmations. */
  danger?: boolean;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) setText("");
  }, [open]);
  const ok = !typed || text.trim() === typed;
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      dismissible={!busy}
      title={title}
      onSubmit={() => {
        if (ok && !busy) void onConfirm();
      }}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={danger ? "danger" : "primary"}
            disabled={!ok}
            busy={busy ? busyLabel : false}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ? <div className="text-fg">{children}</div> : null}
      {typed ? (
        <Field
          className="mt-14"
          label={
            typedLabel ?? (
              <>
                Type <span className="font-mono text-fg">{typed}</span> to confirm
              </>
            )
          }
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            mono
          />
        </Field>
      ) : null}
      {error ? <p className="t-body-s mt-10 text-bad">{error}</p> : null}
    </Dialog>
  );
}
