"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * Windowed rendering for long lists with known row heights (no library). The scroll
 * container is `scrollRef`; rows start `offset` px below its content top (a sticky table
 * header, a column header). Heights are a fixed number or a per-index function (board cards
 * have a few fixed sizes; fold any gap into the height), so no measuring is needed and the
 * scrollbar is exact.
 *
 *   const v = useVirtualRows({ scrollRef, count: rows.length, height: 32 });
 *   <div style={{ height: v.padTop }} />{rows.slice(v.start, v.end).map(…)}<div style={{ height: v.padBottom }} />
 *
 * Before the container is measured (server render, first paint) it renders the first
 * `initial` rows, so the page is never empty and the HTML stays small.
 */
export function useVirtualRows({
  scrollRef,
  count,
  height,
  overscan = 8,
  offset = 0,
  initial = 30,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  count: number;
  /** Row height in px (including borders), or a function of the index. */
  height: number | ((index: number) => number);
  overscan?: number;
  /** Space above the first row inside the scroll container (sticky header height). */
  offset?: number;
  initial?: number;
}) {
  const fixed = typeof height === "number" ? height : null;
  const heightFn = typeof height === "function" ? height : null;

  // Prefix sums of row tops for variable heights (cheap: a column holds a few hundred cards).
  const tops = useMemo(() => {
    if (fixed !== null || !heightFn) return null;
    const t = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) t[i + 1] = t[i]! + heightFn(i);
    return t;
  }, [fixed, heightFn, count]);

  const total = fixed !== null ? count * fixed : (tops?.[count] ?? 0);
  const topOf = useCallback(
    (i: number) => (fixed !== null ? i * fixed : (tops?.[Math.max(0, Math.min(i, count))] ?? 0)),
    [fixed, tops, count],
  );
  const heightOf = useCallback((i: number) => (fixed !== null ? fixed : (heightFn?.(i) ?? 0)), [fixed, heightFn]);

  /** First index whose bottom is below `y` (binary search for variable heights). */
  const indexAt = useCallback(
    (y: number) => {
      if (y <= 0) return 0;
      if (fixed !== null) return Math.min(count, Math.floor(y / fixed));
      if (!tops) return 0;
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid + 1]! <= y) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [fixed, tops, count],
  );

  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  const frame = useRef(0);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = { top: el.scrollTop - offset, height: el.clientHeight };
    setView((v) => (v && v.top === next.top && v.height === next.height ? v : next));
  }, [scrollRef, offset]);

  useLayoutEffect(() => {
    measure();
  }, [measure, count]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [scrollRef, measure]);

  let start = 0;
  let end = Math.min(count, initial);
  if (view) {
    start = Math.max(0, indexAt(view.top) - overscan);
    end = Math.min(count, indexAt(view.top + view.height) + 1 + overscan);
  }
  const padTop = topOf(start);
  const padBottom = Math.max(0, total - topOf(end));

  /** Scroll so row `i` is fully visible (used by roving focus); returns true if it moved. */
  const scrollToIndex = useCallback(
    (i: number, align: "nearest" | "start" = "nearest") => {
      const el = scrollRef.current;
      if (!el || i < 0 || i >= count) return false;
      const top = topOf(i) + offset;
      const bottom = top + heightOf(i);
      // A sticky header covers `offset` px at the top of the viewport.
      const viewTop = el.scrollTop + offset;
      const viewBottom = el.scrollTop + el.clientHeight;
      let next = el.scrollTop;
      if (align === "start" || top < viewTop) next = top - offset;
      else if (bottom > viewBottom) next = bottom - el.clientHeight;
      if (next === el.scrollTop) return false;
      el.scrollTop = Math.max(0, next);
      measure();
      return true;
    },
    [scrollRef, count, topOf, heightOf, offset, measure],
  );

  return { start, end, padTop, padBottom, total, scrollToIndex, topOf };
}
