# Raisebook design system: "The Desk"

This is the binding visual spec for every screen in `web/`. It is derived from
`prototype.html` (repo root), which is the reference for density, color and type. If a screen
needs something this file does not cover, build it from the primitives in `web/components/ui/`
and the rules below. Do not invent a new visual idea, and do not import a component library.

---

## 0. The idea in one paragraph

Raisebook is a **fundraising desk**. A ledger strip at the top says where the round stands
(money committed against the target, the funnel, who to follow up with today). Below it sits
the working surface: a pipeline board or a dense table. Each investor's file opens in a side
sheet. The look is a well-made instrument: cool slate neutrals, one cobalt accent for
interaction, one color per stage, tabular numbers, mono labels, and a grotesque display face
for the few large numbers and titles. Agents are colleagues at the desk, and everything they
do is marked in their own color (orchid), so a founder can see at a glance what was done for
them.

---

## 1. Tokens

All colors are CSS variables on `:root` in `web/app/globals.css`, redefined for dark mode
under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and again under
`:root[data-theme="dark"]`, exactly as the prototype does. Tailwind v4 maps them through
`@theme` after `--color-*: initial;`, so **Tailwind's default palette does not exist**.
`bg-gray-100`, `text-blue-500`, `bg-white` and the like must not appear.

### 1.1 Color: neutrals and accent

| Token (utility suffix) | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F3F5F8` | `#0F141C` | Page background (`--bg` in the prototype). |
| `surface` | `#FFFFFF` | `#171E29` | Ledger, table, cards, sheet, dialog, inputs on canvas. |
| `sunk` | `#E8ECF2` | `#1D2532` | Board columns, meter tracks, segmented-control track, inline code. |
| `line` | `#D5DCE6` | `#2A3444` | Every 1px border and row rule. |
| `fg` | `#16202E` | `#E6EBF2` | Primary text; "ink" fills (active segmented button, toast). |
| `muted` | `#5B6778` | `#9AA6B8` | Secondary text, labels, metadata. Passes 4.5:1 on canvas, surface and sunk. |
| `faint` | `#8994A5` | `#6E7A8C` | **Not for meaningful text** (about 3:1). Placeholders, disabled, decorative dots, empty fit pips. |
| `accent` | `#2F55D4` | `#7C9BFF` | Cobalt: links, the primary button, focus ring, selected state, drop target. |
| `accent-ink` | `#FFFFFF` | `#0F141C` | Text on an accent fill. |
| `accent-soft` | `#E3E9FB` | `#1F2A4A` | Row hover, type chip, selected row. |

### 1.2 Color: meaning

| Token | Light | Dark | Use |
|---|---|---|---|
| `hot` / `hot-soft` | `#C2410C` / `#FDE7DB` | `#FF8A5B` / `#3A2218` | Priority chip "Hot" (fit 5). |
| `warm` / `warm-soft` | `#B7791F` / `#FBF0D5` | `#F0B54E` / `#33291A` | Priority "Warm" (fit 4); follow-up "soon" chip. |
| `maybe` / `maybe-soft` | `#6B7A8F` / `#E9EDF2` | `#A3AFC0` / `#232B38` | Priority "Maybe" (fit 3). |
| `good` / `good-soft` | `#15803D` / `#DCF3E3` | `#4ADE80` / `#15301F` | Committed money, meter fill, fit pips, "Saved". |
| `bad` / `bad-soft` | `#B42318` / `#FBE1DE` | `#F87171` / `#3A1C1C` | Overdue follow-up, errors, destructive buttons. |
| `agent` / `agent-soft` | `#A1307A` / `#F8E4F0` | `#F08BC8` / `#3A1E31` | **Orchid = an agent did this.** Agent names, agent timeline nodes, agent-made rows (a 2px left rule), the agent marker glyph. Text, rules and soft tints only; never a button fill. |

**Color grammar**
1. **Cobalt is "you can act here"** (links, the primary button, focus, selection). It is never
   used for status.
2. **Orchid is "an agent did this"** and is used for nothing else. No stage, chip or
   button may be orchid. (That is why the stage palette has no rose or magenta.)
3. **Green is money that is real**: committed amounts, the meter, fit pips. Never use it for
   generic "success" decoration.
4. **Red means a person must act now or something failed**: overdue follow-ups, errors, the
   delete confirmation. At most one solid red element per view (the destructive confirm
   button).
5. **No other hues** beyond the stage palette. No gradients, glows, glass or blur.

### 1.3 Color: stage palette

Each round stage stores one of these names (`round_stages.color`). CSS: `--stage-<name>`,
utilities `bg-stage-<name>` and `text-stage-<name>`. Stage colors appear as a 9px dot,
funnel-bar segments and the 3px top rule of a board column header. **Never** as chip
backgrounds or card fills.

| Name | Light | Dark | Default stage |
|---|---|---|---|
| `slate` | `#8994A5` | `#8C98AA` | New |
| `violet` | `#7C5CD6` | `#A78BFA` | Researching |
| `cobalt` | `#2F55D4` | `#7C9BFF` | Contacted |
| `teal` | `#0E8A9E` | `#38C6DA` | Replied |
| `amber` | `#B7791F` | `#F0B54E` | Meeting |
| `orange` | `#C2410C` | `#FF8A5B` | Diligence |
| `green` | `#15803D` | `#4ADE80` | Committed |
| `gray` | `#9AA3B0` | `#5E6878` | Passed |
| `olive` | `#65731A` | `#B5C752` | (custom) |
| `sky` | `#0369A1` | `#56B6F0` | (custom) |

