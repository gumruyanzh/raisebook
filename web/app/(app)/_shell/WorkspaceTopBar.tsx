"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import { TopBar, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { createWorkspace, signOut } from "@/lib/api/core";
import { useOptionalWorkspace, useSession } from "@/lib/session";

const enc = encodeURIComponent;

/**
 * Route-aware TopBar for the signed-in app. Works inside a workspace (rounds, nav) and outside
 * one (/account). Contract for "+ Round": it links to
 * `/w/<ws>/settings?new_round=1`, which the settings page uses to open the new-round dialog.
 */
export function WorkspaceTopBar() {
  const session = useSession();
  const wsCtx = useOptionalWorkspace();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const toast = useToast();

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
  else if (ws && pathname.startsWith(`${base}/settings`)) activeNav = "settings";

  const roundPath = (slug: string) => `${base}/r/${enc(slug)}`;
  const nav = ws
    ? [
        { key: "pipeline", label: "Pipeline", href: defaultRound ? roundPath(defaultRound) : base },
        {
          key: "overview",
          label: "Overview",
          href: defaultRound ? `${roundPath(defaultRound)}/overview` : base,
        },
        { key: "investors", label: "Investors", href: `${base}/investors` },
        { key: "settings", label: "Settings", href: `${base}/settings` },
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

  return (
    <TopBar
      workspace={ws}
      workspaces={session.workspaces}
      rounds={rounds.map((r) => ({ slug: r.slug, name: r.name, status: r.status }))}
      activeRound={activeRound}
      roundHref={(slug) => (sub === "/overview" ? `${roundPath(slug)}/overview` : roundPath(slug))}
      newRoundHref={wsCtx?.canWrite ? `${base}/settings?new_round=1` : undefined}
      nav={nav}
      activeNav={activeNav}
      user={session.user}
      homeHref={ws ? (defaultRound ? roundPath(defaultRound) : base) : "/app"}
      workspaceHref={(slug) => `/w/${enc(slug)}`}
      newWorkspaceHref="/onboarding"
      onOpenSample={onOpenSample}
      accountHref="/account"
      onSignOut={onSignOut}
    />
  );
}
