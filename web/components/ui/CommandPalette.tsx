"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";
import { matchRanges, rankBy } from "@/lib/commands";
import { comboKeys } from "@/lib/hotkeys";

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  /** Muted text after the label ("Harbor Light Ventures · Partner"). */
  description?: string;
  /** A hotkey combo shown as key caps on the right ("g p", "c"), or free text. */
  kbd?: string;
  hint?: ReactNode;
  keywords?: string[];
  /** Left slot (a StageDot, the agent diamond). */
  icon?: ReactNode;
  /** Shown only when the query is empty (not searchable), or only while searching. */
  when?: "empty" | "query";
  run: () => void | Promise<void>;
}

/** Bold the matched characters (weight 600, no color change). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <b key={i} className="font-semibold">
        {text.slice(a, b)}
      </b>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function KeyCaps({ combo }: { combo: string }) {
  return (
    <span className="flex shrink-0 items-center gap-3 [@media(pointer:coarse)]:hidden" aria-hidden>
      {comboKeys(combo).map((k, i) =>
        k === "then" ? (
          <span key={i} className="t-micro text-muted">
            then
          </span>
        ) : (
          <kbd
            key={i}
            className="inline-flex h-18 min-w-18 items-center justify-center rounded-kbd border border-line px-4 font-mono text-xs leading-none text-muted"
          >
            {k}
          </kbd>
        ),
      )}
    </span>
  );
}

type AsyncState =
  | { status: "idle" }
  | { status: "loading"; stale: PaletteItem[] }
  | { status: "error"; message: string }
  | { status: "done"; items: PaletteItem[] };

const MAX_SYNC = 60;

/**
 * ⌘K command palette (UX-PASS-1 P1-7b): a modal dialog holding an editable combobox over a
 * grouped listbox (ARIA 1.2). Sync `items` are ranked locally; `loadItems` (investor search)
 * is debounced, aborts stale requests and never lets a late answer replace a newer query.
 * ↑/↓ wrap, PageUp/PageDown move 10, ⌘↑/⌘↓ jump, Enter runs, Esc clears the query and then
 * closes. Focus returns to whatever had it before. Full screen under 640px.
 */