Text on a funnel segment is white in light mode and `canvas` in dark mode, and only appears
when the segment is wider than 6% (as in the prototype).

### 1.4 Typography

Load all three through `next/font/google` (self-hosted at build time, so there are no runtime
requests to Google). CSS variables: `--f-display`, `--f-body`, `--f-mono`.

| Role | Family | Weights |
|---|---|---|
| Display | **Bricolage Grotesque** (opsz 12..96) | 500, 700 |
| Body / UI | **IBM Plex Sans** | 400, 500, 600 |
| Data / labels | **IBM Plex Mono** | 400, 500 |

Scale (size / line-height / tracking):

| Token | Spec | Use |
|---|---|---|
| `display-xl` | Bricolage 700, 56/1.02, -0.025em (40 under 640px) | Landing hero only |
| `display-l` | Bricolage 700, 36/1.08, -0.02em (28 under 640px) | Landing section heads, docs H1 |
| `display-m` | Bricolage 700, 28/1.1, -0.02em | Wordmark, page titles |
| `amount` | Bricolage 700, 30/1.1, tabular-nums | Ledger committed amount (the "of $X" part: 500, 18px, muted) |
| `display-s` | Bricolage 700, 22/1.15, `text-wrap: balance` | Sheet and dialog titles, investor page name |
| `display-xs` | Bricolage 700, 18/1.2 | Empty-state title, settings section titles |
| `body-l` | Plex Sans 400, 16/1.6 | Marketing and docs body (max 68ch) |
| `body` | Plex Sans 400, 14/1.45 | App default |
| `body-s` | Plex Sans 400, 12.5/1.4 | Card firm line, secondary rows, timeline |
| `chip` | Plex Sans 500, 11.5/1.6 | Chips |
| `label` | Plex Mono 500, 11/1.3, uppercase, 0.08em | Section labels ("PIPELINE", "STAGE FOR SEED"), table heads (0.06em) |
| `data` | Plex Mono 400, 12.5, tabular-nums | Numbers in tables, dates, ids, key prefixes |
| `micro` | Plex Mono 400, 11.5 | Timestamps, counts ("48 of 212 investors") |

Rules: all numbers in tables, meters, the ledger and chips use `font-variant-numeric:
tabular-nums`. Display type is used only for the sizes above. It never sets body copy or
buttons. Sentence case everywhere except mono labels. Body text weight is never under 400.

### 1.5 Spacing and layout grid
- Base unit 2px. The scale used: 2, 4, 6, 8, 10, 12, 14, 16, 18, 24, 32, 48, 64, 96.
- Page gutter: 16px on phones, 24px from 1024px. The app content max-width is 1600px. Marketing
  content is 1120px, with a 680px text measure for docs.
- App vertical rhythm: 14px between stacked blocks (ledger → toolbar → board), as in the
  prototype.
- Controls: 32px height (sm 28, lg 40). Board card padding 9/10px. Table cell padding 8/10px.

### 1.6 Radii, borders, elevation
- `--r-xs` 2px: fit pips. `--r-sm` 6px: inputs, buttons, link buttons, the funnel bar, close
  button. `--r` 8px: ledger, table wrapper, board column, dialog, toast, empty state.
  `--r-card` 7px: board cards. `--r-pill` 999px: chips, segmented round picker, stage buttons,
  meter.
- **Nothing is rounder than 8px except pills.** No `rounded-xl`/`2xl`.
- Borders are 1px `line`. A surface is either bordered or sunk, never both. **No nested
  bordered boxes**: a card inside a column is fine (the column is sunk, not bordered), but a
  bordered card inside a bordered card is not.
