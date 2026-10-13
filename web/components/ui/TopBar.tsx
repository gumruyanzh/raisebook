"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import type { Role } from "@/lib/api/types";
import { ROLE_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { comboLabel } from "@/lib/hotkeys";
import { applyThemePref, readThemePref, type ThemePref } from "@/lib/theme";

import { Chip } from "./Chip";
import { Menu, type MenuEntry } from "./Menu";
import { RoundPicker, type RoundPickerItem } from "./RoundPicker";
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
  /** Hotkey shown in the collapsed nav menu ("g p"). */
  kbd?: string;
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
  /** "+ Round" opens the new-round dialog in place (wins over `newRoundHref`). */
  onNewRound?: () => void;
  nav?: TopBarNavItem[];
  activeNav?: string | null;
  user: { name?: string | null; email: string };
  /** Wordmark target: the first open round. */
  homeHref: string;
  workspaceHref: (slug: string) => string;
  /** Right-aligned hint per workspace in the switcher ("3 due"). */
  workspaceHint?: (slug: string) => ReactNode;
  /** Called when the workspace menu opens (load due counts lazily). */
  onWorkspaceMenu?: () => void;
  newWorkspaceHref?: string;
  /** Opens the new-workspace dialog in place (wins over `newWorkspaceHref`). */
  onNewWorkspace?: () => void;
  /** "All companies" (the cross-workspace Today page), shown with two or more workspaces. */
  allWorkspacesHref?: string;
  onOpenSample?: () => void;
  accountHref?: string;
  onSignOut?: () => void;
  /** Opens the command palette (shows the "Search ⌘K" button). */
  onOpenPalette?: () => void;
  /** Opens the keyboard shortcuts sheet (an account menu item). */
  onOpenShortcuts?: () => void;
  /** The account has no display name: a dot on the avatar and "Add your name…" in the menu. */
  onEditName?: () => void;
  className?: string;
}

const NAV_LINK =
  "relative inline-flex h-56 items-center font-medium transition-colors duration-[120ms] whitespace-nowrap";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * The app bar (SYSTEM §4.1): 56px, canvas, 1px line under it, sticky. Left: wordmark,
 * workspace switcher (max 160px, truncated with a title), SANDBOX chip. Center: RoundPicker,
 * which collapses to a "Seed ▾" menu when it would crowd the nav (measured, not a fixed
 * breakpoint). Right: nav, search (⌘K), account menu (theme, shortcuts, sign out).
 * Under 900px the nav collapses into a "Menu" button and the RoundPicker moves to a second,
 * horizontally scrolling row.
 */
