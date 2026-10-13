# UX pass 1: plan

Status: built and integrated (commit "UX pass 1: integrate"); checks and results in `design/screens/ux-pass-1/README.md`. Owner: product design lead. Date: 2026-10-12.

This plan merges three local audits of Raisebook: first run, daily use with two companies of
about 420 investors each, and a visual audit in light, dark, 1024/1280/1440 and 390px. The
screenshots are in `/tmp/rb-audit-first-run/`, `/tmp/rb-audit-daily-use/` and
`/tmp/rb-audit-visual/`. Copy anything you want to keep into `design/screens/` before a reboot
clears them. The founder uses Raisebook every day for two companies. Their feedback was:

> "we need better ui/ux" and "for the timezone I want a search so I can search my city or
> timezone, now it's just a default option picker".

Quality bar: Linear or Attio level of craft, fast keyboard workflows, comfortable with 400+
investors per round, light, dark and mobile, and accessible. `design/SYSTEM.md` stays binding
unless this document changes it explicitly (see "Design-system changes").

---

## 0. Rules for this pass

- **Work locally only.** Never deploy, never touch the server or DNS, and never push. Use the
  integrator recipe in `CLAUDE.md` (API on :8100, web production build on :3100, a throwaway
  database, `RAISEBOOK_RATE_LIMIT_BACKEND=off`). If parallel workers run at the same time,
  each one uses its own ports and database (for example WS-A on :8110/:3110 with
  `raisebook_uxa`).
- **No new dependencies.** There is still no component library, and no virtualization, date,
  timezone or fuzzy-search library. Everything is built by hand on the platform's `Intl.*`
  APIs.
- **Edit only the files your workstream owns** (§3). If you need a change in a file you do not
  own, write it in your report as `needs: <file> <change>` and work around it locally.
  `web/lib/api/types.ts`, `docs/SPEC.md` and `design/SYSTEM.md` belong to the integrator.
  Put new types in your own `lib/api/<area>.ts`, and put doc changes in your report as
  "doc deltas".
- **New UI kit components that another workstream owns** are imported by file path
  (`@/components/ui/CommandPalette`) until the integrator adds them to
  `web/components/ui/index.ts`. WS-A owns `index.ts` and adds its own exports there directly.
- **No schema migration** in this pass, unless an item below says one is needed. None of the
  P0 or P1 items need one.
- **Checks before finishing.** On the web side run `npm run lint && npm run typecheck && npm
  run build`, plus `npm run test:unit` once WS-A adds it. On the backend run `uv run pytest -q
  && uv run ruff check . && uv run ruff format --check . && uv run mypy raisebook`. Every
  item also needs a headless-Chrome check (puppeteer-core with the system Chrome, run from
  the scratchpad and never added to `package.json`). Save screenshots to
  `design/screens/ux-pass-1/<item-id>--{light,dark,mobile}.jpg`.
- **Commits**: one per item where practical, prefixed with the workstream and item, for
  example `WS-A P0-1: Combobox primitive`. Commit only your own files.
- **Demo data is fictional only.** Use the audit CSVs in `/tmp/rb-audit-daily-use/` (420 rows)
  and `/tmp/rb-audit-first-run/` (410 messy rows) as scale fixtures. Copy them into
  `backend/tests/fixtures/` only if every name and email in them is fictional (example.com).

### Shared acceptance bar (applies to every item, so it is not repeated)
- It works with the keyboard alone, focus is always visible, and focus goes back to the
  element that opened a popover, sheet or dialog when it closes.
- Text has at least 4.5:1 contrast in both themes (3:1 for large text and UI boundaries).
- At 390px nothing scrolls sideways except an explicit `TableScroll`, and tap targets are at
  least 40px.
- There are no layout breaks at 1024, 1280 and 1440px.
- It uses tokens only (no raw hex in components), respects `prefers-reduced-motion`, and
  makes no third-party runtime requests.
- No console errors or React key warnings in the production build.

---

## 1. Priorities at a glance

| ID | Item | WS | Why now |
|---|---|---|---|
| **P0-1** | `Combobox` primitive (searchable, keyboard, async-ready, ARIA 1.2) | A | Foundation for the next three items |
| **P0-2** | `TimezonePicker` (city, country, abbreviation and offset search; shows local time and UTC offset) | A | The founder's explicit request |
| **P0-3** | `CurrencyPicker` (searchable, every ISO 4217 code) | A | Same complaint; 13 hard-coded codes |
| **P0-4** | Pickers used everywhere, plus the onboarding timezone and currency bugs | A | Silent data loss and a wrong currency symbol |
| **P0-5** | Edits in the investor sheet "revert" after closing it | B | The founder thinks saves fail |
| **P0-6** | Import keeps rows whose only problems are in optional cells | D | 23% of a 410-row list was dropped |
| **P0-7** | Top bar breaks at 1024–1279px; the theme toggle moves to the account menu | C | The round picker is clipped on laptops |
| P1-1 | Client-only filter, sort and search, a trimmed payload, virtualized table and board | B | Every filter click costs about 9 API calls and 673 KB |
| P1-2 | Dense table: compact rows, one-line cells, roving focus, sticky first column | B | About 10 of 420 rows fit on screen |
| P1-3 | Compact board cards, column sorting, collapsed empty columns | B | About 3.5 cards per column on screen |
| P1-4 | One-line toolbar: a Filter menu and removable filter chips | B | 5 native selects wrap at 1280 |
| P1-5 | Sheet: follow-up `DateField` with quick picks, j/k next/previous, work-first order | A (DateField), B (sheet) | Follow-up is the most frequent edit |
| P1-6 | Bulk selection and actions in the pipeline table | B | Cleaning up 420 rows one at a time |
| P1-7 | ⌘K command palette and global shortcuts | C | There are no shortcuts at all today |
| P1-8 | Today queue on Overview: Done and Snooze with Undo, ask for the next follow-up | C | Working through 59 due follow-ups is slow |
| P1-9 | Less chrome above the board, consistent page titles, NamePrompt only once | C | The board starts at y=384 of 900 |
| P1-10 | Import review: filter chips, every row listed, sticky action bar, value mapping | D | Rows 201–410 can't be checked |
| P1-11 | Import activities shown as one grouped entry | C (render), D (data) | About 840 lines flood the feed |
| P1-12 | Focus rings, row hover vs. selected, closed-round contrast | A, B, C | Fails SYSTEM's own rules |
| P2-* | See §4 | — | — |

---

