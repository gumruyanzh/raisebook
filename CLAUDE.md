# Raisebook: working notes for agents

Raisebook (raisebook.org) is a free-forever, open-source (AGPL-3.0) fundraising CRM for
founders, with a first-class MCP server. Spec: `docs/SPEC.md`. Its **§0 decisions block
overrides the rest**: the package is `raisebook`, the env prefix is `RAISEBOOK_*`, the CLI is
`rbctl`, keys are `rb_live_` / `rb_test_`, and the scopes are `raisebook:read|write|admin`.
Design rules: `design/SYSTEM.md` (binding). Who edits what: `docs/OWNERSHIP.md`. raisebook.org
is live on one DigitalOcean droplet (`docs/DEPLOY.md`); only the owner deploys, so never deploy
and never touch DNS. The repo is public (github.com/gumruyanzh/raisebook); you do not push
unless asked.

## Layout
- `backend/` is the Python 3.12 project, managed by uv. The package is `backend/raisebook/`
  (import as `from raisebook.x import y`).
- `backend/alembic/versions/0001_init.py` holds the whole SPEC §3 schema: composite
  `(workspace_id, id)` FKs, CHECKs, partial unique indexes, and the `activities` append-only
  trigger.
- `web/` is Next.js 15 + React 19 + Tailwind v4. Tokens only, no component library.
- `deploy/` has the Dockerfiles, `docker-compose.yml` and `Caddyfile` (web at raisebook.org,
  API and `/mcp` at api.raisebook.org).
- `prototype.html` is the original single-file prototype and the design reference. It is
  read-only.
- `~/projects/smmist` is the sister project and a **read-only** reference. Copy and adapt its
  patterns (auth/session, api_keys, principal, mcp/server + auth, the tests/conftest
  harness); never import from it.

