# UX pass 1: screenshots and reproducible checks

Screenshots per item are named `<WS>-<item>--{light,dark,mobile}.jpg`. The final route sweep
(every route, light, dark and 390px) is in `design/screens/final/`. Every check below runs
against a local API and a production web build with a throwaway database and fictional data
only. Browser checks use `playwright-core` with the system Chrome, from a scratch folder
(never added to `package.json`).

## Integration run (2026-10-12)

Setup: database `raisebook_int`, API on :8140, web production build on :3140
(`NEXT_PUBLIC_ENABLE_DESIGN=1` for `/design`), `RAISEBOOK_RATE_LIMIT_BACKEND=off`. A generated
450-row fictional CSV (example.com emails, made-up names and firms) was imported through the
UI into a new "Halcyon Robotics" workspace created through onboarding.

Checked, all passing:
- Onboarding: timezone search "San Francisco", "PST", "bay area" → Los Angeles; "Yerevan",
  "yere" → Yerevan; "UTC+4", "+4" → Dubai, Yerevan, Tbilisi; "+5:30", "IST" → Kolkata first;
  "CET" → Berlin; "Kiev" → Kyiv; "sao paulo" → São Paulo. Currency: "€", "£", "dram",
  "armenia", "rupee", "yen", "franc". Browser zone Asia/Yerevan preselects Yerevan and AMD.
  Back to step 1 keeps Yerevan; changing only the zone to Berlin and Continue stores
  `Europe/Berlin`; a EUR first round makes `default_currency` EUR.
- Import: 450 rows + header, 16 columns, per-column empty/unreadable badges, the stage value
  panel ("Wired" suggested as Committed), review of all 450 rows, "Import 450 · 64 cells left
  empty"; 64 unknown types left empty with a warning.
- Pipeline at 450: board and table load in under 1s; search, the Filter menu (`F`) and
  sorting send 0 requests. Sheet: a stage change persists after close and reload; focus moves
  to the next row when the investor leaves the filter; history length does not change.
  A deep-linked sheet (`?investor=`) answers `f` `m` (next Monday) and `n` (log a note).
- ⌘K "silas" → Enter opens the sheet in about 110ms; `?` lists the live shortcuts; `g o`.
- Today queue: `j` `e` marks done and asks for the next follow-up; `s` opens snooze; the
  Undo toast sits above the prompt strip.
- Settings → General: the zone saves and survives a reload; "Use it" saves the browser zone.
- `/signin` and `/invite/<token>` show no Google button while it is not configured.

Fixed during integration:
- Combobox: keys typed on the trigger before the search box takes focus were dropped (fast
  typeahead "PST" searched "ST"); they now add to the query.
- Hotkeys: a deep-linked investor sheet lost `f` to the pipeline's Filter key (child effects
  register first). Registrations take a `priority`; sheet keys use 1.
- The Undo toast covered the Today queue's prompt strip and the directory's selection bar
  (`useToastLift`).
- `Segmented` labels wrapped and clipped at 390px (overview activity filter); they stay on one
  line and the strip scrolls.
- "Weighted pipeline : set a probability…" spacing.
- The invite page offers Continue with Google when it is configured.


## WS-B setup

```bash
createdb raisebook_uxb && psql raisebook_uxb -c 'create extension citext; create extension pg_trgm;'
cd backend
export RAISEBOOK_DATABASE_URL=postgresql://localhost/raisebook_uxb RAISEBOOK_ENV=dev
uv run alembic upgrade head
uv run rbctl workspace create --name "Halcyon Robotics" --owner-email founder.b@example.com
uv run rbctl apikey create --workspace <slug> --name seed --scopes read,write,admin
RAISEBOOK_PUBLIC_BASE_URL=http://localhost:8120 RAISEBOOK_APP_URL=http://localhost:3120 \
  RAISEBOOK_SESSION_COOKIE_SECURE=false RAISEBOOK_RATE_LIMIT_BACKEND=off \
  uv run uvicorn --factory raisebook.main:create_app --port 8120
# Round "Seed" + the 420-row fictional CSV (UX-PASS-1 §0) through POST /v1/imports with round=seed.
cd ../web && NEXT_PUBLIC_API_URL=http://localhost:8120 NEXT_PUBLIC_SITE_URL=http://localhost:3120 \
  npx next build && npx next start -p 3120
```

Sign in by script (puppeteer-core with the system Chrome, from a scratch folder): `POST
/v1/auth/magic-link`, open `dev_link`, press **Continue**, keep the cookies.

## P0-5: sheet edits persist (passed)

1. `/w/<ws>/r/seed?view=table&stage=contacted`, click the first row, press the **Diligence**
   stage pill, press Esc. Clear the filter: the row shows Diligence.
2. Open the same investor again (`?investor=<id>`), close with ✕: still Diligence, and
   `document.activeElement` is that row (`tr[data-investor=<id>]`).
3. Reload, open it: the sheet's active stage pill is Diligence.
4. Esc, then browser Back: the previous page (one step); the sheet does not reopen.
5. `?view=table&follow=due`: focus the first row, Enter, `f`, `7`, Esc. The count drops by one
   ("68 of 420" → "67 of 420"), the "Follow up now" strip updates, and focus lands on the next
   row still in the list.
6. Board: the same with a card (Enter opens, `f` `m` sets next Monday, `j`/`k` walk the
   column order, Esc closes and focuses the card). `history.length` does not change.

## P1-1: no requests while filtering (passed)

Count requests during: typing in search, F → ↓ → Enter → Enter (Fit is Hot), Backspace on
the chip. Result: **0** `_rsc` and **0** `/v1` requests. Pipeline HTML for 420 investors:
**520 KB**. DOM: about 2,050 nodes on the board, 1,500 in the table. Scrolling the table and
the 142-card Researching column with a 4× CPU throttle: **60 fps** (p95 frame 17 ms).

## P1-2 / P1-3: density at 1440×900 (passed)

After the page scrolls the ledger away (the board fills the viewport; only rows and columns
scroll): table Compact shows **22** full rows; the board shows **8** standard cards and
**13** compact cards in Researching (142 cards).

## P1-4: one-line toolbar (passed)

With three filters applied (`prio=hot&type=vc&follow=week`), "Add investor" is on the first
toolbar row at 1024, 1180, 1280 and 1440, and nothing scrolls sideways at 390.

## P1-6: bulk move with Undo (passed)

Table: focus the first row, `x`, Shift+↓ ×29 → "30 selected". Move to… → Passed: **one**
`POST …/participants/bulk-update`, one toast; Undo sends one `op: "restore"` request and every
row's stage is back. ⌘A selects all 420 shown; Esc clears.

## P2-1 / P2-3 / P2-4

- Views: "Due now" sets `follow=due`; Save current view… (named "Meeting · Due now"), All,
  then ⌘⇧5 restores the saved query; after a reload the saved view is still active.
- Split sheet (≥1280): clicking another row swaps the file in place, ↓ moves the selection and
  the panel follows, Esc closes and focus stays on the row.
- Empty round (`/r/bridge`): the funnel is replaced by one line; the Get set up checklist ticks
  from real data and stays dismissed per workspace.