- Elevation exists only where something floats: the dragged card (`0 6px 16px rgb(0 0 0 / .12)`),
  menus (`0 8px 24px rgb(10 15 25 / .14)`), the dialog (`0 20px 50px rgb(10 15 25 / .25)`) and
  the active round-picker pill (`0 1px 2px rgb(0 0 0 / .08)`). The sheet uses a left border
  plus a scrim (`rgb(10 15 25 / .35)`), not a shadow. Static cards have no shadow.
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`. No ring
  halos.

### 1.7 Motion
- Color and border changes: 120ms ease-out. The meter width: 400ms. Sheet: slides in from the
  right over 180ms with `cubic-bezier(.2,.8,.2,1)`, and the scrim fades in. Toast: fades in
  over 150ms.
- Board drop: the card lands without bouncing. The column count updates immediately.
- `prefers-reduced-motion: reduce` disables all transitions.
- No skeleton shimmer, no spinners longer than 300ms without text ("Loading pipeline…").

---

## 2. Status vocabulary

### 2.1 Stages
A stage is always shown as **dot + label**: `<StageDot color/>` followed by the label in
`body-s`. In tables, this is the "stage pill" (no background). In the sheet, the stage
selector is a row of pill buttons (1px `line` border, and the active one is filled with `fg`
and has `canvas` text), as in the prototype. Stage *kind* is never shown with a word in the
UI. It shows up through position and through the ledger math.

### 2.2 Priority (from fit)
| fit | Chip | Classes |
|---|---|---|
| 5 | Hot | `hot-soft` bg, `hot` text |
| 4 | Warm | `warm-soft` / `warm` |
| 3 | Maybe | `maybe-soft` / `maybe` |
| 0–2 | Low fit | `sunk` bg, `muted` text (not `faint`; it must stay readable) |

The FitMeter (five 6×10px pips, filled in `good`) always sits next to the priority chip in
tables and cards, so the number is visible as well.

### 2.3 Follow-up state
| State | Render |
|---|---|
| overdue | chip `bad-soft`/`bad`: "Follow up overdue" (card), or the date in the table |
| today | chip `bad-soft`/`bad`: "Follow up today" |
| soon (≤7 days) | chip `warm-soft`/`warm`: "Follow up Oct 14" |
| later | plain `data` date in muted |
| none | nothing (the table cell is empty) |

### 2.4 Chips
Chips are pills with `chip` type and a 1px transparent border. Variants: `priority` (§2.2),
`type` (`accent-soft`/`accent`: VC, Angel…), `tag` and `industry` (`sunk`/`muted`), `due` and
`soon` (§2.3), `money` (`good-soft`/`good`, mono amount: "$250k"), `agent` (`agent-soft`/
`agent`, used only for "by claude-code" badges), `mode` (outlined, mono: SANDBOX, TEST). There
are at most four chips on a board card. Extra tags collapse to "+3".

### 2.5 Actor rendering
| Actor | Render |
|---|---|
| agent | Agent marker glyph (a 7px orchid diamond, CSS-drawn) + name in `agent` 500 + model in `agent` at 75% opacity in mono ("claude-code · claude-opus-4-5") |
| user | Name in `fg` 500 (the role appears only in member lists) |
| system | "Raisebook" in `muted` |

Timeline entries by agents get a 2px `agent` left rule and an `agent-soft` tint at 50%. Board
cards changed by an agent in the last 24 hours show the diamond marker in the top-right
corner, with a tooltip "Moved by claude-code 2h ago". Always write the actor, never "the AI".

### 2.6 Money
- Ledger and dashboard: full amounts, `$2,000,000`. Cards and chips: compact, `$250k`,
  `$1.5M`. Tables: compact, with the exact value in the `title` attribute. The currency symbol
  comes from the round currency through `Intl.NumberFormat` (USD → `$`, EUR → `€`). Use
  `lib/format.ts` (`money`, `moneyCompact`) everywhere.
- Dates: UI `Oct 14` (adding the year when it is not the current year). In data contexts
  (mono), ISO `2026-10-14`. Relative times only in the timeline ("2h ago"), with an absolute
  `title`.

---

## 3. Components (`web/components/ui/`)

Import from `@/components/ui`. Every component accepts `className`, is themed only through
tokens, and works with the keyboard. The live inventory is `/design` (dev only, or
`NEXT_PUBLIC_ENABLE_DESIGN=1`), which renders every component in light and dark.

| # | Component | Spec |
|---|---|---|
| 3.1 | `Button`, `ButtonLink` | Variants: `primary` (accent fill, accent-ink text; **one per view**: the main action, e.g. "Add investor"), `secondary` (surface, 1px line, fg text; the default), `ghost` (no border, muted text, hover sunk), `danger` (bad fill, white text; only in confirm dialogs), `danger-quiet` (bad text, line border; "Delete workspace…" entry points). Sizes `sm` 28, `md` 32, `lg` 40. Radius 6. Optional `kbd` hint on the right (`Kbd`). Loading state: the label changes ("Saving…"), the width stays fixed, no spinner. |
| 3.2 | `Input`, `Textarea`, `Select`, `Field` | 1px line, radius 6, `canvas` bg inside sheets and forms (as in the prototype), `surface` bg in toolbars. Focus: the accent outline. `Field` = a label (12px muted, above) + control + hint (muted) or error (bad, with the API `error.code` in mono). Select is native `<select>` with a custom chevron (CSS). Textarea min-height 96, vertical resize. Search input: type=search, flex 1 1 220px. |
| 3.3 | `Segmented` | The prototype `.seg`: 1px line box, the active item filled `fg` with `canvas` text. Used for Board/Table and the activity kind picker. `role="group"` + `aria-pressed`. |
| 3.4 | `RoundPicker` | The prototype `.round-pick`: a `sunk` pill track with surface-pill active items, plus a "+ Round" ghost item at the end (opens the new-round dialog, for editors). It overflows into a menu after 4 rounds. Closed rounds show at 60% opacity and are listed last. |
| 3.5 | `Chip` | §2.4. Props `tone`, `size` (sm 11.5px is the default). Never interactive unless rendered as a `<button>` (the due strip), and then it gets the hover underline. |
| 3.6 | `StageDot` | A 9px circle, `bg-stage-<color>`, `aria-hidden`. Always next to a text label. |
| 3.7 | `FitMeter` | Five 6×10px pips (radius 2), filled `good`, empty `line`, with an optional "4/5" mono label. Read-only by default. `editable` turns it into a radio group of six (0–5), where the arrow keys change the value. |
| 3.8 | `Meter` | Ledger meter: an 8px `sunk` pill track with a `good` fill (width animated). Props `value`, `max`, `label`. Over 100%: the fill is full and a mono "112% of target" appears in `good`. |
| 3.9 | `FunnelBar` | The prototype funnel: a 26px bar of stage-colored flex segments (radius 6 on the container), with a legend row under it (dot, label, bold count). Every segment and legend item is a button that filters the pipeline by stage. Zero-count stages appear only in the legend. |
| 3.10 | `Ledger` | The round summary strip. Grid `1.2fr / 2fr` (stacked under 860px). Left: mono label "COMMITTED TOWARD SEED", `amount` "$750,000 of $2,000,000", Meter, a sub-row of stats (`b` tabular): "18 in conversation · 4 committed · $400k soft · 41 days to close". Right: label "PIPELINE", FunnelBar, a due strip ("Follow up now:" + up to 8 due chips + "+3 more"). Compact variant on the pipeline page. Full variant on the overview. |
| 3.11 | `Table` (`Table`, `THead`, `TBody`, `Tr`, `Th`, `Td`, `TableScroll`) | The prototype table: a surface with 1px line and radius 8, `min-width` per use, sticky `Th` with `label` type, `aria-sort` + "↑/↓" on the sorted column, 1px row rules, row hover `accent-soft`, clickable rows (Enter opens). `Td variant="num"` = mono tabular 12.5. Selection checkbox column optional. `TableScroll` handles horizontal overflow on phones. |
| 3.12 | `BoardColumn` | A `sunk` column with radius 8 and a 3px top rule in the stage color, sticky header (StageDot, label 600 13px, mono count right, and for the won stage the column total, "$750k", in good). The body scrolls (max-height 78vh). Empty: muted "Drag investors here" (or "Nothing here yet" for viewers). "Show 60 more" link button after 60 cards. Drop target: 2px dashed accent outline at -2px. |
| 3.13 | `BoardCard` | A `<button>` surface with 1px line and radius 7, padding 9/10, gap 5. Row 1: name (600, ellipsis) + agent marker if recent. Row 2: "Title · Firm" (body-s, muted, ellipsis). Row 3: chips (priority, type, first industry) + FitMeter. Optional: due chip, money chip (won stage or soft amount), next-step line (body-s muted, one line). Hover: accent border. Dragging: 50% opacity on the source, shadow on the ghost. Keyboard: §4.3. |
| 3.14 | `Sheet` | A right-side panel, `min(520px, 100%)` wide, full height, surface, 1px left line, scrim. Header: `display-s` title, muted subline, chips, close button (32px square, 1px line, radius 6, "✕"). The body scrolls with 16px section gaps. Esc and the scrim close it. Focus is trapped while open, moves to the close button on open, and returns to the invoking card on close. Respects safe-area insets. |
| 3.15 | `Dialog`, `ConfirmDialog` | Native `<dialog>`: surface, radius 8, dialog shadow, max-width 480. Title `display-s`, body, actions right-aligned (secondary then primary). `ConfirmDialog` with `typed` asks the user to type the slug or name to enable the `danger` button ("Delete workspace permanently"). |
| 3.16 | `Toast` (`ToastProvider`, `useToast`) | The prototype toast: an `fg` box with `canvas` text, radius 8, centered bottom with safe-area offset. One line, plus an optional action ("Undo" for stage moves within 6s). Auto-dismisses after 4s, or 8s with an action. `role="status"`. |
| 3.17 | `EmptyState` | A surface with a 1px **dashed** line and radius 8, padding 28, centered. Title `display-xs`, one sentence in muted, then the action button(s). Copy rules in §6. |
| 3.18 | `Timeline` | A vertical list: each item has a mono time (11.5, muted, fixed 64px column), the actor (§2.5), the action sentence, and an optional body (pre-wrap, 65ch). Day separators use a `label` style ("TODAY", "OCT 9"). Agent items get the orchid rule and tint. Filters: Segmented All / Conversations / Stage & money / Agent actions. |
| 3.19 | `ActorName` | §2.5. |
| 3.20 | `CodeBlock` | Always dark (`#0F141C` bg, `#E6EBF2` text) in both themes, radius 8, Plex Mono 12.5. Optional tabs (Claude Code · Codex · Cursor · Other), a copy button ("Copy" → "Copied"), and minimal highlighting for shell/JSON/TOML (strings in `#9FD3A6`, keys in `#7C9BFF`). |
| 3.21 | `SecretReveal` | The copy-once API key panel: `warm-soft` background, 1px warm border, mono secret in a read-only input, a Copy button, and the line "This is the only time you'll see this key. Store it in your agent's config or a password manager." The secret is never rendered again after this panel closes. |
| 3.22 | `Tabs` | Underline tabs: a 2px `fg` underline on the active tab, muted inactive, `role="tablist"`. Used for Pipeline / Overview / Settings sections on the round, and the docs client tabs. |
| 3.23 | `Menu` | A popover list (surface, 1px line, radius 8, menu shadow). Keyboard: arrow keys, Enter, Esc, typeahead. Used for the workspace switcher, account menu, card "Move to…", and row actions. |
| 3.24 | `Kbd` | Mono 10.5px, a 1px line box, radius 4, muted. |
| 3.25 | `Skeleton` | Static `sunk` bars with no shimmer. Use it only when a layout would jump. Otherwise show "Loading…" text. |
| 3.26 | `Pagination` | Cursor based: "Load more" button at the end of a table, plus mono "200 of 1,240". |
| 3.27 | `ThemeToggle` | A text control "Light · Dark · System" in micro mono. It stores `localStorage["rb-theme"]` (try/catch), sets `data-theme` on `<html>`, and a pre-paint inline script prevents a flash. |
| 3.28 | `Wordmark` | "Raisebook" in Bricolage 700 with -0.02em tracking. Sizes 20 (app top bar), 28 (sign-in), 22 (marketing nav). No logo glyph in MVP. The favicon is a cobalt "R" set in Bricolage on a 6px-radius square (`app/icon.svg`). |
| 3.29 | `TopBar`, `AppShell`, `PageHeader` | §4.1. |
| 3.30 | `FileDrop` | A dashed `line` box on canvas: "Drop a CSV here, or paste below" + a "Choose file" button. The accent dashed border on dragover. It reads the file client-side as text (≤5 MB) and does no upload until the user confirms. |
| 3.31 | `DefList` | The prototype `.facts`: a 112px muted term column and a value column, 6/10 gap, 13px. |
| 3.32 | `LinkButtons` | The prototype `.links`: small bordered link buttons with accent text ("LinkedIn ↗", "Website ↗", "X ↗", and "name@example.com · copy"). |

