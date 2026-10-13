"use client";

import { useMemo } from "react";

import { comboKeys, useHotkeyList } from "@/lib/hotkeys";

import { Button } from "./Button";
import { Dialog } from "./Dialog";

const GROUP_ORDER = ["General", "Navigation", "Pipeline", "Investor file", "Investor", "Today", "Table", "Board", "Import"];

function Caps({ combo }: { combo: string }) {
  return (
    <span className="flex shrink-0 items-center gap-3">
      {comboKeys(combo).map((k, i) =>
        k === "then" ? (
          <span key={i} className="t-micro text-muted">
            then
          </span>
        ) : (
          <kbd
            key={i}
            className="inline-flex h-20 min-w-20 items-center justify-center rounded-kbd border border-line bg-surface px-5 font-mono text-xs leading-none text-muted"
          >
            {k}
          </kbd>
        ),
      )}
    </span>
  );
}

/**
 * The `?` sheet: every hotkey that is live on this page, grouped. Lists what `useHotkey`
 * registrations describe, so a page's own keys (the board's M, the Today queue's E) show up
 * only where they work.
 */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useHotkeyList();
  const groups = useMemo(() => {
    const m = new Map<string, typeof list>();
    for (const h of list) {
      const g = m.get(h.group);
      if (g) g.push(h);
      else m.set(h.group, [h]);
    }
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i < 0 ? GROUP_ORDER.length : i;
    };
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [list]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      width={560}
      scrollBody
      actions={
        <Button autoFocus onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-18 sm:grid-cols-2">
        {groups.map(([name, items]) => (
          <section key={name} aria-label={name}>
            <h3 className="t-label mb-6">{name}</h3>
            <dl className="m-0 flex flex-col">
              {items.map((h) => (
                <div key={h.id} className="flex min-h-30 items-center gap-10 border-b border-line py-4 last:border-b-0">
                  <dt className="min-w-0 flex-1 text-13">{h.description}</dt>
                  <dd className="m-0">
                    <Caps combo={h.combo} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="t-body-s mt-14 text-muted">Shortcuts never fire while you are typing in a field.</p>
    </Dialog>
  );
}
