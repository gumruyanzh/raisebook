# Pipeline redo: decision and build spec

Status: decided, 2026-10-12. This file is the build spec for the round page
(`/w/[ws]/r/[round]`). Where it disagrees with `design/SYSTEM.md` §3.10, §3.12, §3.13, §4.2 or
§4.3, or with `docs/UX-PASS-1.md` P1-3, **this file wins**, and §9 lists the SYSTEM.md edits
to make when this ships.

Inputs: `triage-first/` (8 PNGs, HTML mockups) and `board-first/` (10 PNGs, `src/mock.html`).
Both reproduced the owner's real state locally: a Seed round with 411 investors, all in New,
$0 committed and fits from 0 to 5.

---

## 1. The decision in one paragraph

**Base: triage-first. Grafts from board-first.** The round page gets three views: **Triage**,
**Board** and **Table**. When one early stage holds most of the round (the 411-in-New case), the
page opens in **Triage**: a keyboard-first queue where one key files an investor and opens the
next. From triage-first we take the Triage view, the default-view rule, the "Where they go"
legend that doubles as the key map, session pace, and the phone stage rows. From board-first
we take the **adaptive ledger** (a 52px "Sorted 0 of 411 · Start triage" strip before any
money exists, and a full ledger with "Follow up now" and bucketed "Next up" once money
exists), dropping the funnel bar, the **fit-grouped New column** with "Select N" per group,
the **sticky end-stage pill**, empty-column **drop zones with a one-line meaning**, setup
folded into the title row, and the **phone 411 layout** (Sorted card, stage pills, triage
takeover). Both designs agree on the rest: no rails, two-line cards, no "Other", and bulk moves
through the existing bulk endpoint.

### Why this split
| Question | Triage-first | Board-first | Pick |
|---|---|---|---|
| Working through 411 New | A dedicated view with a queue, one investor, big targets and session pace. Calm and fast. | Triage happens inside a 400px card in the New column, so only about 5 other cards stay visible and the 7 empty columns still use two-thirds of the screen. | **Triage-first.** The board is the wrong place to make 411 decisions. |
| Bare-digit writes | Only inside Triage. | On the board too, which breaks SYSTEM §4.3. | **Triage only.** The board keeps §4.3 (Alt+→, M). |
| Ledger at $0 | A mono one-liner in the title row, which is easy to miss. | A 52px strip with Sorted progress, a "start with these" sentence and the one primary button. | **Board-first.** It says what to do next. |
| Ledger once money exists | Committed + funnel + 3 named Next-up rows. | Committed (with a soft tint) + Follow up now + bucketed Next up, and no funnel. | **Board-first.** The column headers already show the counts, and buckets scale where three names do not. |
| Mature cards | Two lines, plus a hot/warm colored square. | Two lines with a type label, and sometimes two chips that truncate the firm ("Cin… $200k soft Overdue"). | **One slot per card** (§5.3): neither the square nor two chips. The fit pips already carry priority. |
| Empty stages | A full-height dashed zone with a long sentence. | A short dashed zone: "Drop here" + a meaning. | **Board-first copy**, without the key badge (keys only work in Triage). |
| Phone | Triage segment in the header, stage accordion. | A Sorted card + Start triage, stage pills, and a full-screen triage takeover. | **Board-first layout**, with triage-first's three equal stage buttons (no cobalt bias toward one stage). |

