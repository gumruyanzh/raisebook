"use client";

import { useEffect, type RefObject } from "react";

/**
 * Sideways movement for the kanban board wherever the pointer is (owner report, Oct 14:
 * dragging left or right did nothing with the cursor over a column).
 *
 * - Trackpad swipes and Shift+wheel over a column move the board, not the column.
 * - Click-and-drag on empty board space (column backgrounds, headers, gaps) pans it.
 *   Cards, buttons, links and fields keep their own behaviour, so card drag-and-drop still works.
 */
export function useBoardPan(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const board = ref.current;
    if (!board) return;

    const onWheel = (e: WheelEvent) => {
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      // Only act on mostly-horizontal gestures; vertical scrolling stays with the column.
      if (Math.abs(dx) <= Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
      const max = board.scrollWidth - board.clientWidth;
      if (max <= 0) return;
      const next = Math.min(max, Math.max(0, board.scrollLeft + dx));
      if (next === board.scrollLeft) return;
      e.preventDefault();
      board.scrollLeft = next;
    };

    const INTERACTIVE = 'a,button,input,textarea,select,label,[role="button"],[draggable="true"],[data-investor]';
    let startX = 0;
    let startLeft = 0;
    let pointer: number | null = null;
    let moved = false;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      const t = e.target as Element | null;
      if (!t || t.closest(INTERACTIVE)) return;
      if (board.scrollWidth <= board.clientWidth) return;
      pointer = e.pointerId;
      startX = e.clientX;
      startLeft = board.scrollLeft;
      moved = false;
    };
    const onMove = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      const d = e.clientX - startX;
      if (!moved && Math.abs(d) < 4) return;
      if (!moved) {
        moved = true;
        board.setPointerCapture(e.pointerId);
        board.style.cursor = "grabbing";
        board.style.userSelect = "none";
      }
      board.scrollLeft = startLeft - d;
    };
    const onUp = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      pointer = null;
      if (moved && board.hasPointerCapture(e.pointerId)) board.releasePointerCapture(e.pointerId);
      board.style.cursor = "";
      board.style.userSelect = "";
    };
    // A pan that moved must not also count as a click on whatever is under the pointer.
    const onClick = (e: MouseEvent) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    };

    board.addEventListener("wheel", onWheel, { passive: false });
    board.addEventListener("pointerdown", onDown);
    board.addEventListener("pointermove", onMove);
    board.addEventListener("pointerup", onUp);
    board.addEventListener("pointercancel", onUp);
    board.addEventListener("click", onClick, true);
    return () => {
      board.removeEventListener("wheel", onWheel);
      board.removeEventListener("pointerdown", onDown);
      board.removeEventListener("pointermove", onMove);
      board.removeEventListener("pointerup", onUp);
      board.removeEventListener("pointercancel", onUp);
      board.removeEventListener("click", onClick, true);
    };
  }, [ref]);
}