## 2. Shared contracts (frozen on day 1 so the workstreams can run in parallel)

WS-A publishes these signatures in its first commit, as typed stubs that already render a
working fallback (a native `<select>` or `<input type=date>`). The other workstreams code
against the signatures right away and get the real behavior when WS-A merges.

### 2.1 `Combobox` (`web/components/ui/Combobox.tsx`, WS-A)
```ts
export interface ComboboxOption<V = string> {
  value: V;
  label: string;                  // primary text; matched and highlighted
  description?: ReactNode;        // second muted line or inline muted text
  hint?: ReactNode;               // right-aligned (mono offset, symbol, count, kbd)
  keywords?: string[];            // extra match terms (aliases, country, abbreviations)
  group?: string;                 // section label ("Suggested", "Contact", "In Seed")
  disabled?: boolean;
}
export interface ComboboxProps<V = string> {
  value: V | null;
  onChange: (value: V | null, option: ComboboxOption<V> | null) => void;
  options?: ComboboxOption<V>[];                            // sync source, or…
  loadOptions?: (query: string, signal: AbortSignal) => Promise<ComboboxOption<V>[]>; // async source
  filter?: (options: ComboboxOption<V>[], query: string) => ComboboxOption<V>[]; // default: ranked fuzzy
  pinned?: ComboboxOption<V>[];   // shown above results when the query is empty
  renderValue?: (option: ComboboxOption<V> | null) => ReactNode; // trigger content
  placeholder?: string;           // trigger placeholder
  searchPlaceholder?: string;     // input placeholder inside the popover
  emptyText?: (query: string) => ReactNode;
  clearable?: boolean;
  disabled?: boolean;
  size?: "sm" | "md";             // 28 / 32px trigger
  id?: string; name?: string; "aria-label"?: string; "aria-describedby"?: string; "aria-invalid"?: boolean;
  debounceMs?: number;            // async only, default 150
  maxResults?: number;            // default 200; virtualized beyond 60 rendered rows
  fullScreenOnMobile?: boolean;   // default true under 640px
  className?: string;
}
export function rankOptions<V>(options: ComboboxOption<V>[], query: string): ComboboxOption<V>[];
export function Highlight(props: { text: string; query: string }): JSX.Element;
```
It works inside `Field` (the label is wired up through `id`).

### 2.2 `TimezonePicker` and `CurrencyPicker` (WS-A)
```ts
<TimezonePicker value={tz} onChange={(tz: string) => …} suggest?={browserTz} disabled? size? />
<CurrencyPicker value={code} onChange={(code: string) => …} suggestFrom?={{ timeZone?, locale? }} disabled? size? />
// web/lib/tz/index.ts
export function browserTimeZone(): string;                  // canonical, falls back to "UTC"
export function canonicalZone(id: string): string;          // Asia/Calcutta → Asia/Kolkata
export function zoneLabel(id: string, at?: Date): { city: string; region: string; offset: string; now: string };
export function searchZones(query: string, at?: Date): ZoneOption[]; // pure and unit-tested
// web/lib/currency.ts
export function currencyOptions(locale?: string): CurrencyOption[];
export function guessCurrency(opts: { timeZone?: string; locale?: string }): string; // "AMD" for Asia/Yerevan
```

### 2.3 `DateField` (`web/components/ui/DateField.tsx`, WS-A)
```ts
<DateField value={iso | null} onChange={(iso: string | null) => …}
  timeZone={workspaceTz} quickPicks?={"followup" | "deadline" | "none"}
  placeholder="Set follow-up" clearable size? disabled? aria-label? />
// web/lib/dates.ts
export function quickPicks(kind: "followup" | "deadline", today: string): { label: string; iso: string; kbd?: string }[];
export function parseLooseDate(input: string, today: string): string | null; // "fri", "+7", "oct 20", "2026-10-20", "10/20"
export function todayIn(timeZone: string): string;          // ISO date in the workspace calendar
```

### 2.4 Hotkeys and commands (`web/lib/hotkeys.ts`, `web/lib/commands.ts`, WS-C)
```ts
useHotkey(combo: string /* "mod+k", "/", "g p", "j", "shift+?" */, handler: (e: KeyboardEvent) => void,
          opts?: { enabled?: boolean; allowInInputs?: boolean; description?: string; group?: string });
useCommands(sourceId: string, commands: Command[] | null); // e.g. the pipeline registers "Move Dana to Meeting…" while her sheet is open
interface Command { id: string; label: string; group: string; keywords?: string[]; kbd?: string; run: () => void | Promise<void>; }
```
Hotkeys never fire while focus is in an input, textarea, select or contenteditable, unless
`allowInInputs` is set. The `?` sheet lists every hotkey registered with a description.

### 2.5 Already available
`useToast().show(msg, { label: "Undo", onClick })`. Use it for every reversible write that
P1-6 and P1-8 add.

---

## 3. Workstreams and file ownership

Four workstreams with no overlapping files. Each one ships its P0 items first. P0 items do
not depend on another workstream. In P1, WS-B and WS-C consume WS-A's `DateField` and
`Combobox` through the frozen contracts in §2.

### WS-A: Kit primitives and setup flows ("Pickers & Setup")
Owns:
- `web/components/ui/Combobox.tsx` (new), `TimezonePicker.tsx` (new), `CurrencyPicker.tsx`
  (new), `DateField.tsx` (new), `Field.tsx`, `Kbd.tsx`, `Button.tsx`, `Dialog.tsx`,
  `Segmented.tsx`, `index.ts`
- `web/lib/tz/**` (new), `web/lib/currency.ts` (new), `web/lib/dates.ts` (new),
  `web/lib/format.ts`, `web/lib/api/core.ts`, `web/lib/api/settings.ts`, `web/lib/**/*.test.ts`
  (new) and the `test:unit` script in `web/package.json` (scripts only, no dependencies)
- `web/app/design/**` (the kit inventory)
- `web/app/(auth)/**` (sign-in, verify, invite, onboarding route)
- `web/components/app/onboarding/**`, `RoundForm.tsx`, `RoundSettings.tsx`,
  `StagesEditor.tsx`, `web/components/app/settings/**`
- `web/app/(app)/w/[ws]/settings/{page.tsx,layout.tsx,members/**,mcp/**,api-keys/**}`,
  `web/app/(app)/w/[ws]/r/[round]/settings/**`
- Backend: `backend/raisebook/services/workspaces.py`, `backend/raisebook/services/rounds.py`
  (currency validation only), `backend/tests/test_workspaces.py`