Rejected outright: the board-first inline expanded triage card, the "Group: Fit" control (the
grouping is automatic, §5.4), bare digits on the board, the hot/warm square marker, the funnel
bar on the pipeline page (it stays on Overview), and triage-first's single-key T/M/W/D
follow-up keys (they clash with the sheet's `f` then `m` chord; see §6).

---

## 2. Definitions (used everywhere below)

- **Open stage `O`**: the round's first stage by `position` with `kind = "open"` (New). If
  there is none, Triage does not exist for the round.
- **Won stage / lost stage**: `wonStage(round)` and `lostStage(round)` (Committed and Passed).
- **Sorted**: a participant whose stage is not `O`. "Sorted 37 of 411" = total minus `|O|`.
- **Money exists**: `sum(amount_soft) + sum(amount_committed) > 0` over the round, **or** at
  least one participant is in the won stage.
- **Dominant stage**: a stage holding **≥ 60% of the round and ≥ 50 investors**.
- **Priority groups** (SYSTEM §2.2 words): Hot = fit 5, Warm = fit 4, Maybe = fit 3, Low fit =
  fit 0–2. Inside Low fit, rows sort by fit descending, so fit 0 comes last.
- **Hidden values**: the industry "Other" (case-insensitive) and the investor type `other` are
  **never rendered** as a chip or label anywhere (cards, rows, sheet header, triage, phone).
  They stay as filter values in the Filter menu, where they are labelled "Other".
- **Triage targets**: every stage except `O`, in `position` order, numbered **1–9** (more than
  9 targets: the 10th and later have no key and are reached through "Other stage…"). With the
  default stages: 1 Researching, 2 Contacted, 3 Replied, 4 Meeting, 5 Diligence, 6 Committed,
  7 Passed. **Primary targets** are the first two targets plus the lost stage (Researching,
  Contacted, Passed). The rest are secondary.
- **Default stage meanings** (empty drop zones, keyed by the default stage `key`; a custom
  stage gets no meaning line): Researching "Worth a closer look", Contacted "You reached
  out", Replied "They wrote back", Meeting "On the calendar", Diligence "Reading the data
  room", Committed "Signed or wired", Passed "Not this round".

---

## 3. Which view opens

Views: `triage | board | table` in `?view=`. On phones (<640px) the views are `list | triage`
(§7).

Resolution order, the first match wins:
1. An explicit `?view=` in the URL.
2. The viewer's stored choice for this round: `localStorage["rb-view:<ws>:<round>"]`, written
   only when the person clicks a view in the Segmented control, never by the auto rule
   (try/catch, as everywhere).
3. **Auto rule**: `O` is the dominant stage **and** the viewer can write → `triage`.
4. Otherwise `board`.

When the auto rule picked Triage, the title row shows a mono note (micro, muted):
- every participant in `O`: "All 411 are New, so the round opens in Triage."
- otherwise: "318 of 411 are New, so the round opens in Triage."

It shows only for the auto pick, not after an explicit choice.

The Triage segment exists only when `|O| > 0` and the viewer can write. When the last
investor leaves `O` while the person is in Triage, the view stays and shows the done state
(§4.7).

`T` (page key, `blockedByModals`, not in fields) switches to Triage from Board or Table.

---

## 4. Desktop: Triage view (≥ 1024px)

### 4.1 Layout
```
Title row (40px):  Seed  SAFE · $16M CAP   [Triage 411 | Board | Table]   All 411 are New, so…     SET UP 1/4 Invite a co-founder   [Add investor C]
14px
┌ Queue 360px ─────────┐ ┌ Investor (1fr) ─────────────────────────────┐ ┌ Rail 280px ─────┐
│ TRIAGE QUEUE  0 of   │ │ 1 of 411 in New · highest fit first  ↑ ↓   │ │ THE ROUND        │
│ 411 sorted  [Filter] │ │                         Open full page ↗    │ │ WHERE THEY GO    │
│ ▬▬▬▬ progress        │ │ Ada Prentice                                │ │ START HERE /     │
│ [All 411][Hot+Warm 40│ │ Venture Partner · Redwood Fund              │ │ THIS SESSION     │
│ [Maybe 95][Low fit…] │ │ chips · links · facts · notes · next step   │ │                  │
│ HOT · FIT 5  12 left │ │ (scrolls)                                   │ │                  │
│ rows…  (windowed)    │ ├─────────────────────────────────────────────┤ │                  │
│                      │ │ WHERE DOES ADA GO?  (pinned to the bottom)  │ │                  │
│ footer: tail offer   │ └─────────────────────────────────────────────┘ └──────────────────┘
```
- Grid `360px minmax(0,1fr) 280px`, gap 16. The page stops scrolling (like the board): the
  three columns fill the viewport height under the title row, and each scrolls on its own.
- Queue and Investor panes are `surface` with a 1px line and radius 8. The rail is plain
  canvas with `label` section heads and 1px rules (no box, so there are no nested boxes).
- 1024–1279px: the rail is removed. "Where they go" becomes a one-line strip under the
  investor header (StageDot + count per stage, the keys are already on the buttons), and the
  session line moves into the queue header.
- 640–1023px: the queue folds behind a "Queue 411" secondary button (opens a left Sheet), and
  the investor pane is full width.
- The title row has **no saved-views strip** in Triage (saved views filter the Board and the
  Table). "Add investor" is **secondary** here: there is no primary button in Triage, since
  the decision buttons are the work.
- The "Get set up" checklist is never a full-width row on this page any more (§5.1).

### 4.2 Queue (left)
- Header: label "TRIAGE QUEUE", mono micro "0 of 411 sorted" (mid-session: "16 of 411 sorted ·
  2 skipped"), and a 28px "Filter" secondary button. It opens the same FilterMenu as the board
  without the `F` key hint, because `f` is follow-up in Triage. Under it is a 4px Meter
  (`good` fill) of sorted / total.
- Pills (Segmented-pill style like the saved views): **All 411 · Hot + Warm 40 · Maybe 95 ·
  Low fit 276**. Counts are the undecided count in `O` for that slice. URL `tq=all|hw|maybe|low`.
- Group headers, sticky, `sunk` 32px: label type "HOT · FIT 5", right mono "12 left", and on
  hover/focus-within a "Select 12" link button (selects every undecided row in the group).
  Groups: Hot, Warm, Maybe, Low fit. An empty group is omitted.
- Row (44px, windowed through `useVirtualRows`, two-line max but normally one line): checkbox
  (shown on hover, focus or when anything is selected) · **name** (500, fg) · firm (muted,
  ellipsis) · right: type in mono muted (omitted for `other`) + FitMeter pips. No chips.
- Current row: `accent-soft` + 2px inset accent left rule (Table's selected style).
- **Decided this session**: the row stays in place, name in `muted` (no strikethrough), and the
  right side becomes StageDot + the new stage label. Skipped: mono muted "Skipped". Decided
  and skipped rows are not counted in "left". A reload drops decided rows (they are no longer
  in `O`).
- Order: priority group, then fit desc, then `created_at` asc (import order), then name.
- Footer (sticky, `sunk`, only while there are ≥ 20 undecided fit-0 investors): "**86 have fit
  0.** Select them to move them in one go." + [Select 86] secondary. (Fit 0 is the column
  default, so it often means "not scored". The copy does not say "pass".)

### 4.3 Investor pane (center)
Header bar (44px, 1px rule under it): mono "1 of 411 in New · highest fit first" with ↑ ↓
buttons (Kbd hints), and on the right "Open full page ↗" (investor page, new tab).

Body (scrolls, padding 24/32):
1. Name `display-s` at 28px (the triage stage is the one exception to the 22px sheet title, as
   the subject of the screen). The subline "Title · Firm" is muted.
2. One chip row: priority chip + FitMeter + mono "5/5"; type chip (not for `other`); industry
   chips, minus "Other", at most 3 then "+2"; and the `source` as a tag chip when it is set.
3. LinkButtons: email · copy, LinkedIn ↗, Website ↗, X ↗, only those present. When none of
   LinkedIn/website is present: "Search LinkedIn ↗" (a plain link to LinkedIn's people search
   with `name firm`; a user click, not a runtime request).
4. Two columns at ≥ 1280 (stacked below): **FACTS** (DefList: Invests at, Check size, Location,
   Source, Warm intro by, Other rounds) and **NOTES** (investor notes, read-only, pre-wrap, max
   8 lines then "Show all"). **Only rows with a value render.** When there are no facts and
   no notes: one muted line, "Only the basics came in with the import. Open LinkedIn to look
   them up." Never sample or placeholder data.
5. **NEXT STEP**: an Input with placeholder "Optional, e.g. ask Harper for an intro" (use the
   fictional sample names only in placeholders) and a Kbd `N` hint. It saves on blur or Enter
   (`updateParticipant next_step`) with the mono "Saved" in good. Enter does not advance.
6. **HISTORY**: the latest 3 activities (Timeline, compact), e.g. "Oct 11 You imported Ada from
   sf-tech-week-411.csv with 410 others" (the collapsed import run).

Decision panel (pinned to the bottom of the pane, `sunk` background, 1px top rule, padding
16/32):
- Label "WHERE DOES ADA GO?" (first name) + mono micro "one key, then the next investor
  opens".
- Row 1: the **3 primary targets** as 44px secondary buttons in equal thirds: StageDot + stage
  label (500, 15px) + Kbd key on the right. The first one gets keyboard focus when the
  investor loads (focus ring = accent outline, as in the mockup).
- Row 2: the **secondary targets** as 36px buttons in equal widths (up to 5 per row, wrapping).
  More than 9 targets: the overflow goes into an "Other stage…" Menu.
- Row 3: label "FOLLOW UP" + DateField quick picks as 32px toggle buttons: **None · Tomorrow ·
  Next Mon · In 1 week · Pick…**, with the Kbd chord hint (`f 1`, `f m`, `f 7`, `f d`). The
  current value is pressed (`aria-pressed`). Setting it saves immediately (`setFollowUp`) and
  does **not** advance.
- Hint line (micro, muted): `S` Skip for now · `U` Undo · `[` `]` Fit · `X` Select · `↵` Open
  file · `L` LinkedIn. On the right: "Moves save instantly, with Undo."

### 4.4 Rail (right)
1. **THE ROUND** (mono micro, 2 lines): "$0 of $2,000,000 · nothing due" / "SAFE · $16M cap ·
   closes Jan 15 · 95 days". When money exists, the amount is in `good-ink`.
2. **WHERE THEY GO** with the label "key" right-aligned: one row per stage (32px): Kbd key (none
   for `O`), StageDot, label, mono count right-aligned, and for this session a mono `+6` in
   `good-ink` when > 0. `O` is first, with its live count. A row is a button that moves the
   current investor (same as its key). This replaces the funnel bar.
3. **START HERE** (before the first decision this session): "**40 are Hot or Warm.** Deciding
   those first takes about 15 minutes; the board fills in as you go." (Estimate: 20s per
   investor, rounded to 5 minutes. When Hot+Warm is 0, it names the largest non-empty group
   instead.)
   **THIS SESSION** (after the first decision), with the Undo shortcut `U` on the right: "16
   sorted in 6 min. At this pace the rest of New takes about 2h 40m. The 24 left at Hot +
   Warm take about 10 min." The pace is the median of the gaps between decisions, each gap
   capped at 120s; it shows from the 5th decision on (before that: "16 sorted in 6 min.").
   The session lives in memory and resets on reload.

### 4.5 Behavior
- **A decision** (key, button or rail row): optimistic. The client store moves the
  participant, the row marks itself decided, and the next undecided, unskipped row in the
  current slice opens within the same frame. Then `POST …/participants/{id}/stage` runs. The
  toast reads "Ada Prentice moved to Researching." with [Undo] (8s), and the polite live region
  says the same thing.
- **Undo** (`U`, or the toast action) reverts the **last** decision completely: the stage, plus
  any follow-up, next step or fit changed during that investor's turn. It sends one
  `bulk-update` `op: "restore"` with the snapshot taken when the investor opened, and goes back
  to that investor. Up to 20 undos are kept in the session stack.
- **Skip** (`S`): marks the row "Skipped" and advances. Nothing is written. When the slice runs
  out of undecided rows and some were skipped: "You skipped 2. [Go through them]".
- **Fit** (`[` lowers, `]` raises): saves immediately and does not advance. The row stays in
  its group until reload (no jumping).
- **Failure**: revert the store and show the error toast "Couldn't move Ada Prentice.
  `error.code` [Retry]". The queue goes back to that investor.
- **Concurrency**: if the store gets a newer `updated_at` that moves an investor out of `O`
  (a co-founder or an agent did it), the row shows its new stage with the agent diamond when
  an agent made the change, and the cursor skips it.
- **Prefetch**: the queue has only the trimmed rows. The pane needs the full investor plus the
  latest activities, so fetch the current one and **prefetch the next 2** (keep a 10-investor
  LRU). Switching investors must not wait on the network when they were prefetched.
- **URL**: `?view=triage&tq=hw&at=<investor_id>` via `replaceState`, so a reload resumes on the
  same investor. `?investor=` still opens the full sheet on top (Enter), and closing it returns
  to Triage with focus on the decision panel.

### 4.6 Bulk in Triage
- `X` toggles the current row. Shift+click or Shift+J/K extends the selection; "Select N" on a
  group header or the tail footer selects the whole group.
- With ≥ 1 selected, the investor pane becomes the **selection pane**: the title is
  "86 selected", the subline is a breakdown ("86 at fit 0 · 61 VC, 25 Angel"), and the same
  decision panel ("WHERE DO THEY GO?") is underneath, using the same keys. One key → **one**
  `bulk-update` (`op: "stage"`, plus `op: "follow_up"` when a pick was set first) → toast
  "Moved 86 investors to Passed." [Undo] → the selection clears and the cursor goes to the next
  undecided row. Esc clears the selection.

### 4.7 States
- **Fresh** (0 sorted): as in `triage-first/after-triage-1440-light.png`, with the §4.3 content
  rules.
- **Mid-session**: as in `after-triage-1440-dark-midsession.png`.
- **Slice done**: the pane shows EmptyState "Hot and Warm are sorted." / "271 are still New.
  Keep going with Maybe, or open the board." [Continue with Maybe] [Open board].
- **All done** (`|O| = 0`): EmptyState "Everyone in Seed is sorted." / "411 sorted. 23 are
  Contacted." [Open board]. The Triage segment disappears on the next visit.
- **Loading the full investor** (not prefetched): the name, firm, chips and decision panel come
  from the row at once. Facts and History show static Skeleton bars (no shimmer) up to 300ms,
  then "Loading…".

---

## 5. Desktop: Board view

### 5.1 Above the board
**Title row (40px)**: "Seed" + mono "SAFE · $16M CAP" · Segmented [Triage 411 | Board | Table]
(the Triage segment as in §3) · the saved-views strip (All · Due now `5` · My investors · Hot ·
⋯). The Due now count is mono `bad-ink` when > 0 and hidden at 0. On the right: **"SET UP 2/4"**
(label type) followed by the next unchecked step as a link ("Invite a co-founder"), and a
Menu (click on "SET UP 2/4") listing all 4 steps with checks plus "Dismiss". It is gone once
4/4 or dismissed. Then "Edit round".

**Ledger, compact strip** (when money does **not** exist). It is 52px, one row, `surface` with
a 1px line and radius 8, with cells separated by 1px rules:

| Cell | Content |
|---|---|
| Target | label "TARGET" + **$2,000,000** (Bricolage 700, 16px tabular) + muted "· closes Jan 15, 95 days" |
| Sorted | label "SORTED" + 160px Meter + "**0** of 411" |
| Message (flex 1) | the first matching line: (a) Hot+Warm undecided in `O` > 0: "**40 Hot and Warm** are still New. Start with them." (b) `O` > 0: "**371** are still New, highest fit first." (c) `O` = 0: "Everyone is sorted. **3** follow-ups due today." / "Everyone is sorted. Nothing due." |
| Money | mono label "$0 COMMITTED" in muted |
| Action | **[Start triage `T`]**, the view's one primary button, in cases (a) and (b). In (c) there is no button and "Add investor" goes back to primary. |

**Ledger, full** (when money exists). It is `surface`, bordered, radius 8, with a grid of
`1.3fr 1fr 1fr` and 1px rules between the cells (stacked below 1100px: Committed full width,
then the two lists side by side):
- **COMMITTED TOWARD SEED**: `amount` "$650,000" + "of $2,000,000" · an 8px Meter where
  committed is filled `good` and soft is stacked after it in `color-mix(in oklab, var(--good)
  30%, var(--sunk))`, with `title` "$400k soft" · stats "**$400k** soft · **23** talking ·
  **4** committed · **41** days left". "Talking" means stages of kind `active`.
- **FOLLOW UP NOW** + "All 6 →" (applies the Due now view): up to 4 rows, overdue first and
  then today. Each row: StageDot · name (500) · next step or follow-up note (muted, ellipsis)
  · right mono `bad-ink` "Overdue 4d" / "Today". A row opens the sheet. Empty: "Nothing due.
  Next: Kai Merriman, Oct 14." (or "Nothing due." when no follow-ups exist).
- **NEXT UP**: up to 4 bucket rows. Each has a mono count, a sentence and a link on the right.
  A bucket with 0 is hidden:
  1. "**7** Hot or Warm still New" → "Triage →" (Triage, `tq=hw`)
  2. "**5** gone quiet, 14+ days with no activity" → "Show →" (adds the filter `follow=quiet`:
     an `active`-kind stage, `last_activity_at` (else `stage_changed_at`) older than 14 days,
     and no follow-up today or later)
  3. "**9** talking with no follow-up set" → "Show →" (`follow=none` + `kind=active`)
  4. "**38** still New" → "Triage →". Shown only when it differs from bucket 1's population.
  All zero: "Nothing waiting on you."

**No FunnelBar** on the pipeline page in either ledger state. The Overview keeps the full Ledger
with its funnel.

**Toolbar** (unchanged from P1-4): search · Filter F · Display · mono count ("411 in New",
"411 investors") · on the right Add investor C (primary unless Start triage is on screen). The
Board/Table switch moves to the title row. "Triage `T`" is never in the toolbar.

### 5.2 Columns
- **No rails, ever.** Delete the collapsed and rail code path (`Board.tsx collapsed`,
  `PipelineBoard collapsed()`).
- Track widths, as a grid that scrolls horizontally inside the board container:
  - the dominant stage (§2): `minmax(352px, 2.5fr)`
  - any other non-empty stage: `minmax(232px, 1fr)`
  - an empty stage: `minmax(136px, .6fr)`
  - gap 12. At 1440 with all 411 in New, all 8 columns fit with no horizontal scroll.
    Mature rounds scroll sideways, and cards never shrink below 232px.
- Header (sticky, 40px, 3px stage-color top rule): StageDot · label 600 13px · mono count ·
  right: due count ("2 due", mono `bad-ink`, when > 0) · sort Menu ("Fit ↓"). The won stage
  shows its total "$650k" in `good-ink`. `O` shows **"Triage →"** (accent link) when `|O| >
  0` and the viewer can write.
- **Empty column**: the column stays `sunk` and full height (the whole column is the drop
  target). At the top is a 96px dashed `line` box, radius 8, padding 10: "Drop here" (muted
  500) and the stage meaning (§2, body-s muted, wraps). Viewers see "Nothing here yet". While
  dragging, every valid column gets the 2px dashed accent outline and its box reads "Drop 14"
  (the count being dragged).
- **Sticky end pill**: when the won or lost column is scrolled out of view to the right, a pill
  floats at the bottom-right of the board (surface, 1px line, menu shadow, 32px): "● Committed
  $650k 4 · ● Passed 230 →". Clicking it scrolls them into view. It hides once they are
  visible.

### 5.3 Card (two lines, 52px; replaces BoardCard standard and compact)
```
┌───────────────────────────────────────┐
│ Ugo Fenwick ◆                  ▮▮▮▮▮ │   line 1: name 600 13.5px ellipsis · agent diamond (if recent) · FitMeter pips (no label)
│ Ember Labs                Overdue 2d │   line 2: firm body-s muted ellipsis · ONE right slot
└───────────────────────────────────────┘
```
- Line 2 left: the firm; else the title; else the type label; else nothing.
- **The right slot shows exactly one item, chosen in this order:**
  1. follow-up overdue → chip `due` "Overdue 4d"; today → chip `due` "Today"
  2. won stage → chip `money` "$250k" (and in the won stage the pips on line 1 are hidden)
  3. soft amount > 0 → mono muted "$150k soft" (no chip: soft is not real money)
  4. follow-up in ≤ 7 days → chip `soon` "Oct 14"
  5. a later follow-up → mono muted "Oct 24"
  6. the type in mono muted ("VC", "Angel", "CVC"); never for `other`
- **Gone from cards**: the priority chip (the pips carry fit), the type chip, industry chips,
  tag chips and the hot/warm square.
- Display menu: "Show next step" adds line 3 (body-s muted, one line), making the card 70px.
  This replaces the Standard/Compact toggle. Saved per viewer.
- Unchanged: hover gives an accent border, focus has an inset ring, the dragged card gets the
  shadow, and the agent diamond with its tooltip stays.
- Selected: `accent-soft` fill + 1px accent border + a checkbox at the far left of line 1
  (shown on hover/focus or while anything is selected).

### 5.4 Dominant column extras (the 411 board)
Only when the column is the dominant stage **and** `O`:
- Under the header: a 6px stacked bar of the priority groups (`hot`, `warm`, `maybe`, `line`
  fills, radius pill) and a legend "Hot 12 · Warm 28 · Maybe 95 · Low fit 276". Each legend
  item is a button that filters to that priority (`prio=`).
- Cards are grouped by priority with sticky group headers ("HOT · FIT 5 12", right
  "Select 12"). This is automatic. There is no Group control.

### 5.5 Board keyboard (SYSTEM §4.3 stays)
Roving focus, ↑↓/j k, ←→, Enter opens, `Alt+→/←` moves (skipping lost), `M` opens Move to…,
and `X` toggles selection on the focused card. Shift+click or Shift+↓ extends within a column,
and Esc clears. **No bare-digit writes on the board.** Inside the Move to… Menu, digits pick
items as menu accelerators, so `M` then `7` files a card in Passed.

### 5.6 Bulk bar (shared by Board and Table)
The existing P1-6 bulk bar moves out of the toolbar into a bar pinned to the bottom of the work
surface (surface, 1px line, menu shadow, radius 8, 48px, centered, max 960px). It calls
`useToastLift`. Content: "**14 selected**" · Move to… `M` · Follow up `D` (DateField picks) ·
Owner · Fit · Tag · Remove from round · Export CSV · Clear `Esc`. Each action is one
`bulk-update` with an Undo toast. Dragging any selected card drags the whole selection.

### 5.7 Table view
Unchanged from P1-2 except: the bulk bar (§5.6), type `other` → "—" (already the case),
industries never show "Other", and the strip/full ledger rule (§5.1) applies here too.

---

## 6. Keyboard map (all through `useHotkey`; nothing fires in fields)

| Key | Triage | Board | Table |
|---|---|---|---|
| `1`–`9` | file the current investor (or the selection) in target N, then open the next | — | — |
| `S` | skip | — | — |
| `U` | undo the last decision | — | — |
| `F` | opens the follow-up DateField; then `1` tomorrow, `m` next Monday, `7` in 1 week, `d` (focuses the typed date) | Filter | Filter |
| `[` / `]` | fit −1 / +1 | — | — |
| `N` | focuses Next step | — | — |
| `X` | select the row | select the card | select the row |
| `J`/`K`, `↓`/`↑` | move the cursor without deciding | §4.3 | P1-2 |
| `Enter` | open the full sheet | open the sheet | open the sheet |
| `L` | open LinkedIn ↗ (new tab) | — | — |
| `M` | — | Move to… menu | — |
| `T` | — | switch to Triage | switch to Triage |
| `Esc` | clear the selection | clear the selection | clear the selection |

Notes: the `f` follow-up chord matches the sheet (`f` then `m` = next Monday, SYSTEM §4.4),
which is why triage-first's single keys T/M/W/D are not used. Bare-digit writes exist **only
in Triage**. That view is an explicit sorting mode where every write is undoable and announced
(the documented exception to §4.3). Every Triage key is registered with `group: "Triage"` and
a description, so `?` lists it. The sheet's keys (priority 1) win while it is open.

---

## 7. Phone (< 640px)

### 7.1 List (the default phone view; there is no board on phones)
Top to bottom:
1. Title "Seed" + mono "SAFE · $2M TARGET" (mature: "SAFE · 39 DAYS LEFT") + "Edit".
2. **Before money exists, the Sorted card**: label "SORTED" + Meter + "**0** of 411", then
   "**40 Hot and Warm** are waiting. Start with them.", then a full-width 48px primary
   **Start triage** (the strip's message rules from §5.1). When `|O| = 0` the button
   disappears.
   **Once money exists**: the compact ledger card ($850,000 of $2M, the meter with the soft
   tint, "5 committed · $600k soft · 55 talking").
3. Mature only, when something is due: **FOLLOW UP NOW** card, up to 3 rows (name, StageDot +
   stage, right chip "Overdue 4d"/"Due today") + "All 6 →".
4. **Stage pills** (horizontal scroll, 40px): "Due now 6" (only when > 0), then every stage
   "● New 411", "● Researching 0", and so on. The selected pill is `fg` filled. The default
   selection is Due now when > 0, else the first stage with investors. URL `stage=`.
5. Search + Filter (sheet).
6. List of the selected pill: ruled rows (56px) with the §5.3 card anatomy. On `O` with ≥ 50
   rows, it is grouped by priority with headers and "Select" per group; the header row of `O`
   also has "Triage →". Windowed. A tap opens the full-width sheet. Long-press or a checkbox
   tap starts selection, and the bulk bar sits at the bottom.
7. Mature only: a **NEXT UP** card with the §5.1 buckets (max 3).

### 7.2 Triage takeover
`?view=triage` on a phone renders a full-screen view (no top bar):
- Header (56px): a 40px "✕" (back to List) · "Triage" · mono "1 of 40 · Hot + Warm" · Filter.
  A 3px progress bar sits under it.
- Card (surface, bordered): priority chip + pips + "5/5", with "● New" on the right · name
  (display-s 24) · "Title · Firm" · chips per §4.3, minus Other · facts that have values ·
  LinkButtons.
- "+ Next step" (expands into the input) · **UP NEXT**: the next 3 names with pips.
- **Bottom bar** (fixed, safe-area padding, surface, 1px top line): row 1 has the 3 primary
  targets as **equal 48px secondary buttons** with StageDot + the stage label (ellipsis; no
  primary fill, so the UI favors no stage). Row 2 has 40px ghost buttons: Skip · Follow up
  (opens the DateField sheet) · Other stage (a bottom-sheet Menu of all targets). Under them,
  in micro muted: "Each tap saves, opens the next investor and offers Undo."
- The toast lifts above the bar (`useToastLift`). There are no swipe gestures (too easy to
  trigger by accident, and not accessible).

---

## 8. Acceptance criteria

Fixtures: add `uv run rbctl seed-demo --preset import411` (411 fictional investors all in New;
fit 5: 12, 4: 28, 3: 95, 0–2: 276 including 86 at fit 0; about 30% industry "Other"; mixed
types including `other`; $2M target, 95 days; no notes or check sizes, as with a real CSV)
and `--preset mature` (New 38 · Researching 64 · Contacted 52 · Replied 14 · Meeting 9 ·
Diligence 0 · Committed 4 ($650k) · Passed 230; $400k soft; 2 overdue, 1 due today, 1 agent
move in the last 24h). Everything is fictional and uses example.com. Screenshots go in
`design/screens/pipeline-redo/` at 1440×900 light and dark, 1024×768, and 390×844.

### 8.1 The 411 state, desktop
- [ ] A first visit to the round opens **Triage** with "All 411 are New, so the round opens in
      Triage." After clicking Board, a reload opens Board. `?view=table` always wins.
- [ ] A viewer (read-only) lands on Board, sees no Triage segment and no Start triage.
- [ ] Triage at 1440×900: the queue, the investor pane and the rail all show without page
      scroll. The decision panel is fully visible without scrolling the pane. The queue shows
      ≥ 15 rows.
- [ ] No "Other" text appears anywhere on the screen (industry or type) in Triage, Board,
      Table chips or the sheet header.
- [ ] No sample data: with the import411 fixture, the investor pane shows no Invests at,
      Check size, Location or Notes rows, and shows the "Only the basics…" line instead.
- [ ] Keyboard only: filing the 40 Hot + Warm takes exactly one key each (`2` or `7`). After
      each key the next investor is on screen within 50ms (optimistic), and 40 POSTs
      complete. "Where they go" shows the `+N` per stage. `U` restores the last one, stage and
      follow-up included.
- [ ] `f` `m` sets next Monday in the workspace timezone without advancing. Then `2` files
      the investor, and Undo clears both.
- [ ] Select 86 (fit 0) → `7` sends **one** bulk-update request and shows one toast, and Undo
      restores all 86.
- [ ] Prefetch: moving to the next investor makes no blocking request (the network log shows
      the prefetch already done). Switching investors takes ≤ 100ms with 4× CPU throttle.
- [ ] Board at 1440×900 with the fixture: **8 columns visible, no rails, no horizontal
      scroll**. New is ≥ 352px with the priority bar and groups, and each empty column shows
      "Drop here" + its meaning. The first card is at y ≤ 330.
- [ ] Ledger is the 52px strip: Sorted 0 of 411, "40 Hot and Warm are still New. Start with
      them.", and [Start triage T] as the only primary button. No FunnelBar and no full-width
      "Get set up" row (it is "SET UP 1/4" in the title row).
- [ ] Cards are 52px with exactly two lines and at most one right-slot item. No priority,
      type or industry chips.

### 8.2 The mature state, desktop
- [ ] Board opens by default (New is 9%, below the rule). The Triage segment shows "38".
- [ ] The full ledger shows "$650,000 of $2,000,000", the meter with committed plus the soft
      tint, Follow up now (2 overdue then 1 today, matching the Due now count), and Next up
      buckets that each apply the right filter when clicked (counts match the filtered
      result).
- [ ] Columns are ≥ 232px. The board scrolls sideways. The end pill "Committed $650k 4 ·
      Passed 230 →" shows while those columns are off screen and scrolls to them. Diligence
      (empty) is 136px with "Drop here / Reading the data room".
- [ ] No firm name is truncated by a second chip: every card has at most one right-slot item.
- [ ] Selecting 2 cards shows the bottom bulk bar, `M` `7` moves both in one request, and the
      toast sits above the bar.
- [ ] Bare digits on the board do nothing. Alt+→ still moves the focused card and announces it.

### 8.3 Phone (390×844)
- [ ] 411 state: the Sorted card with a full-width Start triage is above the fold, the stage
      pills scroll sideways, and the New list is grouped by priority with Select per group. No
      horizontal page scroll.
- [ ] Triage takeover: the 3 stage buttons are ≥ 48px tall and sit inside the safe area, and
      a tap files the investor and shows the next with an Undo toast above the bar. ✕ returns
      to List on the same scroll position.
- [ ] Mature: the compact ledger, Follow up now (3 rows + All 6), stage pills starting on
      "Due now 6", and the Next up card.

### 8.4 Cross-cutting
- [ ] Dark mode is checked for Triage (fresh and mid-session), the 411 board and the mature
      board. All text is ≥ 4.5:1; `*-ink` tokens are used for text on tints.
- [ ] `?` lists every Triage key under "Triage". No key fires while typing in Next step or
      search.
- [ ] Each move announces itself through `aria-live` ("Ada Prentice moved to Researching").
      The decision buttons are real `<button>`s with an `aria-keyshortcuts` attribute.
- [ ] Filter, pill, view and cursor changes send 0 requests (P1-1 holds). The URL updates via
      `replaceState`.
- [ ] `npm run lint && npm run typecheck && npm run build && npm run test:unit` pass. Unit
      tests cover `defaultView()`, `moneyExists()`, the card right-slot precedence, the
      Next up bucket counts, the triage cursor (next undecided, skip wrap) and the pace
      estimate.
- [ ] Backend: only `seed-demo` presets change. No new endpoint (Triage uses `…/stage`,
      `…/follow-up`, `PATCH participant` and `bulk-update` with `restore`).

---

## 9. Build plan and file ownership

| # | Work | Files | Size |
|---|---|---|---|
| 1 | Pure logic + tests: `defaultView`, `moneyExists`, `dominantStage`, `triageTargets`, `cardSlot`, `nextUpBuckets`, `paceEstimate`, the `isHiddenValue("Other")` helper | `web/lib/pipeline.ts`, `web/lib/pipeline.test.ts` | S |
| 2 | Board: delete the rails; track widths; empty drop zone; end pill; two-line card with one slot; priority bar and groups on the dominant `O` | `components/ui/Board.tsx`, `components/app/PipelineBoard.tsx` | M |
| 3 | Adaptive Ledger: `variant="strip"` and the full pipeline variant with Follow up now and Next up; no funnel on the pipeline page | `components/ui/Ledger.tsx`, `Pipeline.tsx` | M |
| 4 | Title row: Segmented with Triage, the view rule and note, SET UP in the title row, saved views with the Due now count; bulk bar to the bottom | `Pipeline.tsx`, `RoundHeader.tsx` | M |
| 5 | Triage view: queue (windowed, groups, pills, tail offer), investor pane with prefetch and LRU, decision panel, rail, keys, undo stack, bulk selection pane, states | new `components/app/PipelineTriage.tsx` (+ `TriageQueue.tsx`) | L |
| 6 | Phone: Sorted card, stage pills, grouped list, triage takeover | `Pipeline.tsx` (phone branch), `PipelineTriage.tsx` | M |
| 7 | `follow=quiet` filter value; hide "Other" in the sheet header and the table | `Pipeline.tsx`, `InvestorSheet.tsx`, `PipelineTable.tsx` | S |
| 8 | `seed-demo --preset import411|mature`, screenshots, the SYSTEM.md edits below | `backend/raisebook/cli…`, `design/` | S |

Order: 1 → (2, 3, 4 in parallel) → 5 → 6 → 7 → 8. The view is behind no flag; it ships with
the auto rule on.

**SYSTEM.md edits on merge:**
- §3.10 Ledger: add the strip variant and the money rule, and drop the FunnelBar from the
  pipeline variant.
- §3.12 BoardColumn: replace "Empty columns fold into thin rails" with §5.2.
- §3.13 BoardCard: replace with §5.3.
- §4.2: add the Triage view, the default-view rule, SET UP in the title row and the bottom
  bulk bar.
- §4.3: add "Bare digits write only in Triage (an explicit sorting mode; every write is
  undoable and announced)".
- §2.4: add "The industry 'Other' and the type `other` are never rendered as chips".
- UX-PASS-1 P1-3's rail line is superseded.
