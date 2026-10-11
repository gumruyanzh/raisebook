"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { Role } from "@/lib/api/types";
import { ROLE_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { applyThemePref } from "@/lib/theme";

import { Chip } from "./Chip";
import { Menu, type MenuEntry } from "./Menu";
import { RoundPicker, type RoundPickerItem } from "./RoundPicker";
import { ThemeToggle } from "./ThemeToggle";
import { Wordmark } from "./Wordmark";

export interface TopBarWorkspace {
  slug: string;
  name: string;
  is_sandbox: boolean;
  role?: Role | null;
}

export interface TopBarNavItem {
  key: string;
  label: string;
  href: string;
}

export interface TopBarProps {
  /** Current workspace; omit on pages outside a workspace (/account). */
  workspace?: TopBarWorkspace | null;
  workspaces: TopBarWorkspace[];
  rounds?: RoundPickerItem[];
  activeRound?: string | null;
  roundHref?: (slug: string) => string;
  /** "+ Round" link (editors and owners). */
  newRoundHref?: string;
  nav?: TopBarNavItem[];
  activeNav?: string | null;
  user: { name?: string | null; email: string };
  /** Wordmark target: the first open round. */
  homeHref: string;
  workspaceHref: (slug: string) => string;
  newWorkspaceHref?: string;
  onOpenSample?: () => void;
  accountHref?: string;
  onSignOut?: () => void;
  className?: string;
}

const NAV_LINK =
  "relative inline-flex h-56 items-center font-medium transition-colors duration-[120ms] whitespace-nowrap";

/**
 * The app bar (SYSTEM §4.1): 56px, canvas, 1px line under it, sticky. Left: wordmark,
 * workspace switcher, SANDBOX chip. Center: RoundPicker. Right: nav, theme, account menu.
 * Under 900px the nav collapses into a "Menu" button and the RoundPicker moves to a second,
 * horizontally scrolling row.
 */
export function TopBar(p: TopBarProps) {
  const ws = p.workspace;
  const wsItems: MenuEntry[] = [
    ...p.workspaces.map(
      (w): MenuEntry => ({
        label: w.name,
        href: p.workspaceHref(w.slug),
        hint: w.role ? ROLE_LABEL[w.role] : undefined,
        selected: ws ? w.slug === ws.slug : false,
      }),
    ),
    ...(p.workspaces.length ? [{ type: "separator" } as MenuEntry] : []),
    ...(p.newWorkspaceHref ? [{ label: "New workspace", href: p.newWorkspaceHref } as MenuEntry] : []),
    ...(p.onOpenSample ? [{ label: "Open sample workspace", onSelect: p.onOpenSample } as MenuEntry] : []),
  ];
  const userName = p.user.name || p.user.email;
  const accountItems: MenuEntry[] = [
    { type: "label", label: p.user.email },
    ...(p.accountHref ? [{ label: "Account", href: p.accountHref } as MenuEntry] : []),
    { type: "separator" },
    { type: "label", label: "Theme" },
    { label: "Light", onSelect: () => applyThemePref("light") },
    { label: "Dark", onSelect: () => applyThemePref("dark") },
    { label: "System", onSelect: () => applyThemePref("system") },
    ...(p.onSignOut ? [{ type: "separator" } as MenuEntry, { label: "Sign out", onSelect: p.onSignOut } as MenuEntry] : []),
  ];
  const nav = p.nav ?? [];
  const rounds = p.rounds ?? [];
  const picker =
    ws && p.roundHref && (rounds.length || p.newRoundHref) ? (
      <RoundPicker
        rounds={rounds}
        active={p.activeRound}
        hrefFor={p.roundHref}
        newRoundHref={p.newRoundHref}
      />
    ) : null;

  // SANDBOX (fictional data, rb_test_ keys) and VIEW ONLY (viewer role) stay visible at every
  // width: beside the workspace name from 640px, on the second row on phones.
  const modeChips =
    ws && (ws.is_sandbox || ws.role === "viewer") ? (
      <>
        {ws.is_sandbox ? (
          <Chip tone="mode" title="Sample workspace with fictional data">
            Sandbox
          </Chip>
        ) : null}
        {ws.role === "viewer" ? (
          <Chip tone="mode" title="You can read everything here but not change it">
            View only
          </Chip>
        ) : null}
      </>
    ) : null;

  return (
    <header className={cn("sticky top-0 z-30 border-b border-line bg-canvas", p.className)}>
      <div className="gutter mx-auto flex h-56 max-w-app items-center gap-10 sm:gap-14">
        <Wordmark href={p.homeHref} className="shrink-0" />
        <Menu
          label="Workspaces"
          items={wsItems}
          minWidth={240}
          className="min-w-0 shrink"
          trigger={
            <>
              <span className="max-w-[22ch] truncate">{ws ? ws.name : "Workspaces"}</span>
              <span aria-hidden className="text-muted">
                ▾
              </span>
            </>
          }
          triggerClassName="inline-flex h-32 min-w-0 max-w-full items-center gap-6 rounded-sm border border-transparent bg-transparent px-8 font-medium hover:border-line"
        />
        {modeChips ? <span className="hidden shrink-0 gap-6 sm:inline-flex">{modeChips}</span> : null}

        {picker ? (
          <div className="hidden min-w-0 flex-1 overflow-x-auto scrollbar-none lg:flex">{picker}</div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-18">
          {nav.length ? (
            <nav aria-label="Workspace" className="hidden items-center gap-18 lg:flex">
              {nav.map((n) => {
                const on = n.key === p.activeNav;
                return (
                  <Link
                    key={n.key}
                    href={n.href}
                    aria-current={on ? "page" : undefined}
                    className={cn(NAV_LINK, on ? "text-fg" : "text-muted hover:text-fg")}
                  >
                    {n.label}
                    {on ? (
                      <span aria-hidden className="absolute inset-x-0 bottom-0 h-2 bg-accent" />
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          ) : null}
          {nav.length ? (
            <Menu
              label="Navigation"
              align="end"
              className="lg:hidden"
              trigger="Menu"
              triggerClassName="inline-flex h-32 items-center rounded-sm border border-line bg-surface px-10 font-medium"
              items={nav.map((n) => ({ label: n.label, href: n.href, selected: n.key === p.activeNav }))}
            />
          ) : null}
          <span className="hidden xl:flex">
            <ThemeToggle />
          </span>
          <Menu
            label="Account"
            align="end"
            items={accountItems}
            trigger={
              <span
                aria-label={`Account: ${userName}`}
                className="inline-flex size-28 items-center justify-center rounded-pill bg-sunk font-mono text-xs font-medium text-fg"
              >
                {initials(userName)}
              </span>
            }
            triggerClassName="rounded-pill border-0 bg-transparent p-0"
          />
        </div>
      </div>
      {picker || modeChips ? (
        <div className="gutter flex items-center gap-8 pb-8 lg:hidden">
          {modeChips ? <span className="flex shrink-0 gap-6 sm:hidden">{modeChips}</span> : null}
          {picker ? <div className="min-w-0 overflow-x-auto scrollbar-none">{picker}</div> : null}
        </div>
      ) : null}
    </header>
  );
}

/** App frame: TopBar + main content column (max 1600, 16/24px gutter, 14px rhythm). */
export function AppShell({
  topBar,
  children,
  className,
}: {
  topBar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      {topBar}
      <main id="main" className={cn("gutter mx-auto w-full max-w-app pt-16 pb-40", className)}>
        {children}
      </main>
    </>
  );
}