Glyphs allowed: ✕ ↗ ↑ ↓ → ← · ⌘ ⇧ ↵ and the CSS agent diamond. **No icon library and no
emoji.**

---

## 4. Screens

URLs: marketing at `/`, `/docs/*`, `/privacy`, `/terms`. Auth at `/signin`, `/signin/check`,
`/auth/verify`, `/invite/[token]`, `/onboarding`. App at `/w/[ws]/…` (the workspace slug is
always in the URL; the web client sends it as `X-Workspace`), plus `/account`. `/app`
redirects to the last-used workspace (`localStorage["rb-last-ws"]`, else the first) and its
first open round.

### 4.1 App shell (`TopBar`)
A top bar rather than a sidebar, so the board gets the full width. 56px high, `canvas`
background, 1px line under it, sticky.

```
[Raisebook]  [Kestrel Robotics ▾] [SANDBOX]   [ Seed | Pre-seed 2025 | + ]          Pipeline  Overview  Investors  Settings   [Light·Dark·System] [ZG ▾]
```
- Left: Wordmark (links to the first open round), the workspace switcher (a Menu: workspaces
  with role, "New workspace", "Open sample workspace"), and a `mode` chip SANDBOX for sandbox
  workspaces.
- Center: RoundPicker.
- Right: nav links (body 500; the active link is `fg` with a 2px accent underline, inactive
  links are muted), the ThemeToggle, and the account Menu (initials in a 28px `sunk` circle:
  Account, Sign out).