export function CommandPalette({
  open,
  onClose,
  items,
  loadItems,
  placeholder = "Search investors, go to a page, run a command…",
  label = "Command palette",
  debounceMs = 150,
  asyncGroup = "Investors",
}: {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  loadItems?: (query: string, signal: AbortSignal) => Promise<PaletteItem[]>;
  placeholder?: string;
  label?: string;
  debounceMs?: number;
  /** Label of the async group while it loads or fails. */
  asyncGroup?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<AsyncState>({ status: "idle" });
  const [retry, setRetry] = useState(0);
  const listId = useId();
  const liveId = useId();
  const latestQuery = useRef("");

  // Open / close the native modal; remember and restore focus.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActive(0);
      setRemote({ status: "idle" });
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const restoreFocus = useCallback(() => {
    const el = returnTo.current;
    returnTo.current = null;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
  }, []);

  // Async search: debounced, abortable, newest query wins.
  useEffect(() => {
    latestQuery.current = query;
    if (!open || !loadItems || !query.trim()) {
      setRemote({ status: "idle" });
      return;
    }
    const ctl = new AbortController();
    // Keep the last answer on screen while the next one loads (filtered by the new query
    // below), so typing never flickers and never shows rows the query no longer matches.
    setRemote((r) => ({ status: "loading", stale: r.status === "done" ? r.items : r.status === "loading" ? r.stale : [] }));
    const t = setTimeout(() => {
      loadItems(query.trim(), ctl.signal).then(
        (res) => {
          if (ctl.signal.aborted || latestQuery.current !== query) return;
          setRemote({ status: "done", items: res });
        },
        (err: unknown) => {
          if (ctl.signal.aborted || latestQuery.current !== query) return;
          const message = err instanceof Error && err.message ? err.message : "The search failed.";
          setRemote({ status: "error", message });
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, open, loadItems, debounceMs, retry]);

  const q = query.trim();
  const local = useMemo(() => {
    const pool = items.filter((i) => (q ? i.when !== "empty" : i.when !== "query"));
    return q
      ? rankBy(pool, q, (i) => i.label, (i) => [...(i.keywords ?? []), i.group, i.description ?? ""]).slice(0, MAX_SYNC)
      : pool;
  }, [items, q]);

  // Final ordered options, grouped. While searching, investors lead; commands keep their rank.
  const { flat, groups } = useMemo(() => {
    const flat: PaletteItem[] = [];
    const groups: { name: string; start: number; items: PaletteItem[]; status?: ReactNode }[] = [];
    const push = (name: string, its: PaletteItem[], status?: ReactNode) => {
      if (!its.length && !status) return;
      groups.push({ name, start: flat.length, items: its, status });
      flat.push(...its);
    };
    if (q && loadItems) {
      if (remote.status === "done") push(asyncGroup, remote.items);
      else if (remote.status === "loading") {
        const keep = rankBy(remote.stale, q, (i) => i.label, (i) => [...(i.keywords ?? []), i.description ?? ""]);
        push(asyncGroup, keep, keep.length ? undefined : "Searching…");
      }
    }
    const byGroup = new Map<string, PaletteItem[]>();
    for (const it of local) {
      const g = byGroup.get(it.group);
      if (g) g.push(it);
      else byGroup.set(it.group, [it]);
    }
    for (const [name, its] of byGroup) push(name, its);
    return { flat, groups };
  }, [local, remote, q, loadItems, asyncGroup]);

  const remoteKey = remote.status === "done" ? remote.items.map((i) => i.id).join(",") : remote.status;
  useEffect(() => setActive(0), [q, remoteKey]);
  const activeIdx = flat.length ? Math.min(active, flat.length - 1) : -1;
  const optionId = (i: number) => `${listId}-o${i}`;

  // Keep the active row in view.
  useEffect(() => {
    if (activeIdx < 0) return;
    document.getElementById(optionId(activeIdx))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  const runAt = (i: number) => {
    const it = flat[i];
    if (!it) return;
    returnTo.current = null; // the command decides where focus goes next
    onClose();
    void it.run();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = flat.length;
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (n) setActive(mod ? n - 1 : (activeIdx + 1) % n);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (n) setActive(mod ? 0 : (activeIdx - 1 + n) % n);
        return;
      case "PageDown":
        e.preventDefault();
        if (n) setActive(Math.min(n - 1, activeIdx + 10));
        return;
      case "PageUp":
        e.preventDefault();
        if (n) setActive(Math.max(0, activeIdx - 10));
        return;
      case "Enter":
        e.preventDefault();
        if (activeIdx >= 0) runAt(activeIdx);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery("");
        else onClose();
        return;
    }
  };

  const count = flat.length;
  const announce =
    remote.status === "loading" && !count ? "Searching" : `${count} ${count === 1 ? "result" : "results"}`;

  return (
    <dialog
      ref={dialog}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
        restoreFocus();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
      className={cn(
        "m-0 border-line bg-surface p-0 text-fg",
        // Phones: full screen. Larger: a 640px panel 12vh from the top.
        "h-dvh max-h-none w-full max-w-none border-0",
        "sm:mx-auto sm:mt-[12vh] sm:h-auto sm:max-h-[min(560px,76vh)] sm:w-[calc(100%-32px)] sm:max-w-[640px] sm:rounded-md sm:border sm:shadow-dialog",
      )}
    >
      {open ? (
        <div className="flex h-full max-h-[inherit] flex-col sm:max-h-[min(560px,76vh)]">
          <div className="flex items-center gap-10 border-b border-line px-14 pt-[env(safe-area-inset-top)]">
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeIdx >= 0 ? optionId(activeIdx) : undefined}
              aria-autocomplete="list"
              aria-describedby={liveId}
              aria-label={placeholder}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={placeholder}
              className="h-52 min-w-0 flex-1 border-0 bg-transparent text-lg outline-none placeholder:text-faint focus-visible:outline-none"
            />
            <button
              type="button"
              onClick={onClose}
              className="t-micro inline-flex h-40 shrink-0 items-center rounded-sm border-0 bg-transparent px-6 text-muted hover:text-fg sm:h-28"
            >
              <span className="hidden sm:inline">Esc</span>
              <span className="sm:hidden">Cancel</span>
            </button>
          </div>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-6"
          >
            {groups.map((g) => (
              <div key={g.name} role="group" aria-labelledby={`${listId}-g-${g.name}`}>
                <div id={`${listId}-g-${g.name}`} role="presentation" className="t-label px-14 pt-8 pb-4">
                  {g.name}
                </div>
                {g.status ? (
                  <div role="presentation" className="t-body-s px-14 py-6 text-muted">
                    {g.status}
                  </div>
                ) : null}
                {g.items.map((it, j) => {
                  const i = g.start + j;
                  const on = i === activeIdx;
                  return (
                    <Fragment key={`${it.group}:${it.id}`}>
                      <div
                        id={optionId(i)}
                        role="option"
                        aria-selected={on}
                        onPointerMove={() => {
                          if (!on) setActive(i);
                        }}
                        onClick={() => runAt(i)}
                        className={cn(
                          "mx-6 flex min-h-36 cursor-pointer items-center gap-10 rounded-sm px-8 py-6 sm:min-h-32",
                          on ? "bg-accent-soft" : "",
                        )}
                      >
                        {it.icon ? <span className="flex w-12 shrink-0 justify-center">{it.icon}</span> : null}
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-fg">
                            <Highlight text={it.label} query={q} />
                          </span>
                          {it.description ? (
                            <span className="t-body-s ml-8 text-muted">
                              <Highlight text={it.description} query={q} />
                            </span>
                          ) : null}
                        </span>
                        {it.hint ? <span className="t-micro shrink-0 text-muted">{it.hint}</span> : null}
                        {it.kbd ? <KeyCaps combo={it.kbd} /> : null}
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            ))}
            {remote.status === "error" && q ? (
              <div role="presentation" className="t-body-s flex items-center gap-8 px-14 py-8 text-bad">
                <span className="min-w-0 flex-1">{remote.message}</span>
                <button type="button" className="link border-0 bg-transparent p-0" onClick={() => setRetry((n) => n + 1)}>
                  Retry
                </button>
              </div>
            ) : null}
            {!count && remote.status !== "loading" && remote.status !== "error" ? (
              <p role="presentation" className="t-body-s px-14 py-12 text-muted">
                {q ? `Nothing matches “${q}”. Try a name, a firm or an email.` : "No commands here."}
              </p>
            ) : null}
          </div>
          <div className="t-micro hidden items-center gap-14 border-t border-line px-14 py-8 text-muted sm:flex" aria-hidden>
            <span>↑↓ to move</span>
            <span>↵ to open</span>
            <span>Esc to {q ? "clear" : "close"}</span>
          </div>
          <span id={liveId} className="sr-only" aria-live="polite">
            {announce}
          </span>
        </div>
      ) : null}
    </dialog>
  );
}
