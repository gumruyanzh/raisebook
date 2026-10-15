"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

export type MenuEntry =
  | {
      type?: "item";
      label: ReactNode;
      /** Text for typeahead when `label` is not a string. */
      textValue?: string;
      onSelect?: () => void;
      href?: string;
      disabled?: boolean;
      /** Right-aligned muted hint (a role, a count, a shortcut). */
      hint?: ReactNode;
      /** Marks the current choice (workspace, stage) with aria-checked. */
      selected?: boolean;
      danger?: boolean;
      /** Left slot (a StageDot). */
      icon?: ReactNode;
      /** One key that picks this item while the menu is open ("7" in Move to…); shown as the hint. */
      accel?: string;
    }
  | { type: "separator" }
  | { type: "label"; label: ReactNode };

type ItemEntry = Extract<MenuEntry, { label: ReactNode; type?: "item" }>;

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';

function menuItems(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
}

function isItem(e: MenuEntry): e is ItemEntry {
  return e.type === undefined || e.type === "item";
}

/**
 * Popover list (SYSTEM 3.23): surface, 1px line, radius 8, menu shadow. Keyboard: ↑/↓, Home/End,
 * Enter/Space, Esc (returns focus to the trigger), Tab closes, typeahead on letters.
 * Uncontrolled by default; pass `open` + `onOpenChange` to open it from elsewhere (the board's
 * "M" key opens a card's "Move to…" menu).
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  items,
  align = "start",
  open: controlledOpen,
  onOpenChange,
  className,
  minWidth = 200,
}: {
  /** Accessible name of the menu ("Workspace", "Move to"). */
  label: string;
  /** Trigger button content. Omit for a controlled menu anchored to its wrapper. */
  trigger?: ReactNode;
  triggerClassName?: string;
  items: MenuEntry[];
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  minWidth?: number;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = useCallback(
    (v: boolean) => {
      if (controlledOpen === undefined) setInnerOpen(v);
      onOpenChange?.(v);
    },
    [controlledOpen, onOpenChange],
  );
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const typed = useRef({ text: "", at: 0 });

  const focusables = () => menuItems(list.current);

  const focusAt = (i: number) => {
    const els = focusables();
    if (!els.length) return;
    els[(i + els.length) % els.length]?.focus();
  };

  // Fixed positioning from the wrapper's rect, so scroll containers never clip the menu.
  // On a phone (the compact layout) the menu is a bottom sheet instead: full width, within
  // thumb reach, with 44px+ rows.
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | "sheet" | null>(null);
  const sheet = pos === "sheet";
  const placed = pos !== null;

  // Focus the selected (or first) item once the menu is placed (an invisible list cannot
  // take focus, so a menu opened by a key would otherwise miss its first keystroke).
  useEffect(() => {
    if (!open || !placed) return;
    const els = menuItems(list.current);
    const sel = els.findIndex((el) => el.getAttribute("aria-checked") === "true");
    (els[sel >= 0 ? sel : 0] ?? list.current)?.focus();
  }, [open, placed]);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      if (window.matchMedia("(max-width: 639px), (max-height: 499px)").matches) {
        setPos("sheet");
        return;
      }
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      const top = r.bottom + 4;
      if (align === "end") setPos({ top, right: Math.max(8, vw - r.right) });
      else setPos({ top, left: Math.max(8, Math.min(r.left, vw - minWidth - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, minWidth]);

  // Close on outside pointer down.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // The phone's bottom sheet is portaled to <body>: a tap inside it is not "outside".
      if (
        wrap.current &&
        !wrap.current.contains(t) &&
        !list.current?.contains(t) &&
        !(t instanceof Element && t.closest("[data-menu-scrim]"))
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, setOpen]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = focusables();
    const i = els.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(i + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusAt(i - 1);
        return;
      case "Home":
        e.preventDefault();
        focusAt(0);
        return;
      case "End":
        e.preventDefault();
        focusAt(els.length - 1);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const hit = els.find((el) => el.dataset.accel === e.key.toLowerCase());
      if (hit) {
        e.preventDefault();
        hit.click();
        return;
      }
    }
    if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current.text = now - typed.current.at > 600 ? e.key : typed.current.text + e.key;
      typed.current.at = now;
      const q = typed.current.text.toLowerCase();
      const hit = els.findIndex((el) => (el.dataset.text ?? el.textContent ?? "").trim().toLowerCase().startsWith(q));
      if (hit >= 0) els[hit]?.focus();
    }
  };

  const listEl = (
    <div
      ref={list}
      id={menuId}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKey}
      className={cn(
        sheet
          ? "anim-sheet-up fixed inset-x-0 bottom-0 z-[81] max-h-[min(560px,80dvh)] overflow-y-auto overscroll-contain rounded-t-[14px] border-t border-line bg-surface pt-6 pb-[calc(10px+env(safe-area-inset-bottom))] shadow-dialog"
          : "anim-fade fixed z-[45] max-h-[min(420px,70vh)] overflow-y-auto rounded-md border border-line bg-surface py-4 shadow-menu",
        !pos && "invisible",
      )}
      style={sheet ? undefined : { minWidth, ...(typeof pos === "object" ? pos : null) }}
    >
      {sheet ? (
        <div className="sticky top-0 z-[1] -mt-6 flex flex-col items-center bg-surface pt-6 pb-4" role="presentation">
          <span aria-hidden className="mb-6 h-4 w-36 rounded-pill bg-line" />
          <span className="t-label w-full truncate px-16 py-4 text-center">{label}</span>
        </div>
      ) : null}
      {items.map((entry, idx) => {
        if (entry.type === "separator") {
          return <div key={idx} role="separator" className="my-4 border-t border-line" />;
        }
        if (entry.type === "label") {
          return (
            <div key={idx} className={cn("t-label px-12 pt-6 pb-4", sheet && "px-16 pt-10")} role="presentation">
              {entry.label}
            </div>
          );
        }
        if (!isItem(entry)) return null;
        const role = entry.selected !== undefined ? "menuitemradio" : "menuitem";
        const cls = cn(
          "flex w-full items-center gap-8 border-0 bg-transparent px-12 py-6 text-left text-base whitespace-nowrap outline-none touch:min-h-44",
          sheet && "min-h-48 px-16 text-[16px]",
          "focus-visible:bg-accent-soft hover:bg-accent-soft focus:bg-accent-soft",
          entry.danger ? "text-bad" : "text-fg",
          entry.disabled && "cursor-not-allowed opacity-50",
        );
        const text = entry.textValue ?? (typeof entry.label === "string" ? entry.label : undefined);
        const inner = (
          <>
            {entry.icon}
            <span className={cn("min-w-0 flex-1 truncate", entry.selected && "font-semibold")}>{entry.label}</span>
            {entry.hint ? <span className="t-micro text-muted">{entry.hint}</span> : null}
            {entry.accel && !entry.hint ? (
              <kbd className="inline-flex h-18 min-w-18 items-center justify-center rounded-kbd border border-line px-4 font-mono text-xs text-muted touch:hidden">
                {entry.accel}
              </kbd>
            ) : null}
          </>
        );
        const common = {
          role,
          tabIndex: -1,
          "aria-checked": entry.selected,
          "aria-disabled": entry.disabled || undefined,
          "data-text": text,
          "data-accel": entry.accel?.toLowerCase(),
          className: cls,
        } as const;
        if (entry.href && !entry.disabled) {
          return (
            <Link
              key={idx}
              href={entry.href}
              {...common}
              onClick={() => {
                entry.onSelect?.();
                close(false);
              }}
            >
              {inner}
            </Link>
          );
        }
        return (
          <button
            key={idx}
            type="button"
            {...common}
            onClick={() => {
              if (entry.disabled) return;
              close(true);
              entry.onSelect?.();
            }}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );

  return (
    <div ref={wrap} className={cn("relative inline-flex", className)}>
      {trigger !== undefined ? (
        <button
          ref={btn}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={triggerClassName}
        >
          {trigger}
        </button>
      ) : null}
      {open
        ? sheet && typeof document !== "undefined"
          ? createPortal(
              // On a phone the sheet leaves any stacking context (a fixed tab bar, a sheet).
              <>
                <div aria-hidden data-menu-scrim className="anim-fade fixed inset-0 z-[80] bg-scrim" onClick={() => close(true)} />
                {listEl}
              </>,
              // Inside a modal <dialog> the rest of the page is inert: stay in the dialog.
              wrap.current?.closest("dialog") ?? document.body,
            )
          : listEl
        : null}
    </div>
  );
}