- Under 900px: the nav collapses into a "Menu" button, and the RoundPicker moves to a second
  row that scrolls horizontally.
- `PageHeader` (inside the content, for non-round pages): a `display-m` title, a muted
  subline, actions on the right, 16px below.

### 4.2 Round: Pipeline (`/w/[ws]/r/[round]`, default view)
This is the prototype page, made real.
```
┌ Ledger (compact) ──────────────────────────────────────────────────────────────────┐
│ COMMITTED TOWARD SEED          │ PIPELINE                                           │
│ $750,000 of $2,000,000         │ [██new██|research|contacted██|replied|meeting|dd|c]│
│ ███████░░░░░░░░░░░░░░          │ ● New 12  ● Researching 8  ● Contacted 9 …         │
│ 18 in conversation · 4 commit… │ Follow up now: (Dana Whitfield) (Marcus Ode) +3    │
└────────────────────────────────────────────────────────────────────────────────────┘
[Search name, firm, focus, notes…        ] [Priority▾] [Type▾] [Industry▾] [Follow-up▾] [Owner▾]  [Board|Table]  48 of 212   [Add investor]
┌ New 12 ─┐┌ Researching 8 ┐┌ Contacted 9 ┐┌ Replied 4 ┐┌ Meeting 6 ┐┌ Diligence 2 ┐┌ Committed 4 · $750k ┐┌ Passed 7 ┐
│ card    ││ card          ││             ││           ││           ││             ││                     ││          │
```
- The board scrolls horizontally with columns `minmax(250px, 1fr)` and `min-height: 60vh`.
  Card order within a column: fit desc, then follow-up date asc, then name (the prototype's
  `byFit`). There is no manual ordering.
- The Table view uses the columns Investor (name 600 + title muted), Firm, Stage, Fit (chip +
  pips), Type, Follow-up, Soft, Committed, Owner, Last activity, Next step. Every column is
  sortable. Default sort: fit desc. Up to 1,000 rows client-side. Rows open the sheet.
- Toolbar filters are the prototype's plus Owner. The state lives in the URL query
  (`?view=table&prio=warm&stage=meeting&q=…`), so views can be shared and survive a reload.
  `localStorage` remembers only the last view per round.
- Clicking a funnel segment or legend item filters to that stage (unlike the prototype, which
  jumped to the table).
- The investor sheet opens with `?investor=<id>` (deep-linkable, and Back closes it).
- "Add investor" opens a Dialog: Name (required), Firm, Title, Email, LinkedIn, Type, Stage
  (default first), Fit. If the API answers with an existing match, the dialog shows "Dana
  Whitfield at Harbor Light is already in your contacts (matched on email)" with the buttons
  "Add to this round" and "Open".
- Viewers: no drag, no Add button, and the controls are disabled with the title "View only".
- Empty round: an EmptyState "No investors in Seed yet", "Import a spreadsheet, add them one
  at a time, or ask your agent.", with the actions [Import CSV] [Add investor]
  [Connect an agent →].