### WS-B: Round work surface ("Pipeline")
Owns:
- `web/components/app/Pipeline.tsx`, `PipelineBoard.tsx`, `PipelineTable.tsx`,
  `InvestorSheet.tsx`, `ParticipantFields.tsx`, `LogComposer.tsx`, `RoundHeader.tsx`,
  `AddInvestorDialog.tsx`, `util.ts`, `load.ts`
- `web/components/ui/Board.tsx`, `Table.tsx`, `Ledger.tsx`, `FunnelBar.tsx`, `Sheet.tsx`,
  `Chip.tsx`, `Stage.tsx`, `FitMeter.tsx`, `Meter.tsx`, `ActorName.tsx`, `Avatar.tsx` (new),
  `useVirtualRows.ts` (new), `FilterBar.tsx` (new)
- `web/app/(app)/w/[ws]/r/[round]/page.tsx`
- `web/lib/api/rounds.ts`
- Backend: `backend/raisebook/api/participants.py`, `services/participants.py`,
  `services/followups.py`, `schemas/participants.py`, `tests/api/test_participants_api.py`,
  `tests/isolation/test_rest_isolation.py` (WS-B is the only workstream that adds a REST
  route in this pass), `tests/test_permissions_features.py`

### WS-C: Shell, navigation, keyboard, overview and directory ("Shell")
Owns:
- `web/components/ui/TopBar.tsx`, `RoundPicker.tsx`, `ThemeToggle.tsx`, `Menu.tsx`,
  `Toast.tsx`, `Tooltip.tsx`, `PageHeader.tsx`, `Timeline.tsx`, `EmptyState.tsx`, `Tabs.tsx`,
  `Pagination.tsx`, `CommandPalette.tsx` (new), `ShortcutsSheet.tsx` (new)
- `web/lib/hotkeys.ts` (new), `web/lib/commands.ts` (new), `web/lib/theme.ts`,
  `web/lib/session.ts`, `web/lib/api/investors.ts`, `web/lib/api/activities.ts`,
  `web/lib/api/client.ts`, `web/lib/api/server.ts`
- `web/app/(app)/_shell/**`, `web/app/(app)/layout.tsx`, `web/app/(app)/app/**`,
  `web/app/(app)/account/**`, `web/app/(app)/w/[ws]/layout.tsx`,
  `web/app/(app)/w/[ws]/page.tsx`, `web/app/(app)/w/[ws]/investors/**`,
  `web/app/(app)/w/[ws]/r/[round]/overview/**`, `web/app/globals.css`
- `web/components/app/NamePrompt.tsx`, `RoundOverview.tsx`, `InvestorsDirectory.tsx`,
  `InvestorPage.tsx`, `InvestorProfile.tsx`, `ApiErrorState.tsx`, `account/**`
- `web/components/marketing/**` (P2 only)
- Backend: `backend/raisebook/api/activities.py`, `schemas/activities.py`,
  `services/activities.py` (read paths only), `services/search.py`, `api/investors.py`
  (read paths only), `tests/api/test_activities_api.py`, `tests/api/test_investors_api.py`

### WS-D: Import and data ("Import")
Owns:
- `web/components/data/**`, `web/components/ui/FileDrop.tsx`,
  `web/app/(app)/w/[ws]/import/**`, `web/app/(app)/w/[ws]/settings/data/**`,
  `web/lib/api/data.ts`, `web/app/(marketing)/docs/csv/**`, `web/public/templates/**` (new)
- Backend: `backend/raisebook/services/imports.py`, `services/csv_io.py`,
  `services/normalize.py`, `api/imports.py`, `schemas/imports.py` (or wherever the import
  schemas live), `mcp/tools/data.py`, `tests/services/test_imports.py`, `test_csv_io.py`,
  `test_normalize.py`, `tests/api/test_imports_api.py`, `tests/mcp/*import*`,
  `tests/fixtures/**`

### Integrator (after the workstreams merge)
Owns `web/lib/api/types.ts`, `docs/SPEC.md`, `design/SYSTEM.md`, `docs/OWNERSHIP.md` and
exports added to `web/components/ui/index.ts` for components outside WS-A. The integrator
applies the `needs:` and doc-delta lines from each report, runs the whole check suite and
the screenshot sweep (`design/screens/ux-pass-1/`), and does the final cross-workstream
keyboard pass.

Merge order: the P0 items are independent, so merge them as they land. Within P1, WS-A's
`DateField` (P1-5a) merges before WS-B's P1-5b and WS-C's P1-8. WS-C's hotkeys (P1-7a) merge
before WS-B registers j/k and sheet commands (P1-2, P1-5b).

---

## 4. Items and acceptance criteria

### P0: must ship

#### P0-1 `Combobox` primitive (WS-A)
A searchable single-select built from an Input and a popover listbox, with no library.
- The trigger looks like a `Select` (28 or 32px, 1px line, radius 6, chevron). It shows
  `renderValue` or the label. Clicking it, or pressing Enter, Space, ↓ or any printable key,
  opens it. A printable key goes straight into the search box.
- Inside the popover: a search input (autofocused) over a `role="listbox"`. Rows are 32px,
  with group labels in `label` type. Matched characters are shown in weight 600 with no color
  change.
- Keyboard: ↑/↓ move, with wrap; Home/End (and ⌘↑/⌘↓); PageUp/PageDown move 10; Enter
  selects; Esc closes and keeps the value (a second Esc clears the query first if there is
  one); Tab selects the active option and moves on; Alt+↓ opens. The active row scrolls into
  view.
- ARIA follows the 1.2 select-only/editable pattern: `role="combobox"`,
  `aria-expanded`, `aria-controls`, `aria-activedescendant` and `aria-autocomplete="list"`;
  options have `role="option"` and `aria-selected`. A polite live region announces "12
  results". Labels come from `Field`.
