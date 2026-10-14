"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { NameDialog, useNamePrompt } from "@/components/app/NamePrompt";
import { NewRoundDialog } from "@/components/app/settings/NewRoundDialog";
import { NewWorkspaceDialog } from "@/components/app/settings/NewWorkspaceDialog";
import { TopBar, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { createWorkspace, signOut } from "@/lib/api/core";
import { listFollowUps } from "@/lib/api/rounds";
import { useOptionalWorkspace, useSession } from "@/lib/session";

import { AppKeyboard, lastRouteFor, rememberRoute } from "./AppKeyboard";

const enc = encodeURIComponent;

/**
 * Route-aware TopBar for the signed-in app. Works inside a workspace (rounds, nav) and outside
 * one (/account). "+ Round" opens the new-round dialog in place; the palette, the shortcuts
 * sheet and the global keys (AppKeyboard) live here so every app page has them.
 */
export function WorkspaceTopBar() {
  const session = useSession();
  const wsCtx = useOptionalWorkspace();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const toast = useToast();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [newRound, setNewRound] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [due, setDue] = useState<Record<string, number>>({});
  const dueLoaded = useRef(0);

  const openName = useCallback(() => setNameOpen(true), []);
  const needsName = useNamePrompt(openName);

  const ws = wsCtx?.workspace ?? null;
  const base = ws ? `/w/${enc(ws.slug)}` : "";
  const rounds = wsCtx?.rounds ?? [];

  // /w/<ws>/r/<round>[/overview|/settings]
  const m = ws ? pathname.match(/^\/w\/[^/]+\/r\/([^/]+)(\/[^/]+)?/) : null;
  const activeRound = m ? decodeURIComponent(m[1]!) : null;
  const sub = m?.[2] ?? "";
  const defaultRound =
    activeRound ?? rounds.find((r) => r.status === "open")?.slug ?? rounds[0]?.slug ?? null;

  let activeNav: string | null = null;
  if (m && sub === "") activeNav = "pipeline";
  else if (m && sub === "/overview") activeNav = "overview";
  else if (ws && pathname.startsWith(`${base}/investors`)) activeNav = "investors";
  else if (ws && pathname.startsWith(`${base}/meetings`)) activeNav = "meetings";
  else if (ws && pathname.startsWith(`${base}/settings`)) activeNav = "settings";

  const roundPath = (slug: string) => `${base}/r/${enc(slug)}`;
  const nav = ws
    ? [
        { key: "pipeline", label: "Pipeline", kbd: "g p", href: defaultRound ? roundPath(defaultRound) : base },
        {
          key: "overview",
          label: "Overview",
          kbd: "g o",
          href: defaultRound ? `${roundPath(defaultRound)}/overview` : base,
        },
        { key: "investors", label: "Investors", kbd: "g i", href: `${base}/investors` },
        { key: "meetings", label: "Meetings", kbd: "g m", href: `${base}/meetings` },
        { key: "settings", label: "Settings", kbd: "g s", href: `${base}/settings` },
      ]
    : [];

  const onSignOut = useCallback(async () => {
    try {
      await signOut(api);
    } catch (err) {
      toast.show(errorMessage(err));
      return;
    }
    router.replace("/signin");
    router.refresh();
  }, [router, toast]);

  const onOpenSample = useCallback(async () => {
    const existing = session.workspaces.find((w) => w.is_sandbox);
    if (existing) {
      router.push(`/w/${enc(existing.slug)}`);
      return;
    }
    try {
      const created = await createWorkspace(api, { name: "Kestrel Robotics (sample)", sample: true });
      router.push(`/w/${enc(created.slug)}`);
      router.refresh();
    } catch (err) {
      toast.show(errorMessage(err));
    }
  }, [router, session.workspaces, toast]);

  // Due follow-ups per workspace, loaded when the switcher opens (at most once a minute).
  const loadDue = useCallback(() => {
    if (session.workspaces.length < 2 || Date.now() - dueLoaded.current < 60_000) return;
    dueLoaded.current = Date.now();
    for (const w of session.workspaces) {
      listFollowUps(api.ws(w.slug), { within_days: 0, include_overdue: true, limit: 1 })
        .then((r) => setDue((d) => ({ ...d, [w.slug]: r.counts.overdue + r.counts.today })))
        .catch(() => {});
    }
  }, [session.workspaces]);

  const canWrite = Boolean(wsCtx?.canWrite);
  const onNewRound = canWrite ? () => setNewRound(true) : undefined;

  return (
    <>
      <TopBar
        workspace={ws}
        workspaces={session.workspaces}
        rounds={rounds.map((r) => ({ slug: r.slug, name: r.name, status: r.status }))}
        activeRound={activeRound}
        roundHref={(slug) =>
          sub === "/overview" ? `${roundPath(slug)}/overview` : sub === "/settings" ? `${roundPath(slug)}/settings` : roundPath(slug)
        }
        onNewRound={onNewRound}
        nav={nav}
        menuExtras={
          ws && canWrite
            ? [{ label: "Import CSV", href: `${base}/import${activeRound ? `?round=${enc(activeRound)}` : ""}` }]
            : undefined
        }
        activeNav={activeNav}
        user={session.user}
        homeHref={ws ? (defaultRound ? roundPath(defaultRound) : base) : "/app"}
        workspaceHref={(slug) => (ws && slug === ws.slug ? pathname : (lastRouteFor(slug) ?? `/w/${enc(slug)}`))}
        workspaceHint={(slug) =>
          due[slug] ? <span className="text-bad">{due[slug]} due</span> : null
        }
        onWorkspaceMenu={() => {
          if (ws) rememberRoute(ws.slug);
          loadDue();
        }}
        newWorkspaceHref="/onboarding"
        onNewWorkspace={() => setNewWorkspace(true)}
        allWorkspacesHref="/app"
        onOpenSample={onOpenSample}
        accountHref="/account"
        onSignOut={onSignOut}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onEditName={needsName ? openName : undefined}
      />
      <AppKeyboard
        onNewRound={onNewRound}
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        shortcutsOpen={shortcutsOpen}
        setShortcutsOpen={setShortcutsOpen}
      />
      <NameDialog open={nameOpen} onClose={() => setNameOpen(false)} />
      <NewWorkspaceDialog open={newWorkspace} onClose={() => setNewWorkspace(false)} />
      {ws && wsCtx && canWrite ? (
        <NewRoundDialog
          open={newRound}
          onClose={() => setNewRound(false)}
          client={wsCtx.client}
          defaultCurrency={ws.default_currency}
          existingNames={rounds.map((r) => r.name)}
          onCreated={(r) => {
            setNewRound(false);
            router.push(roundPath(r.slug));
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
