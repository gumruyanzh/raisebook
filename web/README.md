# Raisebook web

Next.js 15 (App Router) + React 19 + Tailwind v4, TypeScript strict, no component library.
Binding specs: `../docs/SPEC.md`, `../design/SYSTEM.md`, `../docs/OWNERSHIP.md`.

```bash
npm ci
npm run dev                  # http://localhost:3000, needs the API on :8000
npm run lint && npm run typecheck && npm run build
```

Without a running API, `RAISEBOOK_WEB_AUTH_BYPASS=1 npm run dev` renders the signed-in shell
with a fictional session (dev only; ignored in production). The component inventory is at
`/design` (alias `/kit`), always on in dev and in a production build only with
`NEXT_PUBLIC_ENABLE_DESIGN=1`. Environment variables: `.env.example`.

## Layout

| Path | What |
|---|---|
| `app/globals.css` | Every token from SYSTEM §1, light + dark, mapped into Tailwind with `@theme`. Tailwind's default palette, radii, shadows and fonts are removed. |
| `app/fonts.ts` | Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono through `next/font` (self-hosted, no runtime Google requests). |
| `components/ui/*` | The UI kit (SYSTEM §3). Presentational, props in, no fetching. Import from `@/components/ui`. |
| `lib/api/client.ts` | `createApiClient`, `api` (browser), `ApiError`, CSRF and `X-Workspace` handling. |
| `lib/api/server.ts` | `serverApi(ws?)` (forwards cookies), `getSession()` (cached per request), `authBypass()`. Server only. |
| `lib/api/types.ts` | SPEC §5.3 shapes and the §3.8 label maps. |
| `lib/api/core.ts` | Auth, session, me, workspaces, invite lookup/accept, `listRounds`. Re-exports the types. |
| `lib/session.ts` | `SessionProvider`/`useSession`, `WorkspaceProvider`/`useWorkspace`, `rb-last-ws`. |
| `lib/format.ts` | `money`, `moneyCompact`, dates, relative time, follow-up state, priority. |
| `middleware.ts` | Sends signed-out visitors on `/w/*`, `/app`, `/account`, `/onboarding` to `/signin?next=`. |
| `app/(app)/_shell/*` | Route-aware `WorkspaceTopBar`, the `/app` last-workspace redirect. |
| `app/_stub/Stub.tsx` | Placeholder used by Phase 3 route stubs. Delete when nothing imports it. |

## Conventions

- **Spacing unit is 1px**: `p-14` is 14px, `gap-6` is 6px, `h-32` is 32px. Use the values in
  SYSTEM §1.5.
- **Colors are tokens only**: `bg-canvas`, `bg-surface`, `bg-sunk`, `border-line`, `text-fg`,
  `text-muted`, `text-faint` (never meaningful text), `bg-accent`/`text-accent`, `*-soft`,
  `text-hot|warm|maybe|good|bad`, `text-agent`/`bg-agent-soft` (agents only),
  `bg-stage-<color>` (dots, funnel and column rules only). No hex values outside `globals.css`.
- **Radii**: `rounded-xs` 2, `rounded-kbd` 4, `rounded-sm` 6, `rounded-card` 7, `rounded-md` 8,
  `rounded-pill`. Nothing rounder than 8 except pills.
- **Type roles** are utilities: `t-display-xl|l|m|s|xs`, `t-amount`, `t-body-l`, `t-body`,
  `t-body-s`, `t-chip`, `t-label`, `t-th`, `t-data`, `t-micro`; fonts `font-display`,
  `font-body`, `font-mono`; `tnum` for tabular figures.
- **Breakpoints**: `sm` 640, `md` 860 (ledger stacks), `lg` 900 (top bar collapses), `xl` 1024
  (24px gutter), `2xl` 1280. Containers: `max-w-app` 1600, `max-w-site` 1120, `max-w-read` 680,
  `max-w-auth` 400, `max-w-flow` 560. `gutter` = 16px, 24px from 1024px.
- **API calls**: every `/v1` call goes through `lib/api/*`. Feature modules export functions
  that take a client first: `listRounds(c, "open")`. Client components use
  `useWorkspace().client` (sends `X-Workspace`); server components use
  `await serverApi(slug)`. Errors are `ApiError` with `code`, `message`, `details`,
  `requestId`, and `fieldErrors` for 422s. Show `message` plus the `code` in mono.
- After a write that changes the round list (create, rename, close), call `router.refresh()`
  so the workspace layout reloads the TopBar's rounds.
- "+ Round" in the TopBar links to `/w/<ws>/settings?new_round=1`; the settings page opens the
  new-round dialog when it sees that parameter.
- No third-party scripts, fonts, analytics or iframes. Only fictional data in samples.