- Ranking (`rankOptions`): matching ignores case and diacritics ("sao" matches "São
  Paulo"). Exact label > label prefix > word prefix in the label > keyword exact > keyword
  prefix > substring > in-order subsequence. Ties keep the original order.
- Async: `loadOptions` is debounced (150ms), aborts stale requests, shows "Searching…" and
  then the results, and shows an error row with a Retry action. A late response never
  overwrites a newer query.
- Large lists: past 60 rendered rows it uses windowed rendering (a hand-rolled fixed row
  height), and stays smooth with 500+ options.
- Under 640px it opens full screen as a sheet with the search box at the top. The on-screen
  keyboard does not cover the list (it uses `visualViewport`).
- Shown in `/design` with sync, async, grouped, empty and disabled examples.

Acceptance:
- [ ] Every keyboard path above works in Chrome, Safari and Firefox. Checked with VoiceOver
  (macOS): it announces the role, the expanded state, the active option and the result count.
- [ ] 500 options: opening and typing each take under 16ms per frame (Performance panel,
  6× CPU throttle on M-series), and the DOM holds no more than about 70 option nodes.
- [ ] Async demo with 300ms latency: typing "ab" quickly then "abc" never shows "ab"
  results after "abc".
- [ ] `node --test web/lib/**/*.test.ts` covers `rankOptions` (diacritics, prefix
  beats substring, stable ties).

#### P0-2 `TimezonePicker` (WS-A)
Built on `Combobox`.
- Data (`web/lib/tz/`): zone ids come from `Intl.supportedValuesOf("timeZone")` plus `UTC`.
  A hand-written table maps each zone to its country, and lists city aliases and the legacy
  ids (around 15 KB; it loads with `import()` the first time the picker opens, so it is not
  in the main bundle). The canonical map covers at least Asia/Calcutta→Asia/Kolkata,
  Asia/Saigon→Asia/Ho_Chi_Minh, Asia/Katmandu→Asia/Kathmandu, Europe/Kiev→Europe/Kyiv,
  America/Godthab→America/Nuuk, Asia/Rangoon→Asia/Yangon, Pacific/Truk→Pacific/Chuuk,
  Etc/UTC|Etc/GMT|GMT|UCT→UTC and US/*→America/*. The list shows only canonical ids, once
  each. Legacy names stay searchable as keywords.
- Aliases cover at least: SF, San Francisco, Bay Area, Silicon Valley, Palo Alto, Seattle, LA
  → America/Los_Angeles; NYC, New York, Boston, Miami, DC → America/New_York; Austin,
  Chicago, Dallas → America/Chicago; Denver → America/Denver; Toronto; London, UK; Paris;
  Berlin; Amsterdam; Zurich; Stockholm; Tel Aviv → Asia/Jerusalem; Dubai; Yerevan, Armenia;
  Bangalore, Bengaluru, Mumbai, Delhi, Kolkata → Asia/Kolkata; Ho Chi Minh, Saigon;
  Singapore; Hong Kong; Tokyo; Seoul; Sydney; Melbourne; Auckland; Lagos; Nairobi; São Paulo.
- Abbreviations: computed on the fly from `Intl.DateTimeFormat` `timeZoneName: "short"` and
  `"shortGeneric"` in `en-US`, plus a fixed map for names `Intl` renders as "GMT+x" (PST/PDT/PT,
  MST/MT, CST/CT, EST/EDT/ET, GMT/BST, CET/CEST, EET, IST (India, also Israel and Ireland),
  JST, KST, SGT, HKT, AEST/AEDT, NZST, GST (Gulf), AMT (Armenia)).
- Offset search: "UTC+4", "GMT+4", "+4", "+04:00", "UTC-7", "-0700" and "+5:30" match every
  zone at that offset **now** (DST-aware), sorted by population weight (a small rank
  field in the table, so Dubai and Yerevan come before Samara).
- Each row reads `Yerevan` (fg 500), then muted `Armenia · Asia/Yerevan`, and on the right
  mono `UTC+04:00 · 4:31 PM`. Times update once a minute while the picker is open and never
  re-render the list on every keystroke.
- The trigger reads `Yerevan  UTC+04:00` (the offset in mono, muted). With `size="md"` it
  also shows the local time in muted text: `· 4:31 PM now`.
- Pinned when the query is empty: "Your browser · <zone>" (if it differs from the current
  value), the current value, then "UTC". A "Suggested" group holds the 12 most-used founder
  hubs (SF, NYC, London, Berlin, Paris, Tel Aviv, Dubai, Bangalore, Singapore, Tokyo, Sydney,
  Yerevan).
- Empty state: `No timezone matches "xyz". Try a city, a country, or an offset like UTC+4.`
- The value written to the API is always the canonical IANA id.

Acceptance (unit tests in `web/lib/tz/search.test.ts`; the expected zone must be the **first**
result unless noted):
- [ ] "San Francisco", "SF", "bay area", "Seattle", "PST", "PT", "pacific" → America/Los_Angeles
- [ ] "Yerevan", "yere", "Armenia", "AMT" → Asia/Yerevan
- [ ] "UTC+4", "+4", "GMT+4" → results include Asia/Yerevan and Asia/Dubai and contain only
  zones whose current offset is +04:00
- [ ] "+5:30" → Asia/Kolkata first; "IST" → Asia/Kolkata first, with Asia/Jerusalem and
  Europe/Dublin also in the results
- [ ] "Kolkata", "Calcutta", "Mumbai", "Bangalore" → Asia/Kolkata; "Kyiv", "Kiev" →
  Europe/Kyiv; "Ho Chi Minh", "Saigon" → Asia/Ho_Chi_Minh
- [ ] "NYC", "new york", "EST", "ET", "boston" → America/New_York; "london", "UK", "BST" →
  Europe/London; "CET", "berlin" → Europe/Berlin; "sao paulo" → America/Sao_Paulo; "utc" →
  UTC
- [ ] `canonicalZone("Asia/Calcutta") === "Asia/Kolkata"`, and the list never shows both
- [ ] Searching takes under 2ms per keystroke over the full list (measured in the test)
- [ ] In the browser with Chrome's timezone overridden to Asia/Calcutta (CDP
  `Emulation.setTimezoneOverride`), onboarding pre-selects "Kolkata · UTC+05:30" and saves
  `Asia/Kolkata`
- [ ] The trigger, the rows and the full-screen 390px variant match the spec in light and
  dark (screenshots)

#### P0-3 `CurrencyPicker` (WS-A)
- Options come from `Intl.supportedValuesOf("currency")`, with the name from
  `Intl.DisplayNames(type: "currency")` and the symbol from a `narrowSymbol` format. A row reads
  `EUR` (mono 500), then `Euro` (fg), and on the right `€` (mono muted).
- Search matches the code, the name, the symbol ("€", "£", "dram", "rupee") and the
  country, using a small currency-to-countries keyword table for the 40 most common
  currencies.
- Pinned: the current value, then the guessed currency (`guessCurrency` from the workspace or
  browser timezone and the locale), then the common ones (USD, EUR, GBP, CAD, AUD, SGD, INR,
  CHF, ILS, JPY).
- `RoundForm`'s `CURRENCIES` constant is removed. The backend keeps accepting any three
  capital letters (`^[A-Z]{3}$`, already the CHECK).

Acceptance:
- [ ] "eur", "euro", "€" → EUR first; "dram", "armenia", "AMD" → AMD first; "rupee" → INR first;
  "£" → GBP first
- [ ] A round in a currency outside the old list (for example `NGN`) can be created, and its
  amounts render with the right symbol in the Ledger, Board and Table
- [ ] With the browser timezone at Asia/Yerevan, AMD is pinned as "Suggested"

#### P0-4 Use the pickers everywhere and fix the onboarding data bugs (WS-A)
Where they go:
- Onboarding step 1: the TimezonePicker, plus a new **Default currency** CurrencyPicker next to
  it, pre-filled with `guessCurrency(browser timezone, locale)`.
- Onboarding step 2: the round currency uses CurrencyPicker and defaults to the workspace
  currency.
- Settings → General: timezone and default currency. "Use it" for the browser timezone saves
  straight away through the existing `SaveState` (no separate Save for that action).
- `RoundForm` (Round settings, the New round dialog): currency.
- `rg -n 'supportedValuesOf|CURRENCIES|<Select[^>]*(tz|currency)' web/` must return
  nothing outside `web/lib/tz` and `web/lib/currency.ts`.

Bug fixes:
- On onboarding Back to step 1, the timezone field starts from `ws.timezone` when the
  workspace exists. The browser zone is used only for a new workspace.
- Continue on step 1 PATCHes the workspace when the **name, timezone or currency** changed
  (today it saves only when the name changed).
- If the first round's currency differs from the workspace default and the user never touched
  the default, set the workspace default to the round's currency.
- Onboarding uses `noValidate` and inline per-field errors (the person's-name error is
  attached to the name field, not to Company), and focuses the first invalid field. The
  heading becomes "Set up your company". The step counter becomes a labeled stepper "Company
  · Round · Investors". The possessive is fixed ("Acme Robotics' first round" or "Your first
  round"). The target amount is marked "Optional" and an empty value sends `null`, never 0.
- Backend `clean_timezone` canonicalizes legacy ids (the same map, mirrored in Python in
  `services/workspaces.py`), so agents and the CLI also store `Asia/Kolkata`.

Acceptance:
- [ ] e2e script: create a workspace in Asia/Yerevan, go to step 2, Back to step 1, check the
  field shows Yerevan, change it to Europe/Berlin only, Continue; `GET /v1/workspace` returns
  `Europe/Berlin`.
- [ ] e2e: choose EUR as the round currency on a fresh workspace → `default_currency` is `EUR`;
  after importing a CSV with "€200k", the Investors directory shows "€200k".
- [ ] An empty name shows the app's inline error under **Your name**, not the browser bubble.
- [ ] Backend test: `PATCH /v1/workspace {timezone: "Asia/Calcutta"}` stores `Asia/Kolkata`;
  `Europe/Kyiv` is accepted (tzdata present).
- [ ] The `rg` check above is clean.

#### P0-5 Investor-sheet edits no longer "revert" after closing (WS-B)
Cause: `closeSheet()` calls `router.back()`, which brings back Next's cached server payload
for the earlier URL. The `useEffect` in `Pipeline.tsx` (around lines 126–132) then copies
those stale props over local state.
- Treat server props as initial data only. Keep the participants and investors in a
  client store keyed by round id and merge incoming server data per row by `updated_at`
  (newer wins), so older data never overwrites a local write.
- Close the sheet with `router.replace` (or `history.replaceState`) to the URL without
  `investor`, never `router.back()`. Opening the sheet uses `replaceState` too, so Back leaves
  the page instead of stepping through sheets. Deep links `?investor=` still work.
- After a write, update the store right away and call `router.refresh()` in the background.
- On close, focus goes back to the card or row that opened the sheet.

Acceptance:
- [ ] e2e script (in `design/screens/ux-pass-1/README.md` as a reproducible recipe): Table
  view → open an investor in Contacted → set Diligence → Esc → the row shows Diligence; ✕
  close → still Diligence; reload → Diligence. The same in Board view.
- [ ] Filter "Due now" → set the follow-up to +7d → close → the investor leaves the due list
  and the "Follow up now" strip.
- [ ] With the sheet open, browser Back leaves the page (one step) and does not reopen
  stale data.
- [ ] Focus is on the opening row or card after close (`document.activeElement` check).

#### P0-6 Import keeps rows whose only problems are in optional cells (WS-D)
- Backend: only a **missing name**, or a row that cannot be parsed at all, is an `error`. A
  bad optional value (an unreadable date, an invalid email, out-of-range fit or probability,
  a bad URL, check_min > check_max) is dropped from the row and becomes a row **warning** such
  as `follow-up left empty: "next week" is not a date`. The row is still imported. This
  applies to CSV, prototype JSON and the MCP `import_investors_csv` tool, since they share one
  service.
- The `error` action and the existing `errors` list stay in the API shape for rows that
  really can't be imported. Warnings use the existing `warnings` list, and a new
  `warning_kinds` count map is added to the preview (`{"follow_up_unreadable": 74, …}`).
- The review step and the commit button say what will happen: `Import 390 · 20 duplicates
  skipped · 74 cells left empty`.
- Doc delta for the integrator: SPEC §8.2 "Row actions" changes to match.

Acceptance:
- [ ] Backend test with the 410-row messy fixture: no more than 1% of rows are errors (only
  nameless ones), and every row with "next week" in Next Follow Up is created with
  `follow_up_on = null` and a warning.
- [ ] Backend test: an invalid email → the row is created without an email and with a
  warning. Dedupe still works by LinkedIn or name+firm for that row.
- [ ] MCP test: `import_investors_csv` reports the same counts and warnings as REST.
- [ ] UI: the commit button label matches the counts in the preview.

#### P0-7 Top bar at 1024–1279px; theme moves to the account menu (WS-C)
- Remove `ThemeToggle` from the app top bar and put a Theme submenu in the account menu
  (Light / Dark / System, with `aria-checked`). It stays in the marketing and auth footers.
- The workspace switcher has `max-width: 160px` and truncates with a `title`.
- When the RoundPicker would overlap the nav (measured with a `ResizeObserver`, not a
  fixed breakpoint), it collapses to "Current round ▾" (a Menu with every round, the
  closed ones under a CLOSED label, and "+ New round").
- Closed rounds are no longer at 60% opacity. They use full-strength `muted` with a mono
  `closed` suffix (≥ 4.5:1).

Acceptance:
- [ ] Screenshots at 1024, 1180, 1280 and 1440 in both themes: no clipping or overlap, and
  "+ Round" is reachable at every width.
- [ ] The theme can be changed from the account menu with the keyboard; the choice persists
  and does not flash on reload.
- [ ] Closed-round contrast is ≥ 4.5:1 in both themes (computed-style check in the script).

---

### P1: next

#### P1-1 Fast filtering at 420+ investors (WS-B)
- Filter, sort, search and view changes are client-only. They update the URL with
  `window.history.replaceState` (no RSC round-trip). Server re-render happens only on
  navigation or `router.refresh()`.
- The pipeline page loads trimmed participant and investor shapes (only the fields the
  cards and rows use; new types live in `lib/api/rounds.ts`). The sheet fetches the full
  investor on open, with a skeleton for the fields that load late.
- The table and the board columns render only the visible rows with a hand-rolled
  `useVirtualRows` (fixed row heights per density). "Show 60 more" goes away.

Acceptance:
- [ ] With 420 investors: changing a filter or typing in search sends **0** `_rsc` requests
  and **0** `/v1` requests (checked in the Network panel or the CDP log).
- [ ] Pipeline HTML for 420 investors is ≤ 600 KB (from 2.0 MB). The DOM holds ≤ 1,500 nodes in
  Table view (from 4.8k).
- [ ] Scrolling a 420-row table and a 142-card column stays above 55fps with a 4× CPU
  throttle.

#### P1-2 Dense table (WS-B)
- A Density toggle (Compact 32px / Comfortable 44px) in the Columns menu, saved per viewer in
  localStorage. It defaults to Compact once a round has more than 100 participants.
- Cells are one line with `nowrap` and an ellipsis, and the full value in `title`. Title is
  its own optional column, or muted text after the name. "Independent" is not shown for angels.
  Fit is one element (the chip **or** the meter, not both).
- The header is sticky, and the Name column is sticky on horizontal scroll.
- Roving focus: ↑/↓ and j/k move the row focus, Enter opens the sheet, Space or x selects
  (P1-6), Home/End jump. One tab stop for the table body.
- Owner shows as a 20px initials `Avatar` plus first name or "You", with the email in `title`.
- Row hover is a neutral tint (`color-mix(in oklab, var(--sunk) 55%, var(--surface))`).
  Selected or open rows get `accent-soft` plus a 2px inset accent rule on the left. Hover and
  selected no longer look the same.

Acceptance:
- [ ] At 1440×900, Compact mode shows ≥ 22 rows.
- [ ] j/k and Enter work through 420 rows without the mouse, and scroll follows focus.
- [ ] Column visibility is stored per round (key `rb-table-cols:<ws>:<round>`), not globally.

#### P1-3 Compact, scannable board (WS-B)
- Cards: firm first ("Marrowstone Capital · Principal"). Follow-up and money chips share one
  wrapping row with priority and type. Shorter labels: "Overdue 4d", "Due today", "Oct 16".
  Cards with no next step target ≤ 84px, and Compact cards (a toggle) ≤ 52px: name and firm,
  then only the stage-relevant chip (due or amount). Committed cards hide fit and priority.
- A column header menu sorts by Fit, Due first, Last activity or Name, and shows a due count.
- ~~Empty columns collapse into thin rails (as Passed already does). On mobile the board opens
  on the first column that has cards.~~ Superseded by design/pipeline-redo/DECISION.md §5.2
  and §7: no rails ever, and phones get a list instead of a board.
- The board fits the viewport: page scroll stops, only the columns scroll, and column headers
  are sticky.
- Keyboard: one tab stop for the board, arrow keys move between cards and columns, M opens
  Move to, Enter opens. The focus ring is inset (`outline-offset: -2px`) and never clipped.

Acceptance:
- [ ] At 1440×900, a Researching column with 142 cards shows ≥ 8 cards in standard mode and
  ≥ 13 in Compact.
- [ ] The card focus ring is fully visible on the first card of a column (crop screenshot).

#### P1-4 One-line toolbar with a Filter menu (WS-B)
- Search (flex 1 1 220px, Kbd `/` hint inside), then a 28px secondary **Filter** button (Kbd
  F) opening a Menu of fields: Stage, Fit, Type, Industry, Follow-up, Owner, Tag. Each field
  opens a value list (a `Combobox` for Industry, Tag and Owner).
- Applied filters show as removable chips ("Owner is Dana ✕") in a row that appears only
  when something is applied, with "Clear". The URL query stays the source of truth.
- Search, the view switch, the count and "Add investor" (Kbd C) stay on one row at ≥ 1024px.
  Under 900px the existing "Filters" sheet stays.

Acceptance:
- [ ] At 1024, 1280 and 1440, with three filters applied, "Add investor" is on the first row.
- [ ] F → ↓ → Enter → choose a value → Esc: the filter is applied without the mouse, and the
  chip is removable with Backspace when focused.

#### P1-5 Follow-up DateField and a work-first sheet (WS-A builds 5a; WS-B builds 5b)
- **5a (WS-A):** `DateField` per §2.3. The trigger is 32px mono "Oct 16 · in 4d" or muted
  "Set follow-up". The popover has quick picks (Today, Tomorrow, In 3 days, Next Monday, In 1
  week, In 2 weeks, Clear, with Kbd hints 0/1/3/m/7/2/⌫), a typed input (`parseLooseDate`:
  "fri", "+7", "oct 20", "10/20", "2026-10-20") and a month grid built from tokens with
  arrow-key navigation. Dates are computed in the **workspace** timezone. WS-A swaps it in
  for the round close date in `RoundForm` (deadline picks: End of quarter, +60d, +90d). Each
  owner swaps the remaining native date inputs: WS-B in the sheet, `ParticipantFields` and
  `LogComposer`; WS-C on the investor page and in the Overview snooze menu.
- **5b (WS-B):** in the sheet, the order is stage pills, follow-up (DateField), next step, then
  the log box (focus it with `n`). Soft, committed, probability and owner fold into a "Money &
  owner" row. j/k (or ↓/↑ with Alt) move to the next or previous investor in the **current
  filtered order** without closing. The sheet registers palette commands (§2.4). When opened
  with the pointer or from a URL, focus goes to the sheet title instead of a ringed ✕.

Acceptance:
- [ ] `parseLooseDate` unit tests, including the year rollover (on Dec 30, "jan 3" is next year)
  and a DST week.
- [ ] Setting a follow-up to "Next Monday" takes ≤ 3 keystrokes from an open sheet.
- [ ] Working through 10 due investors with j and the follow-up shortcuts needs no mouse and
  no sheet close.

#### P1-6 Bulk actions in the pipeline table (WS-B)
- A checkbox column. x toggles, shift-click or Shift+↓ extends, ⌘A selects all filtered, and
  the header checkbox selects all filtered.
- A sticky bulk bar: Move to stage, Set follow-up (DateField picks), Assign owner, Add/remove
  tag, Set fit, Remove from round, Export CSV. Each action shows an Undo toast.
- Backend: `POST /v1/rounds/{round}/participants/bulk-update` with `{investor_ids[], op, …}`
  (at most 1,000), in one transaction, with one activity per investor plus a shared
  `data.bulk_id` so the feed can group them. It is added to the isolation suite and the
  permissions matrix (viewer → 403, another workspace's ids → 404 for the whole request,
  with nothing written).

Acceptance:
- [ ] Moving 30 selected investors to Passed is one request, one toast, and Undo restores
  every stage.
- [ ] The isolation and permissions tests pass, and a mixed-workspace id list writes nothing.

#### P1-7 ⌘K command palette and global shortcuts (WS-C)
- **7a:** `lib/hotkeys.ts` and `lib/commands.ts` per §2.4, plus `ShortcutsSheet` on `?`.
- **7b:** `CommandPalette` (a Dialog with the Combobox listbox behavior): search investors in the
  current workspace (name, firm, email; async via `loadOptions` against the search
  endpoint, with matches highlighted), switch workspace or round, go to
  Pipeline/Overview/Investors/Settings/Import, run "New investor", "Import CSV", "Connect an
  agent", switch Theme, and the commands registered by the open investor sheet.
- Global keys: ⌘K / Ctrl+K palette, `/` focuses search, `g p`/`g o`/`g i`/`g s` navigate, `c`
  adds an investor, `?` shortcuts, ⌘1..9 switch workspace. `n` is reserved for "log a note" in
  the sheet and the Today queue, and `e`/`s` are reserved for the Today queue. Kbd hints appear in menus
  and buttons. `Kbd` renders in `muted`, not `faint`.

Acceptance:
- [ ] With 2 workspaces × 420 investors: ⌘K → type "harp" → Enter opens Harper Coldridge's
  sheet in ≤ 300ms locally.
- [ ] No hotkey fires while typing in an input. Esc closes the palette and focus returns.
- [ ] The palette is announced as a dialog with a combobox (VoiceOver).

#### P1-8 Today queue on Overview (WS-C)
- On desktop, follow-ups come first: overdue, today, then the next 7 days, as the full list
  (virtualized, no "50 more"). Each row has name, firm, stage, "6 days late" (bad-ink mono),
  and the note on the full width.
- Keyboard: j/k move, Enter opens the investor (on the round page with `?investor=`), `e` =
  Done, `s` opens the Snooze menu (Tomorrow, In 3 days, Next Monday, In 2 weeks, Pick date…
  with DateField), `n` = log a note.
- Done asks "Next follow-up?" with the same quick picks (skippable with Esc). Done and Snooze
  each show an Undo toast. Done and Snooze buttons appear on hover or focus-within, always on
  touch.
- On mobile, follow-ups come first on the page.

Acceptance:
- [ ] Clearing 10 overdue follow-ups with e, then a pick, takes ≤ 2 keystrokes per item, and
  Undo restores the date.
- [ ] Every due item is reachable (59 of 59), not 6.

#### P1-9 Less chrome above the work surface (WS-C)
- `NamePrompt` becomes a one-time dismissible toast plus a dot on the avatar, and the name field
  moves into the account menu. No permanent banner.
- `PageHeader` has one in-app title size (22px/700, line-height 1.15) and a fixed 40px height.
  The breadcrumb is inline. Investors, Settings, Import, Account and the investor page match
  the round pages.
- Doc delta for the integrator: SYSTEM §1.5 gaps of 14px between the header, ledger, toolbar
  and board. WS-B applies them inside `Pipeline.tsx` and `Ledger.tsx` (WS-B item P1-4 covers
  the toolbar; WS-B also adds an optional 40px sticky collapsed ledger strip once the board
  scrolls).

Acceptance:
- [ ] At 1440×900 the first board card starts at y ≤ 260 (from 384). On a 390px phone the first
  row starts at y ≤ 360.
- [ ] Titles sit at the same y on every app page (screenshot diff).

#### P1-10 Import review you can trust (WS-D)
- Source: when opened from a round, or when there is exactly one open round, that round is
  the default. Each round choice has its own hint. A chosen file shows as a chip
  ("investors-410.csv · 410 rows · 15 columns · Remove") and the paste box collapses. Rows are
  counted correctly (a trailing newline is not a row; "410 rows + header"). Add "Download
  template CSV" and a link to `/docs/csv`.
- Columns: the field picker is a grouped `Combobox` ("Contact" / "In <round>"). Each column
  shows "120 empty · 74 unreadable" badges that update live. "Last contacted" maps to a dated
  `note` activity. The action bar is sticky.
- Value mapping: when Pipeline stage or Fit is mapped, a panel lists each distinct value with
  its row count and a stage select. Exact and similar labels are matched automatically, and
  unknown values get a suggestion ("Intro requested" → Contacted). The column and value
  mappings are remembered per header signature in localStorage.
- Review: the counts become filter chips (All / Create / Update / Skip / Errors / Warnings)
  over a virtualized list of **every** row. The header and the action bar are sticky. j/k
  navigation. "Download rows with problems (CSV)", built client-side.
- Result: "duplicates within this file" and "already in Raisebook" are reported separately,
  and each duplicate names the row it duplicates. Errors are grouped by kind. Next steps are
  offered ("Set follow-ups for the 40 in Meeting →").
- Investor type: when there is no type column, the import guesses from the title or firm
  ("Angel" → angel, "… Ventures/Capital/Partners" → vc) as a row warning. Otherwise it
  leaves `other`, which the UI renders as "—" (WS-B and WS-C render "—" for `other` in table
  cells; the filter label becomes "Other / not set").

Acceptance:
- [ ] With the 410-row fixture, all 410 rows can be reviewed, and the Errors chip shows only
  real errors.
- [ ] "Intro requested" can be mapped to Contacted in the value panel, and 12 rows land there.
- [ ] The second import of a file with the same headers pre-fills both mappings.
- [ ] In-file duplicates are labeled correctly on a first import into an empty workspace.

#### P1-11 Import activity grouped as one entry (WS-D data, WS-C render)
- WS-D: an import writes `data.import_run_id` on each activity (the column already exists) and
  writes one `import` summary activity per run (count, filename, round).
- WS-C: `ActivityOut` exposes `import_run_id`. `Timeline` and the Overview feed collapse
  consecutive activities that share an `import_run_id` or `data.bulk_id` into one expandable
  entry: "Sam imported 420 investors from investors-420.csv into Seed". The agent diamond
  appears only for agent actions on investors that already existed, not for agent-created
  imports.

Acceptance:
- [ ] After a 420-row import, the Overview feed shows one entry, and real notes are visible above
  the fold.
- [ ] After an API-key import, the board shows no agent diamonds on the imported cards.

#### P1-12 Focus and contrast fixes (WS-A inputs, WS-B cards/rows, WS-C round picker)
- WS-A: inputs, selects, textareas and comboboxes use `:focus-visible` with `border-color:
  var(--accent)` plus `outline: 1px solid var(--accent); outline-offset: -1px` (a crisp 2px
  edge, no halo). Buttons and links keep the 2px/2px outline. Placeholders are all sans,
  `faint`, 14px.
- WS-B: card and row rings are inset (see P1-2 and P1-3).
- WS-C: the closed-round contrast fix ships in P0-7.

Acceptance:
- [ ] There are no double rings on sign-in, dialogs or the sheet (crop screenshots).

---

### P2: later in this pass, if time allows

| ID | Item | WS | Acceptance |
|---|---|---|---|
| P2-1 | Saved views per round: filters, sort, columns, view and density as a tab strip with built-ins (All, Due now, My investors, Hot), ⋯ Save/Rename/Delete, ⌘⇧1..9. Stored in localStorage first (no migration); a server version is a later pass. | B | A view survives a reload and gives the same URL query |
| P2-2 | All-workspaces home (`/app`): due counts per company and a cross-company Today list. The workspace switcher shows due counts, shows the role only when not Owner, and remembers the last route and view per workspace. | C | Switching companies returns to the last page and view used there |
| P2-3 | Non-modal split sheet at ≥ 1280px: the list stays clickable and ↑/↓ moves the selection, with the panel following. | B | Clicking another row with the sheet open swaps the investor in place |
| P2-4 | "Get set up" checklist on an empty pipeline (Import, Invite a co-founder, Connect an agent, Set first follow-ups), ticking off from real data. The zero funnel is hidden until there is one investor. All empty states share the three actions. | B (pipeline), C (directory, overview) | Each check ticks when its data exists, and dismissal persists |
| P2-5 | Investors directory: the same virtualized dense table and selection as the pipeline. Columns that are empty for every row are hidden. A phone list like the pipeline's, with filters in a Sheet. The bulk bar gets Assign owner, Tag and Set type. | C | 420 rows, no "Load more", 390px with no sideways scroll |
| P2-6 | Investor profile shown as a `DefList` with click-to-edit cells. LinkedIn shown as `in/handle ↗`, emails middle-truncated. One input style across the page. | C | No clipped values at 1280 |
| P2-7 | Connect an agent: a live "Waiting for the first call…" → "✓ claude-code connected, 4s ago" status from the key's `last_used`. Caveats move into an Advanced disclosure. Client tabs scroll on phones and code wraps. | A | The status flips within 5s of the first MCP call |
| P2-8 | Members: paste several emails (comma or newline) with one role. A sole owner sees "You're the only owner. Make someone else an owner before you can leave." | A | Inviting 3 at once sends 3 invites, and limits are respected |
| P2-9 | `/auth/verify`: Continue is autofocused (Enter works), the full email shows on the requesting device, plus one line on why the click is needed. | A | Enter signs in, and the scanner protection is unchanged (tests pass) |
| P2-10 | Overview cleanup: data warnings become filter links, a Stale list (active stage, no activity in 14 days), the funnel table is dropped, and the "pipeline :" spacing typo is fixed. | C | "20 in Committed without an amount" links to a filtered table |
| P2-11 | FunnelBar: segments at least 22px wide, the won stage always labeled, a tooltip per segment. The due strip measures its width and always shows "+N more". | B | At 1024 the "+N more" chip is always fully visible |
| P2-12 | `+ Round` opens the New round dialog in place, with a placeholder name that isn't already taken. New workspace becomes a short dialog (name, timezone, currency), not the full onboarding. | A (dialog), C (top-bar entry) | Creating a round never leaves the current page |
| P2-13 | Editable workspace slug with a clean default when it's free. | A | Old slugs redirect, or the change is refused with a clear error |
| P2-14 | Marketing hero preview rebuilt from the real components (Ledger, filter chips, BoardColumn). | C | The preview matches the app after P1-2 to P1-4 |

---

## 5. Design-system changes (doc deltas for the integrator)
- §3.2: the `Select` row says "Use `Combobox` for lists longer than about 12 options, or
  whenever search helps (timezone, currency, owner, tag, import field). Native `Select` is
  for short fixed lists." It also gets the focus rule from P1-12.
- New §3 rows: `Combobox`, `TimezonePicker`, `CurrencyPicker`, `DateField`, `Avatar`,
  `FilterBar`, `CommandPalette`, `ShortcutsSheet`.
- §3.4: closed rounds use the `closed` suffix, not 60% opacity. The picker collapses on
  overlap.
- §3.11: row hover is neutral, selected is accent-soft plus an inset rule, and there is a
  density toggle.
- §3.13: the compact card spec from P1-3.
- §3.27: ThemeToggle lives in the account menu inside the app.
- §4.1: no permanent NamePrompt banner; one title size.
- §4.10 and §4.11: the import and onboarding changes from P0-4, P0-6 and P1-10.
- SPEC §8.2: the row-action change from P0-6, and the `import` summary activity from P1-11.

## 6. Out of scope for this pass
- Deploying, or anything on the production server.
- A server-side saved-views table (P2-1 uses localStorage).
- Search across workspaces on the server (the palette searches the current workspace; P2-2
  adds due counts per workspace from existing endpoints).
- Changing the investor `type` column to allow null (it would need a migration; P1-10 renders
  `other` as "—" instead).
