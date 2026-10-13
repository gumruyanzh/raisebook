"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AddInvestorDialog } from "@/components/app/AddInvestorDialog";
import { CommandPalette, type PaletteItem } from "@/components/ui/CommandPalette";
import { ShortcutsSheet } from "@/components/ui/ShortcutsSheet";
import { StageDot } from "@/components/ui";
import { api } from "@/lib/api/client";
import type { Investor } from "@/lib/api/types";
import { findCommand, rankBy, useRegisteredCommands } from "@/lib/commands";
import { useHotkey } from "@/lib/hotkeys";
import { useOptionalWorkspace, useSession } from "@/lib/session";
import { applyThemePref } from "@/lib/theme";

const enc = encodeURIComponent;
const RECENT_KEY = (ws: string) => `rb-recent-investors:${ws}`;
const LAST_ROUTE_KEY = (ws: string) => `rb-last-route:${ws}`;

type Recent = { id: string; name: string; firm?: string | null };

function readRecent(ws: string): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY(ws)) ?? "[]");
    return Array.isArray(v) ? (v as Recent[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function pushRecent(ws: string, r: Recent) {
  try {
    const next = [r, ...readRecent(ws).filter((x) => x.id !== r.id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY(ws), JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

/** The page last used in a workspace (P2-2), so switching companies returns to it. */
export function lastRouteFor(ws: string): string | null {
  try {
    const v = localStorage.getItem(LAST_ROUTE_KEY(ws));
    return v && v.startsWith(`/w/${enc(ws)}`) ? v : null;
  } catch {
    return null;
  }
}

export function rememberRoute(ws: string): void {
  try {
    const here = `${window.location.pathname}${window.location.search}`;
    // The investor sheet is a moment, not a place: drop ?investor= from the remembered route.
    const u = new URL(here, window.location.origin);
    u.searchParams.delete("investor");
    const s = u.searchParams.toString();
    localStorage.setItem(LAST_ROUTE_KEY(ws), `${u.pathname}${s ? `?${s}` : ""}`);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Opens an investor where they are worked on: the sheet on the active round's pipeline when
 * they are in it, else the first open round they are in, else their page. A pipeline that is
 * already on screen can take the request without a navigation by calling `preventDefault()`
 * on the cancelable `rb:open-investor` window event ({detail: {id, round}}).
 */
export function investorTarget(base: string, inv: Pick<Investor, "id" | "rounds">, activeRound: string | null, openRounds: Set<string>): { href: string; round: string | null } {
  const inActive = activeRound ? inv.rounds.find((r) => r.round_slug === activeRound) : undefined;
  const inOpen = inv.rounds.find((r) => openRounds.has(r.round_slug));
  const r = inActive ?? inOpen;
  if (r) return { href: `${base}/r/${enc(r.round_slug)}?investor=${enc(inv.id)}`, round: r.round_slug };
  return { href: `${base}/investors/${enc(inv.id)}`, round: null };
}

/**
 * The keyboard layer of the signed-in app: the ⌘K palette, the `?` sheet and the global keys
 * (UX-PASS-1 P1-7). `/` focuses the page's search, `g p/o/i/s` navigate, `c` adds an investor
 * (the page's own dialog when it registers `investor.new`), ⌘1…9 switch workspace.
 */
export function AppKeyboard({
  onNewRound,
  paletteOpen,
  setPaletteOpen,
  shortcutsOpen,
  setShortcutsOpen,
}: {
  onNewRound?: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
}) {
  const session = useSession();
  const wsCtx = useOptionalWorkspace();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const registered = useRegisteredCommands();
  const [adding, setAdding] = useState(false);

  const ws = wsCtx?.workspace ?? null;
  const base = ws ? `/w/${enc(ws.slug)}` : "";
  const rounds = useMemo(() => wsCtx?.rounds ?? [], [wsCtx?.rounds]);
  const m = ws ? pathname.match(/^\/w\/[^/]+\/r\/([^/]+)/) : null;
  const activeRound = m ? decodeURIComponent(m[1]!) : null;
  const defaultRound = activeRound ?? rounds.find((r) => r.status === "open")?.slug ?? rounds[0]?.slug ?? null;
  const roundPath = useCallback((slug: string) => `${base}/r/${enc(slug)}`, [base]);
  const canWrite = Boolean(wsCtx?.canWrite);

  // Remember where the user is in this workspace (P2-2).
  useEffect(() => {
    if (ws) rememberRoute(ws.slug);
  }, [ws, pathname]);
  useEffect(() => {
    if (!ws) return;
    const save = () => rememberRoute(ws.slug);
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [ws]);

  const go = useCallback((href: string) => router.push(href), [router]);
  const pipelineHref = defaultRound ? roundPath(defaultRound) : base;
  const overviewHref = defaultRound ? `${roundPath(defaultRound)}/overview` : base;

  const newInvestor = useCallback(() => {
    const cmd = findCommand("investor.new");
    if (cmd) void cmd.run();
    else if (canWrite) setAdding(true);
  }, [canWrite]);

  const workspaceHref = useCallback(
    (slug: string) => {
      if (ws && slug === ws.slug) return null;
      if (ws) rememberRoute(ws.slug);
      return lastRouteFor(slug) ?? `/w/${enc(slug)}`;
    },
    [ws],
  );

  /* ---------- global keys ---------- */
  const inWs = Boolean(ws);
  useHotkey("mod+k", () => setPaletteOpen(!paletteOpen), {
    allowInInputs: true,
    description: "Search and commands",
    group: "General",
  });
  useHotkey(
    "/",
    () => {
      const main = document.getElementById("main") ?? document.body;
      const box = Array.from(main.querySelectorAll<HTMLInputElement>('input[type="search"]')).find(
        (el) => el.offsetParent !== null && !el.disabled,
      );
      if (box) {
        box.focus();
        box.select();
      } else setPaletteOpen(true);
    },
    { description: "Search this page", group: "General", blockedByModals: true },
  );
  useHotkey("shift+?", () => setShortcutsOpen(true), {
    description: "Keyboard shortcuts",
    group: "General",
    blockedByModals: true,
  });
  useHotkey("c", newInvestor, {
    enabled: inWs && canWrite,
    description: "Add an investor",
    group: "General",
    blockedByModals: true,
  });
  useHotkey("g p", () => go(pipelineHref), { enabled: inWs, description: "Go to pipeline", group: "Navigation", blockedByModals: true });
  useHotkey("g o", () => go(overviewHref), { enabled: inWs, description: "Go to overview", group: "Navigation", blockedByModals: true });
  useHotkey("g i", () => go(`${base}/investors`), { enabled: inWs, description: "Go to investors", group: "Navigation", blockedByModals: true });
  useHotkey("g s", () => go(`${base}/settings`), { enabled: inWs, description: "Go to settings", group: "Navigation", blockedByModals: true });
  // ⌘1…⌘9: switch workspace. Some browsers keep these for tabs; the palette lists them too.
  const wsList = session.workspaces;
  const switchTo = (i: number) => {
    const w = wsList[i];
    if (!w) return;
    const href = workspaceHref(w.slug);
    if (href) go(href);
  };
  useHotkey("mod+1", () => switchTo(0), { enabled: wsList.length > 1, description: "Switch to workspace 1…9", group: "Navigation", allowInInputs: true });
  useHotkey("mod+2", () => switchTo(1), { enabled: wsList.length > 1, allowInInputs: true });
  useHotkey("mod+3", () => switchTo(2), { enabled: wsList.length > 2, allowInInputs: true });
  useHotkey("mod+4", () => switchTo(3), { enabled: wsList.length > 3, allowInInputs: true });
  useHotkey("mod+5", () => switchTo(4), { enabled: wsList.length > 4, allowInInputs: true });
  useHotkey("mod+6", () => switchTo(5), { enabled: wsList.length > 5, allowInInputs: true });
  useHotkey("mod+7", () => switchTo(6), { enabled: wsList.length > 6, allowInInputs: true });
  useHotkey("mod+8", () => switchTo(7), { enabled: wsList.length > 7, allowInInputs: true });
  useHotkey("mod+9", () => switchTo(8), { enabled: wsList.length > 8, allowInInputs: true });

  /* ---------- palette ---------- */
  const openRounds = useMemo(() => new Set(rounds.filter((r) => r.status === "open").map((r) => r.slug)), [rounds]);

  const openInvestor = useCallback(
    (inv: Pick<Investor, "id" | "name" | "firm" | "rounds">) => {
      if (!ws) return;
      pushRecent(ws.slug, { id: inv.id, name: inv.name, firm: inv.firm });
      const t = investorTarget(base, inv, activeRound, openRounds);
      if (t.round && t.round === activeRound) {
        const ev = new CustomEvent("rb:open-investor", { detail: { id: inv.id, round: t.round }, cancelable: true });
        if (!window.dispatchEvent(ev)) return;
      }
      go(t.href);
    },
    [ws, base, activeRound, openRounds, go],
  );

  const loadItems = useMemo(() => {
    if (!ws) return undefined;
    const client = api.ws(ws.slug);
    return async (q: string, signal: AbortSignal): Promise<PaletteItem[]> => {
      const page = await client.get<{ data: Investor[] }>("/v1/investors", { q, limit: 25, sort: "relevance" }, { signal });
      const ranked = rankBy(page.data, q, (i) => i.name, (i) => [i.firm ?? "", i.email ?? "", i.title ?? ""]);
      return ranked.slice(0, 12).map((inv) => {
        const here = activeRound ? inv.rounds.find((r) => r.round_slug === activeRound) : inv.rounds[0];
        return {
          id: `inv:${inv.id}`,
          label: inv.name,
          group: "Investors",
          description: [inv.firm, inv.title].filter(Boolean).join(" · ") || inv.email || undefined,
          keywords: [inv.firm ?? "", inv.email ?? ""],
          icon: here ? <StageDot color={here.stage.color} /> : <span aria-hidden className="size-9 rounded-pill border border-line" />,
          hint: here ? (activeRound ? here.stage.label : `${here.round_name} · ${here.stage.label}`) : "Not in a round",
          run: () => openInvestor(inv),
        };
      });
    };
  }, [ws, activeRound, openInvestor]);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    // Commands from the open page or sheet lead.
    for (const c of registered) {
      out.push({ id: `cmd:${c.id}`, label: c.label, group: c.group, keywords: c.keywords, kbd: c.kbd, run: c.run });
    }
    if (ws) {
      for (const r of readRecentSafe(ws.slug)) {
        out.push({
          id: `recent:${r.id}`,
          label: r.name,
          description: r.firm ?? undefined,
          group: "Recent",
          when: "empty",
          run: async () => {
            try {
              const inv = await api.ws(ws.slug).get<Investor>(`/v1/investors/${enc(r.id)}`);
              openInvestor(inv);
            } catch {
              go(`${base}/investors/${enc(r.id)}`);
            }
          },
        });
      }
      const nav: [string, string, string, string[]][] = [
        ["Pipeline", pipelineHref, "g p", ["board", "table", "round"]],
        ["Overview", overviewHref, "g o", ["today", "follow-ups", "dashboard", "summary"]],
        ["Investors", `${base}/investors`, "g i", ["contacts", "directory", "people"]],
        ["Settings", `${base}/settings`, "g s", ["workspace", "general", "timezone", "currency"]],
      ];
      for (const [label, href, kbd, keywords] of nav) {
        out.push({ id: `go:${label}`, label: `Go to ${label.toLowerCase()}`, group: "Go to", kbd, keywords, run: () => go(href) });
      }
      out.push(
        { id: "go:members", label: "Members", group: "Go to", keywords: ["team", "invite", "co-founder"], run: () => go(`${base}/settings/members`) },
        { id: "go:keys", label: "API keys", group: "Go to", keywords: ["agent", "token"], run: () => go(`${base}/settings/api-keys`) },
        { id: "go:data", label: "Data and export", group: "Go to", keywords: ["export", "delete", "backup", "csv"], run: () => go(`${base}/settings/data`) },
      );
      if (canWrite) {
        out.push(
          { id: "act:new-investor", label: "New investor", group: "Actions", kbd: "c", keywords: ["add", "create", "contact"], run: newInvestor },
          { id: "act:import", label: "Import CSV", group: "Actions", keywords: ["spreadsheet", "upload", "bulk"], run: () => go(`${base}/import${activeRound ? `?round=${enc(activeRound)}` : ""}`) },
        );
        if (onNewRound) out.push({ id: "act:new-round", label: "New round", group: "Actions", keywords: ["create", "raise"], run: onNewRound });
      }
      out.push({ id: "act:agent", label: "Connect an agent", group: "Actions", keywords: ["mcp", "claude", "cursor", "codex"], run: () => go(`${base}/settings/mcp`) });
      for (const r of rounds) {
        if (r.slug === activeRound) continue;
        out.push({
          id: `round:${r.slug}`,
          label: r.name,
          group: "Rounds",
          hint: r.status === "closed" ? "closed" : undefined,
          keywords: ["round", "switch"],
          when: rounds.length > 6 ? "query" : undefined,
          run: () => go(roundPath(r.slug)),
        });
      }
    }
    session.workspaces.forEach((w, i) => {
      if (ws && w.slug === ws.slug) return;
      out.push({
        id: `ws:${w.slug}`,
        label: w.name,
        group: "Workspaces",
        kbd: i < 9 ? `mod+${i + 1}` : undefined,
        keywords: ["workspace", "company", "switch"],
        run: () => go(workspaceHref(w.slug) ?? `/w/${enc(w.slug)}`),
      });
    });
    out.push(
      { id: "theme:light", label: "Theme: Light", group: "Theme", when: "query", keywords: ["appearance", "mode"], run: () => applyThemePref("light") },
      { id: "theme:dark", label: "Theme: Dark", group: "Theme", when: "query", keywords: ["appearance", "mode", "night"], run: () => applyThemePref("dark") },
      { id: "theme:system", label: "Theme: System", group: "Theme", when: "query", keywords: ["appearance", "mode", "auto"], run: () => applyThemePref("system") },
      { id: "help:keys", label: "Keyboard shortcuts", group: "Help", kbd: "?", when: "query", keywords: ["hotkeys", "keys"], run: () => setShortcutsOpen(true) },
      { id: "go:account", label: "Account", group: "Go to", when: "query", keywords: ["profile", "name", "sign out", "sessions"], run: () => go("/account") },
    );
    return out;
    // readRecentSafe is read fresh each time the palette opens (paletteOpen in deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registered, ws, base, pipelineHref, overviewHref, canWrite, activeRound, rounds, session.workspaces, onNewRound, paletteOpen]);

  const activeRoundObj = activeRound ? rounds.find((r) => r.slug === activeRound) ?? null : null;

  return (
    <>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={items} loadItems={loadItems} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {ws && wsCtx && canWrite ? (
        <AddInvestorDialog
          open={adding}
          onClose={() => setAdding(false)}
          client={wsCtx.client}
          wsSlug={ws.slug}
          round={activeRoundObj}
          onAdded={(inv) => {
            setAdding(false);
            if (activeRoundObj) router.refresh();
            else go(`${base}/investors/${enc(inv.id)}`);
          }}
          onOpen={(id) => {
            setAdding(false);
            go(activeRoundObj ? `${roundPath(activeRoundObj.slug)}?investor=${enc(id)}` : `${base}/investors/${enc(id)}`);
          }}
        />
      ) : null}
    </>
  );
}

function readRecentSafe(ws: string): Recent[] {
  if (typeof window === "undefined") return [];
  return readRecent(ws);
}