## Run (backend, always from `backend/`)
```bash
cd backend
uv sync
uv run pytest -q                                   # needs local Postgres 17 (below)
uv run ruff check . && uv run ruff format --check .
uv run mypy raisebook
RAISEBOOK_DATABASE_URL=postgresql://localhost/raisebook_dev uv run alembic upgrade head
RAISEBOOK_ENV=dev uv run uvicorn --factory raisebook.main:create_app --reload   # API + /mcp on :8000
uv run rbctl worker    # background jobs (research), beside uvicorn; --once drains and exits
uv run rbctl --help    # workspace | apikey | seed-demo --email | housekeeping | worker | secrets
```
Research needs `RAISEBOOK_RESEARCH_ENABLED=true` and `RAISEBOOK_SECRETS_KEK` (`uv run rbctl secrets gen-kek`); without it the app
works and research reports `research_unavailable`. Never point dev at real OpenRouter money:
run `uv run python scripts/mock_openrouter.py --port 8787` and set
`RAISEBOOK_OPENROUTER_BASE_URL=http://localhost:8787/api/v1` for both uvicorn and the worker
(its canned answers are about the sample's fictional Dana Whitfield).
Sign in locally: run the API with `RAISEBOOK_ENV=dev`, request a link at `/signin`, and the
"check your email" page shows the `dev_link`. `uv run rbctl seed-demo --email you@example.com`
creates the fictional sandbox workspace "Kestrel Robotics (sample)".

## Run (web)
```bash
cd web
npm ci
npm run dev                                        # :3000, needs the API on :8000
npm run lint && npm run typecheck && npm run build
```

## End-to-end run (integrator recipe, no Docker)
```bash
# API on :8100 (from backend/); the web origin on :3100 is RAISEBOOK_APP_URL, so it is allowed.
RAISEBOOK_ENV=dev RAISEBOOK_PUBLIC_BASE_URL=http://localhost:8100 \
  RAISEBOOK_APP_URL=http://localhost:3100 RAISEBOOK_SESSION_COOKIE_SECURE=false \
  uv run uvicorn --factory raisebook.main:create_app --port 8100
# Web production build on :3100 (from web/); NEXT_PUBLIC_* are baked in at build time.
NEXT_PUBLIC_API_URL=http://localhost:8100 NEXT_PUBLIC_SITE_URL=http://localhost:3100 npm run build
npx next start -p 3100
```
`RAISEBOOK_CORS_ORIGINS` takes a comma-separated list or a JSON list. Final screenshots of every
route (light, dark, 390px) are in `design/screens/final/`. Signing in by script: request a link
(`POST /v1/auth/magic-link`), open the `dev_link` and press **Continue**: the verify page never
spends the token on load. Use a throwaway database (for example `raisebook_shots`) and
`RAISEBOOK_RATE_LIMIT_BACKEND=off` for screenshot runs.

## Tests
- Local Homebrew **Postgres 17**: databases `raisebook_dev` and `raisebook_test` exist, with
  `citext` and `pg_trgm`. Override the test DB with `RAISEBOOK_TEST_DATABASE_URL`. There is no
  Docker and no testcontainers.
- Each pytest session creates its own schema `t_<pid>_<hex>`, runs `alembic upgrade head` into
  it, and drops it at exit (`RAISEBOOK_TEST_KEEP_SCHEMA=1` keeps it). Concurrent runs are safe.
- The `db` fixture rolls back an outer transaction per test, and service commits release a
  savepoint. Clients: `client` (anonymous), `session_client(user, ws)` (cookie + CSRF),
  `key_client(key)`, and `mcp_call(key, tool, args)` (the real `/mcp` route). Factories are in
  `tests/factories.py`. Emails land in the `outbox` fixture.
- **Workspace isolation is the critical invariant.** `tests/isolation/` enumerates every
  `/v1` route and every MCP tool and checks that workspace A can neither read nor change B. A
  new route or tool that the isolation suite does not cover fails the build.
- No network calls in tests. Use an injectable clock everywhere (`core/clock.get_now`, MCP
  `Clock`). Never call `datetime.now()` deep inside logic.
- OpenRouter is never reached from tests: an autouse guard installs a refusing transport (an
  unmocked request fails the test). Use the `openrouter_mock` fixture
  (`tests/research/openrouter_mock.py`, fictional `FAKE_KEY`, recorded models list in
  `tests/research/fixtures/`). conftest sets a throwaway `RAISEBOOK_SECRETS_KEK` per run.
- Queue and worker races use `committing_sessionmaker` with a test-only job kind
  (`test.<hex>`) and delete their rows afterwards.

## Conventions and contracts
- Every workspace-scoped service function takes `ws: WorkspaceContext` (from the principal)
  and filters by `ws.workspace_id`. Never take a workspace id from request input. An id from
  another workspace is **404**, never 403.
- Every write takes an `actor: Actor` and writes its activity in the same transaction
  (`services/activities.log`). No-ops write nothing. Agents (API key or MCP) are recorded with
  `actor_label` from `X-Agent-Name` (else the key's `agent_name`, else its name) and
  `agent_model` from `X-Agent-Model`.
- Errors: raise `raisebook.core.errors.APIError` subclasses. The envelope is
  `{"error": {code, message, details, request_id}}`. Messages say what to do next.
- MCP tools call the same services as REST and never re-implement rules. Reference resolution
  (investor by id, email, LinkedIn or name; round by id, slug or name, defaulting to the single
  open round) lives only in `core/refs.py`.
- Dedupe and normalization live only in `services/normalize.py` (email → LinkedIn →
  name+firm).
- Money is whole currency units in `bigint`. Dates are `date` in the workspace timezone.
- New API module: `api/router.py` already registers every planned module. New MCP tool: add it
  in the right `mcp/tools/<area>.py` with `read_only(...)` or `write(...)` annotations.
- Web: only design tokens exist in Tailwind (`bg-surface`, `text-muted`, `text-agent`,
  `bg-stage-teal`…). Cobalt = you can act, orchid = an agent did this, green = committed
  money, red = act now or failed. Components live in `web/components/ui`. Every `/v1` call
  goes through `web/lib/api/*`.
- Privacy is a product feature: no analytics, trackers or third-party runtime requests. Fonts
  come through `next/font`. Logs never include request bodies, investor fields or emails.
- Demo, test and docs data is **fictional only** (example.com emails, made-up people and
  firms). Never commit real people's data.
- Never print or commit secrets (API keys, session secrets, SMTP passwords).

## Invariants added in the polish pass (keep them)
- API keys die with their creator's access: `services/members.revoke_keys_created_by` runs on
  remove, leave, owner demotion and account deletion (`tests/test_key_lifecycle.py`).
- `/auth/verify` POSTs only on a click; a different signed-in user gets 409
  `session_conflict` unless `switch_account` (`tests/test_auth_hardening.py`). Sessions end
  90 days after sign-in (`session_max_days`); `/v1/me/sessions` lists and ends them.
- Per-IP `auth_fail`, per-person `invite_user`/`invite_user_new` buckets, and
  `workspaces_per_user` caps. Invite subjects are fixed; names cannot contain links.
- MCP: `mcp/server.RaisebookMCP` returns compact JSON text (no outputSchema), rewrites
  argument validation errors to `validation_error: …`, hides write tools from read-only keys
  and reports the Raisebook version. Shapes live in `mcp/shaping.py`; shared argument types
  (descriptions, "VC"/"250k" leniency) in `mcp/tools/_args.py`. Error text names MCP tools
  for MCP callers (`core.refs.how`) and REST paths for REST callers.
- `add_investor` defaults to `fill_empty`, appends notes on a match, reports `not_applied`,
  and matches by name alone when exactly one person has that name. Omitted rounds resolve
  to the investor's only open round when several are open.
- Web: text on soft tints uses the `*-ink` tokens (`text-warm-ink`, …), never the fill hue.
  Round views share `RoundHeader` (no second tab row). Phones get a compact ledger, a
  stacked pipeline list and single-column sheet fields.

## Invariants added in UX pass 1 (keep them)
- Web unit tests: `npm run test:unit` (node's test runner over `web/lib/**/*.test.ts`); run it
  with lint, typecheck and build.
- Pickers: a list longer than about 12 options, or one where search helps, is a `Combobox`
  (`TimezonePicker`, `CurrencyPicker` for zones and currencies; never a native select).
  Zones are saved canonical (`Asia/Kolkata`, not `Asia/Calcutta`) on both sides. Dates in
  the app use `DateField` and the **workspace** timezone.
- Pipeline: server props are initial data only. Rows live in a client store per round and
  the newer `updated_at` wins. Filter, sort, search and view changes send no requests (URL via
  `replaceState`); the sheet opens and closes with `replaceState` too.
- Keyboard: every global shortcut goes through `lib/hotkeys.ts` (`useHotkey`), never a
  document `keydown` listener of its own. Sheets register with `priority: 1`. App-wide keys set
  `blockedByModals`. Nothing fires while typing in a field.
- Long lists render windowed (`useVirtualRows`); no "Load more" or "Show 60 more" in the app.
- Import: only a missing name is a row error; bad optional cells are dropped with a warning.
- Bulk writes go through `POST /v1/rounds/{round}/participants/bulk-update` with a shared
  `data.bulk_id`; feeds collapse runs with `GET /v1/activities?collapse_runs=true`.
- Google sign-in is off unless `RAISEBOOK_GOOGLE_CLIENT_ID` and `_SECRET` are set; the web
  asks `GET /v1/auth/providers` and hides the button otherwise.

## Invariants added in the pipeline redo (keep them; spec: `design/pipeline-redo/DECISION.md`)
- The round page has three views: Triage, Board, Table. Pure rules (default view, money
  exists, dominant stage, triage keys, the card's one right slot, Next up buckets, pace) live
  in `web/lib/pipeline.ts` with unit tests. Triage needs a writer and an open stage.
- The board never folds a column into a rail. Board cards are the rich `DealCard`
  (`DECISION.md` §15; helpers in `web/lib/boardCard.ts`); the industry "Other" and the type
  `other` are never shown as chips or labels.
- Bare digits write only in Triage. Triage moves are optimistic through the page's store
  (`TriageStore`), and Undo restores the turn's snapshot with one `bulk-update` `restore`.
- Fictional fixtures for the 411-in-New and mature states: `design/pipeline-redo/fixtures/seed.py`
  (through the API, against a dev server).
- Critique 1 (`DECISION.md` §10): Triage counts are "left" (New and not skipped); U undoes the
  last change of any kind; a bulk move never skips the current undecided row; `restore` writes
  `data.undo` and timelines drop undone pairs (`dropUndone`). Fit pips are neutral ink, one
  encoding per place. The end-stage pill lives in the toolbar. The title row, ledger and table size to the page's measured width
  (the split sheet reflows them), never to viewport breakpoints alone.
- Critique 2 (`DECISION.md` §11): fit pips are quiet (`faint`) and absent inside single-fit
  groups; the type chip is neutral; a value every queued investor shares (source, the import
  history) is hidden. Triage asks before a talking stage (`claimsContact`) unless the intro was
  drafted; no preselected focus. The sheet is a split pane in every view, puts Contact and Facts
  first for open-kind stages and folds Money; imports show once (`collapseImportRuns`). Solo
  workspaces get no owner UI. `useHotkey({ listOnly })` lists keys a component handles itself.
- Critique 3 (`DECISION.md` §12): Triage has no rail and one population for every count
  (skipped ones are still New); the pace uses only real single-decision gaps (`paceEstimate`)
  and desktop Triage reports changes in the decision panel, not toasts. The open file follows
  the queue. Pips only in not-contacted stages (`hiddenPipFit`). Add investor lives in the title row in every view. Long dialogs
  use `Dialog scrollBody`; the Filter menu never scrolls an ancestor.
- Critique 4 (`DECISION.md` §13): the Triage pane is full height with the decision panel pinned
  (it never moves between investors); one Triage entry per screen besides the segment
  (`shownBuckets`); bulk Undo returns to the pre-move cursor; the sheet's "N of M" in Triage is
  the still-New walk; the pace plans at `PACE_FLOOR_MS` when faster. Reach out is one component
  (`components/app/ReachOut.tsx`, `introFitLine`) in Triage, the sheet, phone and the investor
  page. Talking columns sort by follow-up (`defaultColumnSort`). The Triage file is a split pane
  from 1024px.

## Kanban board (`DECISION.md` §14; keep it)
- The Board view is a classic kanban: one equal-width column per stage (`boardTrack`), empty
  ones included with "Drag investors here"; no rails, no shared "Drop to file" track, no fit
  groups on the board. Columns are windowed and sorted by `defaultColumnSort` (fit, follow-up,
  amount, recency by stage kind). Drag a card onto a column to move it; §5.5 keys still work.

## Investor research, Part 1 foundation (spec `docs/RESEARCH-SPEC.md`, plan `docs/RESEARCH-PLAN.md`)
- **Unreleased and off by default.** Only `RAISEBOOK_RESEARCH_ENABLED=true` serves its REST
  modules (`api/router.RESEARCH_API_MODULES`), its MCP tools (`mcp/tools.RESEARCH_TOOL_MODULES`)
  and the research line of the MCP instructions. With it off the MCP surface is the 17 tools
  every public page promises (`tests/test_research_flag.py`). Never mention research on a
  public page, the README or the changelog until it ships. Tests run with the flag on.
- Migration `0003_research` holds every research table. Public facts (`research_sources`,
  `investor_identities`, `investor_identity_candidates`, `dossier_facts`) stay apart from
  private analysis (`dossiers`, `research_runs`, `field_suggestions`). Composite
  `(workspace_id, …)` FKs everywhere; `activities.kind` includes `research`.
- The OpenRouter key is sealed by `core/secrets.py` (AES-256-GCM DEK per key, wrapped by the
  KEK; AAD = workspace id). Only `key_last4` is ever returned; no export, log or error carries
  the key; `sk-or-…` is redacted from logs. Only an owner signed in to the web sets or removes
  it (`require_owner_session`); preset, model ids and cap need `raisebook:admin`.
- `services/ai_settings.PRESETS` is pinned to the recorded models list by a test; ids are
  verified on `GET /models` when a key is saved and when models change with a key present.
- Money for AI is USD micros (`*_micros bigint`). Every OpenRouter call reserves first with
  `services/spend.reserve_for_run` (one conditional UPDATE; never over the cap), then
  `settle_for_run` with OpenRouter's reported cost; recovery, cancel and shutdown call
  `release_for_run`.
- Jobs: `services/jobs.py` (enqueue with `dedupe_key`, `FOR UPDATE SKIP LOCKED` claims, leases,
  backoff, `recover_stuck`) and `raisebook/worker.py` (`rbctl worker`). Handlers register with
  `worker.register(kind, handler, on_recover=…)` from a module listed in
  `worker.HANDLER_MODULES`, are idempotent per step and call `ctx.check_lease()` between steps.
  Jobs carry ids only, never secrets or investor fields.

## Investor research, Part 2 pipeline (keep these)
- Runs (`services/research.py`): `research.run` jobs carry the run id only; the handler acts as
  the requester via `auth/principal.worker_context` (lost write access → `cancelled`), opens
  the key only inside the run, and commits each step with its cost. Every OpenRouter call
  reserves first (`spend.reserve_for_run`, ×1.5 of that call's budget) and settles
  OpenRouter's `usage.cost` (priced from the snapshot and flagged `estimated` when missing).
  A refused reservation ends the run `capped`; `failed`/`partial`/`capped` runs resume and
  skip finished steps. One active run per investor and kind (double clicks return it).
- Identity first (`services/research_identity.py`): confidence is recomputed in code;
  ≥ 0.80 with a 0.15 margin → `matched`, else `needs_pick` (2-3 candidates) or `not_found`.
  Dossier runs refuse (`identity_required`) or end `blocked_identity` until anchored. A
  LinkedIn URL a person entered confirms without a model call.
- One validator (`services/research_validate.py`) and one privacy filter
  (`services/privacy_filter.py`) serve model and agent dossiers: sources must match the anchor
  (LinkedIn profile, firm domain, name + firm, name + title), personal social sites never
  count, facts cite accepted sources (uncited: model → `unverified`, agent → dropped and
  listed), phones/addresses/consumer emails are stripped and private topics dropped.
- Dossiers (`services/dossiers.py`): `dossiers` (private analysis) + `dossier_facts` (public
  facts citing `research_sources` ids); last 5 versions; "new since" via strict + loose fact
  keys; stale > 90 days and the Meeting refresh offer > 30 days are computed, never stored.
- Write-back (`services/research_writeback.py`) fills only empty fields (an `auto_applied`
  suggestion row is the "from research" mark) and suggests the rest; identity fills point at
  their run (`field_suggestions.run_id`, migration 0004). Ignored values are never suggested
  again; accept-all shares one `bulk_id`.
- `save_dossier` (MCP) / `POST /v1/investors/{id}/dossier` need no key and cost nothing; the
  dossier and its activity are "by <agent-name>". The writer never sees notes, emails,
  amounts or timelines (prompts in `services/research_prompts.py`, hash-pinned by a test:
  bump `PROMPT_VERSION` with any change).
- Removal (`services/research_removal.py`) holds the only cross-workspace statements
  (DELETE/UPDATE, counts only); suppressions refuse research for that person everywhere.
- Tests: `tests/research/pipeline_mock.Script` scripts OpenRouter's answers;
  `tests/research/helpers.run_jobs(db)` runs queued jobs in-process on the test session.