export function TopBar(p: TopBarProps) {
  const ws = p.workspace;
  // The stored theme is unknown until mounted, so server and client render the same markup.
  const [theme, setTheme] = useState<ThemePref | null>(null);
  useEffect(() => setTheme(readThemePref()), []);

  const wsItems: MenuEntry[] = [
    ...p.workspaces.map(
      (w, i): MenuEntry => ({
        label: w.name,
        textValue: w.name,
        href: p.workspaceHref(w.slug),
        hint: (
          <span className="flex items-center gap-8">
            {p.workspaceHint?.(w.slug)}
            {w.role && w.role !== "owner" ? <span>{ROLE_LABEL[w.role]}</span> : null}
            {i < 9 ? <span className="[@media(pointer:coarse)]:hidden">{comboLabel(`mod+${i + 1}`)}</span> : null}
          </span>
        ),
        selected: ws ? w.slug === ws.slug : false,
      }),
    ),
    ...(p.workspaces.length ? [{ type: "separator" } as MenuEntry] : []),
    ...(p.allWorkspacesHref && p.workspaces.length > 1
      ? [{ label: "All companies · Today", textValue: "All companies", href: p.allWorkspacesHref } as MenuEntry]
      : []),
    ...(p.onNewWorkspace
      ? [{ label: "New workspace…", textValue: "New workspace", onSelect: p.onNewWorkspace } as MenuEntry]
      : p.newWorkspaceHref
        ? [{ label: "New workspace", href: p.newWorkspaceHref } as MenuEntry]
        : []),
    ...(p.onOpenSample ? [{ label: "Open sample workspace", onSelect: p.onOpenSample } as MenuEntry] : []),
  ];
  const userName = p.user.name || p.user.email;
  const accountItems: MenuEntry[] = [
    { type: "label", label: <span className="normal-case tracking-normal">{p.user.email}</span> },
    ...(p.onEditName ? [{ label: "Add your name…", textValue: "Add your name", onSelect: p.onEditName } as MenuEntry] : []),
    ...(p.accountHref ? [{ label: "Account", href: p.accountHref } as MenuEntry] : []),
    ...(p.onOpenShortcuts ? [{ label: "Keyboard shortcuts", onSelect: p.onOpenShortcuts, hint: "?" } as MenuEntry] : []),
    { type: "separator" },
    { type: "label", label: "Theme" },
    ...THEMES.map(
      (t): MenuEntry => ({
        label: t.label,
        textValue: t.label,
        // menuitemradio + aria-checked once the stored choice is known.
        selected: theme === null ? false : theme === t.value,
        onSelect: () => {
          applyThemePref(t.value);
          setTheme(t.value);
        },
      }),
    ),
    ...(p.onSignOut ? [{ type: "separator" } as MenuEntry, { label: "Sign out", onSelect: p.onSignOut } as MenuEntry] : []),
  ];
  const nav = p.nav ?? [];
  const rounds = p.rounds ?? [];
  const hasPicker = Boolean(ws && p.roundHref && (rounds.length || p.newRoundHref || p.onNewRound));
  const pickerProps = hasPicker
    ? {
        rounds,
        active: p.activeRound,
        hrefFor: p.roundHref!,
        newRoundHref: p.newRoundHref,
        onNewRound: p.onNewRound,
      }
    : null;

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
        <span
          className="min-w-0 shrink"
          onPointerDownCapture={() => p.onWorkspaceMenu?.()}
          onKeyDownCapture={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") p.onWorkspaceMenu?.();
          }}
        >
          <Menu
            label="Workspaces"
            items={wsItems}
            minWidth={260}
            className="min-w-0 max-w-full"
            trigger={
              <>
                <span className="max-w-[160px] truncate" title={ws ? ws.name : undefined}>
                  {ws ? ws.name : "Workspaces"}
                </span>
                <span aria-hidden className="text-muted">
                  ▾
                </span>
              </>
            }
            triggerClassName="inline-flex h-32 min-w-0 max-w-full items-center gap-6 rounded-sm border border-transparent bg-transparent px-8 font-medium hover:border-line"
          />
        </span>
        {modeChips ? <span className="hidden shrink-0 gap-6 sm:inline-flex">{modeChips}</span> : null}

        {pickerProps ? (
          <RoundPicker {...pickerProps} collapse="auto" className="hidden lg:flex" />
        ) : (
          <span className="hidden flex-1 lg:block" />
        )}

        <div className="ml-auto flex shrink-0 items-center gap-14 2xl:gap-18">
          {nav.length ? (
            <nav aria-label="Workspace" className="hidden items-center gap-14 lg:flex 2xl:gap-18">
              {nav.map((n) => {
                const on = n.key === p.activeNav;
                return (
                  <Link
                    key={n.key}
                    href={n.href}
                    aria-current={on ? "page" : undefined}
                    title={n.kbd ? `${n.label} (${comboLabel(n.kbd)})` : undefined}
                    className={cn(NAV_LINK, on ? "text-fg" : "text-muted hover:text-fg")}
                  >
                    {n.label}
                    {on ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-2 bg-accent" /> : null}
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
              items={[
                ...nav.map(
                  (n): MenuEntry => ({
                    label: n.label,
                    href: n.href,
                    selected: n.key === p.activeNav,
                    hint: n.kbd ? <span className="[@media(pointer:coarse)]:hidden">{comboLabel(n.kbd)}</span> : undefined,
                  }),
                ),
                ...(p.onOpenPalette
                  ? [
                      { type: "separator" } as MenuEntry,
                      { label: "Search…", textValue: "Search", onSelect: p.onOpenPalette, hint: comboLabel("mod+k") } as MenuEntry,
                    ]
                  : []),
              ]}
            />
          ) : null}
          {p.onOpenPalette ? (
            <button
              type="button"
              onClick={p.onOpenPalette}
              aria-label="Search and commands"
              aria-keyshortcuts="Meta+K Control+K"
              className="hidden h-32 items-center gap-8 rounded-sm border border-line bg-surface px-8 text-muted transition-colors duration-[120ms] hover:border-muted hover:text-fg sm:inline-flex"
            >
              {/* Never a bare "⌘K": a glass always, the word from 1024px (critique 2). */}
              <svg aria-hidden viewBox="0 0 16 16" className="size-14 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="7" cy="7" r="4.5" />
                <path d="m10.5 10.5 3.5 3.5" strokeLinecap="round" />
              </svg>
              <span className="hidden xl:[@media(pointer:fine)]:inline">Search</span>
              <kbd className="inline-flex h-18 items-center rounded-kbd border border-line px-4 font-mono text-xs leading-none text-muted [@media(pointer:coarse)]:hidden">
                {comboLabel("mod+k")}
              </kbd>
              <span className="[@media(pointer:fine)]:hidden">Search</span>
            </button>
          ) : null}
          <Menu
            label="Account"
            align="end"
            items={accountItems}
            minWidth={220}
            trigger={
              <span
                aria-label={`Account: ${userName}${p.onEditName ? " (add your name)" : ""}`}
                className="relative inline-flex size-28 items-center justify-center rounded-pill bg-sunk font-mono text-xs font-medium text-fg"
              >
                {initials(userName)}
                {p.onEditName ? (
                  <span aria-hidden className="absolute -top-1 -right-1 size-9 rounded-pill border-2 border-canvas bg-accent" />
                ) : null}
              </span>
            }
            triggerClassName="rounded-pill border-0 bg-transparent p-0"
          />
        </div>
      </div>
      {pickerProps || modeChips ? (
        <div className="gutter flex items-center gap-8 pb-8 lg:hidden">
          {modeChips ? <span className="flex shrink-0 gap-6 sm:hidden">{modeChips}</span> : null}
          {pickerProps ? (
            <div className="min-w-0 overflow-x-auto scrollbar-none">
              <RoundPicker {...pickerProps} collapse="never" />
            </div>
          ) : null}
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