### 4.3 Board keyboard alternative (required)
- Cards are buttons in the tab order, column by column. Enter opens the sheet.
- `Alt+→` / `Alt+←` moves the focused card to the next or previous stage, skipping the `lost`
  stage (which you reach only through the menu). Focus follows the card.
- `M` opens the card's "Move to…" Menu (all stages). This only opens a menu, so no write
  happens on a bare key.
- Each move announces itself through an `aria-live="polite"` region ("Dana Whitfield moved
  to Meeting") and shows a Toast with "Undo".
- The sheet's stage buttons are the third path (pointer, touch and screen-reader friendly).

### 4.4 Investor sheet (on Pipeline)
Top to bottom (each section has a `label` header):
1. **Header**: name (`display-s`), "Title · Firm" muted, chips (priority + "fit 4/5", type,
   industries), close ✕, and an "Open full page ↗" link.
2. **STAGE FOR SEED**: the stage pill buttons (§2.1).
3. **Round fields** grid (2 columns, 1 on phones): Follow up on (date) + Follow-up note, Soft
   amount, Committed amount (setting it opens a small confirm: "Record $250k commitment and
   move to Committed?"), Probability %, Fit (editable FitMeter), Owner (member select), Next
   step (full width). Saves on change or blur, with the mono "Saved" in good beside the
   section label.
4. **LOG**: Segmented Note / Email / Call / Meeting, a textarea ("What happened?"), the date
   (default today), and a "Log note ⌘↵" secondary button.
5. **TIMELINE**: the Timeline component, latest 20, with "Show all" linking to the full page.
6. **CONTACT**: LinkButtons.
7. **FACTS**: DefList (Invests at, Check size, Industries, Tags, Location, Source, Warm intro
   by, Other rounds: "Pre-seed 2025 · Passed").
8. **NOTES**: the investor-level notes textarea, autosaving 1.2s after typing stops ("Saving…"
   → "Saved").

### 4.5 Round: Overview (`/w/[ws]/r/[round]/overview`)
12-column grid (stacked under 1024px).
- Left 8 columns: the full Ledger. Then a **Funnel table** (Stage, Investors, Soft, Committed,
  "Reached": the share that got at least this far) and **Recent activity** (Timeline over the
  round, 30 items, filter "Agent actions" first-class).
- Right 4 columns: **Follow-ups** (groups Overdue / Today / Next 7 days, each row: name, firm,
  stage dot, note, quick actions "Done → +7d" and "Open"); **Round terms** (DefList:
  Instrument, Target, Cap / Pre-money, Target close + "41 days left", Status, and an "Edit
  round" link); **Going quiet** (stale active investors, ≥14 days); **Agents** (API keys used
  in the last 7 days: agent name, "12 actions this week", last used).

### 4.6 Round settings (`/w/[ws]/r/[round]/settings`)
Round terms form, then the **Stages editor**: a Table of stages (drag handle plus up/down
buttons to reorder, label input, color select showing a StageDot, kind select, participant
count, remove). Removing a stage that is in use asks "Move its 6 investors to…". Save replaces
the list (`PUT /stages`). Below: Close round / Reopen, and Delete round (owner, typed
confirm).

### 4.7 Investors directory (`/w/[ws]/investors`)
PageHeader "Investors", subline "212 contacts across 2 rounds", actions [Import CSV] [Add
investor]. Toolbar: search, Type, Tag, Industry, Round (in / not in). Table: checkbox, Name +
title, Firm, Type, Check size, Stage focus, Location, Rounds (one StageDot + round name per
round), Updated. Bulk bar (when rows are selected, it sticks to the bottom): "12 selected ·
[Add to round ▾] [Export CSV] [Clear]". Empty: EmptyState "Your contacts live here", "Every
investor you add to any round shows up once, with their history across rounds.", [Import
CSV] [Add investor].

### 4.8 Investor page (`/w/[ws]/investors/[id]`)
Two columns (5 / 7), stacked on phones.
- Left: header (`display-m` name, "Title · Firm", chips, LinkButtons), the **Profile** form
  (all contact fields, editable inline, saved on blur), and **Notes** (autosave).
- Right: **Rounds**: one ruled row per participation (round name, StageDot + stage select, fit,
  follow-up, amounts, owner), plus "Add to round ▾". Then the **Timeline** (full, paginated,
  with filters and the log composer on top).
- Footer: "Delete investor" (danger-quiet) → ConfirmDialog "Delete Dana Whitfield? This removes
  them from 2 rounds and deletes 34 timeline entries. This can't be undone."

### 4.9 Settings (`/w/[ws]/settings/*`)
A left sub-nav (180px; it becomes a select on phones): General · Members · API keys · Connect
an agent · Data.
- **General**: workspace name, timezone (select, IANA, with the browser's zone suggested),
  default currency; the Rounds list (name, status, target, link to round settings).
- **Members**: Table (name, email, role select for owners, joined, "Remove"/"Leave"), pending
  invites (email, role, expires, Revoke), and an invite form (email + role + "Send invite").
- **API keys**: Table (name, agent name, prefix in mono, scopes as chips, mode chip, created
  by, last used, Revoke). "Create key" opens a Dialog: Name, Agent name (placeholder
  "claude-code"), scopes (Read is always on and disabled, Write is checked by default, Admin is
  unchecked), Expires (never / 30 / 90 days) → then SecretReveal.
- **Connect an agent**: three numbered steps (mono `01 02 03`, not icons). 01 Create a key
  (inline, prefilled name "Claude Code"). 02 Add it to your agent (Tabs Claude Code / Codex /
  Cursor / Other, a CodeBlock with the secret filled in if it was just created, else
  `rb_live_…` with a note). 03 Try it: suggested prompts in a CodeBlock ("What follow-ups are
  due this week in Seed?", "Import investors.csv into Seed as Researching, dry run first.").
  Below: the 15 tools as a Table (tool name in mono, what it does, read/write).
- **Data**: Import (link to the import flow, plus the last 5 import runs), Export (Workspace
  JSON, All investors CSV, a CSV per round), and the **Danger zone** (a 1px `bad` border block):
  "Delete workspace" → ConfirmDialog typed with the slug, plus the copy "Everything in
  Kestrel Robotics is deleted immediately: 2 rounds, 212 investors, 1,904 timeline entries, 3
  API keys. Export first if you want a copy."

### 4.10 Import (`/w/[ws]/import`)
Steps shown as a mono "1 Source · 2 Columns · 3 Review" line with the current step in `fg`.
1. **Source**: FileDrop or paste; format auto-detected (CSV or prototype JSON); round select
   ("Contacts only" or a round), default stage, source label, on_duplicate radio (Skip
   existing / Fill empty fields / Update existing), each with one plain sentence of
   explanation.
2. **Columns**: a Table with one row per CSV column: header, three sample values (mono,
   muted), and the field select (auto-mapped; unmapped shows "Ignore"). Round fields are
   disabled with "Pick a round first" when no round is chosen.
3. **Review**: a counts strip (`Create 140 · Update 12 · Skip 30 · Errors 3 · Add to Seed 182`),
   then a Table of rows (row number, action chip, name, firm, matched existing, errors in bad).
   The primary button "Import 152 investors". The result view shows the counts plus "View in
   Seed →".

### 4.11 Onboarding (`/onboarding`)
A centered 560px column on canvas, with the Wordmark top-left and a mono "1 / 3" step
counter.
1. "What are you raising for?": company name (= workspace), timezone (prefilled).
2. "Your round": name (default "Seed"), target amount, instrument (Segmented SAFE / Priced /
   Note), cap or pre-money, target close date. A muted line: "You can change stages later.
   We start you with New → Researching → Contacted → Replied → Meeting → Diligence →
   Committed → Passed."
3. "Bring your investors": three ruled options (not cards): **Import a spreadsheet** (→
   import flow), **Add them as you go** (→ empty pipeline), **Connect your agent first** (→
   Connect page). A secondary link at the bottom: "Just looking? Open a sample workspace with
   fictional investors." (`POST /v1/workspaces {sample: true}`).

### 4.12 Sign in (`/signin`, `/signin/check`, `/auth/verify`, `/invite/[token]`)
A 400px centered column. Wordmark 28, `display-s` "Sign in or create an account", an email
Field, and the primary button "Email me a sign-in link". Muted line: "No password. The link
works once and expires in 15 minutes." The check page: "Check your inbox", with the email
shown in mono, and in dev a CodeBlock with the `dev_link` plus "Open dev link". The verify
page shows "Signing you in…" and a fallback "Continue" button. Errors are specific ("That
link was already used or expired. Request a new one.") with the code in mono. The invite page
shows "Dana invited you to Kestrel Robotics as an editor", then sign-in with the email hint.

### 4.13 Account (`/account`)
PageHeader "Account". Sections: Name, Email (read-only, mono), Workspaces (Table: name, role,
Leave), Sign out, and the Danger zone "Delete account" (typed email confirm; it lists the
workspaces that will be deleted, and the ones blocked until ownership is transferred).

### 4.14 Landing page (`/`)
Marketing max-width 1120px, canvas background, body-l. Real components with fictional data,
**not screenshots**, and no stock illustrations.
1. **Nav** (64px): Wordmark 22 · Docs · MCP · Privacy · GitHub ↗ · [Sign in] (ghost) ·
   [Start free] (primary).
2. **Hero** (two columns, 5/7; stacked under 900px): a mono eyebrow `FREE FOREVER · OPEN
   SOURCE · AGPL-3.0`; `display-xl` headline "Run your raise from one ledger."; a body-l lede
   "Raisebook tracks every investor through every round: stages, follow-ups, notes and
   commitments. It's free forever, and your coding agent can work the pipeline with you over
   MCP."; [Start your raise] (primary lg) and "Connect Claude Code →" (link). Right: a live
   **product vignette** built from the real `Ledger` + 4 `BoardColumn`s (Contacted, Meeting,
   Diligence, Committed) with sample investors, one card carrying the agent marker, framed in
   a surface with a 1px line and radius 8, cropped at the right edge. It is static: hover
   works, drag does not.
3. **Facts strip**: four mono facts separated by 1px rules: `$0 · no paid tier, ever` ·
   `15 MCP tools` · `CSV in, CSV + JSON out` · `AGPL-3.0 · self-hostable`.
4. **"Your agent can work the round."** Left: copy (60ch) plus three short points as a ruled
   list ("It logs what happened.", "It sets the next follow-up.", "You see every action, in
   orchid, on the timeline."). Right: a dark CodeBlock styled as a Claude Code transcript (a
   prompt like "Met Dana from Harbor Light today, she wants the data room. Move her to
   Diligence and remind me Friday." → the tool calls `log_activity`, `move_stage`,
   `set_follow_up` → result lines), and under it a light Timeline excerpt with the same three
   entries rendered as agent actions.
5. **"Board, table, and a file on every investor."** Three columns, each with a small real
   component (a BoardCard, three Table rows, a Sheet header with a stage selector) and a
   2-sentence caption.
6. **"Bring the spreadsheet you already have."** A column-mapping vignette (CSV headers →
   Raisebook fields as a Table with a mono "→"), plus the line "Dedupes by email, LinkedIn and
   name + firm. Preview before anything is written."
7. **"The privacy promise."** The six promises from SPEC §8.4, as a numbered ruled list (`01`
   to `06` in mono muted, bold first sentence, then the rest). Link: "Read the full privacy
   page →".
8. **"Free forever. Here's how."** A short essay block (body-l, 2 paragraphs): no investors to
   answer to, no paid plan, AGPL so hosted forks stay open, costs kept low, donations
   optional and never unlocking anything. [Support Raisebook] (secondary, links to
   `NEXT_PUBLIC_SPONSOR_URL`) and "Self-host it →".
9. **Open source**: one line with the repo link, plus a CodeBlock `git clone … && docker
   compose -f deploy/docker-compose.yml up`.
10. **Footer**: Wordmark, "Free, private, open source fundraising CRM.", links (Docs, MCP
    setup, REST API, CSV format, Privacy, Terms, GitHub, Support), and a mono line
    `raisebook.org · AGPL-3.0`.

### 4.15 Docs (`/docs/*`)
A left nav (220px, sticky; it becomes a select on phones) and content at a 680px measure in
body-l. Pages: Getting started · Connect an agent (MCP) · MCP tools reference · REST API ·
CSV import format · Export and delete · Self-hosting · Privacy. Code in CodeBlock. Tables for
parameters (Name in mono, Type, Required, Description). Headings are `display-l` (H1) and
`display-xs` (H2) with anchor links that appear on hover.

---

## 5. Responsive and accessibility rules
- Every screen works at 360px wide with a 16px gutter and no horizontal page scroll (the board
  and wide tables scroll inside their own container).
- Under 640px: the Sheet is full width; the board columns are 85vw wide with scroll snap; the
  toolbar filters collapse into a "Filters" button that opens a Sheet.
- Touch targets are at least 32px (40px for primary actions on phones).
- Every interactive element is reachable by keyboard with a visible focus. Drag has the
  keyboard alternative in §4.3.
- Color is never the only signal: stage dots always have labels, priority chips have words,
  and the agent color always comes with the agent name and diamond.
- Contrast: meaningful text ≥ 4.5:1 in both themes (`faint` is never used for text that
  carries meaning).

---

## 6. Voice

- **Who we are talking to**: a founder in the middle of a raise. Be brief, concrete and calm.
  Founder to founder.
- **App copy**: say what happened and what is next. "Dana Whitfield moved to Meeting." "3
  follow-ups are overdue." "Imported 140 investors into Seed. 30 were already there and were
  skipped." Use the product's nouns: round, stage, follow-up, commitment, soft circle.
- **Agents**: name them. "claude-code logged a call with Dana" and never "AI updated". Agent
  actions are reported plainly, never celebrated.
- **Buttons** are verbs: "Add investor", "Import 152 investors", "Log note", "Create key",
  "Delete workspace permanently".
- **Empty states**: what lives here, then how to get it there. One sentence each.
- **Errors**: what went wrong and what to do, in one or two sentences, with the `error.code`
  in mono. Never "Something went wrong" or "Oops".
- **Marketing**: plain and specific, with numbers ("15 MCP tools", "$0"), and promises we can
  keep and link to code. Allowed: "free forever", "open source", "private". Banned: "AI-powered",
  "supercharge", "seamless", "unlock", "revolutionize", "game-changer", "10x", exclamation
  marks, emoji, testimonials, customer logos, "trusted by".
- Sentence case for headings and buttons. American English. The Oxford comma is optional, but
  be consistent within a page.
- **Sample data**: always fictional (Kestrel Robotics; Dana Whitfield of Harbor Light Ventures;
  Marcus Odell of Juniper Angels; emails at example.com). Never use real investors.

---

## 7. Do / Don't

**Do**
- Start from the prototype's density: 14px body, 8px radius, 1px lines.
- Put numbers in mono or tabular figures, and right-align them in tables.
- Show the actor on every timeline entry, and mark agent work in orchid.
- Keep one primary (cobalt) button per view.
- Check every screen in dark mode and at 360px.

**Don't**
- Purple or blue gradients, glassmorphism, blur, glow or neon.
- "Card soup": grids of rounded-xl cards with icons and shadows. Use ruled lists, tables and
  the board.
- An icon library (lucide, heroicons), emoji, or icon feature grids on the landing page.
- Inter or system-ui as the visible font, or one font for everything.
- Stage colors as fills behind text, or orchid for anything that is not an agent.
- Text in `faint`, or any meaningful text under 4.5:1.
- Spinners, shimmer skeletons, bouncing or scaling animations.
- Modals for things a sheet or inline edit can do.
- Third-party scripts, fonts from Google at runtime, analytics, or embedded iframes.
