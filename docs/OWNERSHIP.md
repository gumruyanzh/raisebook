# Raisebook: file ownership for parallel builders

Each phase has builders working at the same time. **A builder edits only the files it owns.**
If you need a change in a file you do not own, do not edit it. Write the request in your phase
report ("needs: core/errors.py add `NotDeletable`") and work around it locally (for example,
raise `APIError(code="not_deletable", status_code=409)` directly). The next phase or the
integrator applies it.

Read-only for every builder: `docs/SPEC.md`, `design/SYSTEM.md`, `docs/OWNERSHIP.md`,
`prototype.html`, and everything under `~/projects/smmist` (copy and adapt patterns from it,
never import from it).

Shared rules:
- **No new migrations in Phase 3.** `0001_init.py` (Foundation-backend) holds the whole §3
  schema. If a feature cannot work without a schema change, stop and report it.
- **No new dependencies** without a line in your report saying why. Backend dependencies are
  fixed by Foundation-backend in `pyproject.toml`; web dependencies by Foundation-web in
  `package.json`.
- Each builder runs the full check suite for its side before finishing (see `CLAUDE.md`).
  You may not leave another builder's tests failing because of your change.
- Commit only your own files, with a message prefixed by your role, for example
  `api+mcp: participants endpoints`. Do not push.

Phases:
- **Phase 2 (in parallel):** Foundation-backend (FB), Foundation-web (FW).
- **Phase 3 (in parallel, after Phase 2 lands):** API+MCP (AM), App-UI (UI), Landing+Docs (LD),
  Import-Export+Ops (IE).

---

## Phase 2

### Foundation-backend (FB)
Builds the skeleton, every model, the whole schema, auth, and the plumbing every feature
plugs into, **including empty stub modules for every Phase 3 backend file**, so that Phase 3
builders never touch registries.

Owns:
- `backend/pyproject.toml`, `backend/uv.lock`, `backend/alembic.ini`, `backend/.env.example`
- `backend/alembic/env.py`, `backend/alembic/versions/0001_init.py` (all of SPEC §3: tables,
  CHECKs, indexes, the composite FKs, the `activities_guard_update` trigger)
- `backend/raisebook/__init__.py`, `config.py`, `main.py`, `cli.py`
- `backend/raisebook/core/*` (`database`, `errors` with every error code in SPEC §5.2 as a
  class or helper, `clock`, `request_id`, `logging` with no-PII rules, `ratelimit` with
  postgres/memory/off backends, `actor`)
- `backend/raisebook/core/refs.py`: **stub only** (the signatures below); AM fills it in.
- `backend/raisebook/auth/*` (`scopes`, `api_keys`, `session`, `magic_link`, `principal` with
  `WorkspaceContext`, `require_scopes`, `require_owner_session`)
- `backend/raisebook/models/*` (every table)
- `backend/raisebook/schemas/common.py`, `auth.py`, `workspaces.py`, `members.py`,
  `api_keys.py`
- `backend/raisebook/services/users.py`, `auth.py`, `workspaces.py` (create, including default
  currency and timezone; `sample=True` calls `services.sample_data.create_sample_workspace`),
  `members.py`, `invites.py`, `api_keys.py`, `email.py` (log/smtp/memory backends),
  `deletion.py` (workspace and account hard delete)
- `backend/raisebook/api/router.py` (with **all** module names from SPEC §2.1 registered),
  `api/deps.py`, `api/health.py`, `api/auth.py`, `api/me.py`, `api/workspaces.py`,
  `api/members.py`, `api/invites.py`, `api/api_keys.py`
- `backend/raisebook/mcp/server.py` (server instructions from SPEC §6.3 verbatim),
  `mcp/auth.py`, `mcp/annotations.py`, `mcp/tools/__init__.py` (imports and registers
  `workspace, rounds, investors, pipeline, data`), `mcp/tools/_common.py` (`tool_call(ctx,
  *scopes)`, `ToolError` mapping, MCP `Clock`, agent-header extraction)
- `backend/tests/conftest.py`, `backend/tests/factories.py` (factories for **every** model:
  user, workspace, membership, invite, api key, round with default stages, investor,
  participant, activity), `tests/test_auth_*.py`, `tests/test_workspaces.py`,
  `tests/test_members.py`, `tests/test_invites.py`, `tests/test_api_keys.py`,
  `tests/test_deletion.py`, `tests/test_migrations.py` (the trigger, composite FKs),
  `tests/test_ratelimit.py`, `tests/test_permissions_matrix.py` (the matrix harness with the
  FB-owned rows; AM and IE add their rows in their own files)

Stubs FB creates (empty but importable, each with a module docstring naming its owner):
- `api/rounds.py`, `api/investors.py`, `api/participants.py`, `api/activities.py`,
  `api/follow_ups.py` (AM); `api/imports.py`, `api/exports.py` (IE). Each defines
  `router = APIRouter()` with its prefix and no routes.
- `mcp/tools/workspace.py`, `rounds.py`, `investors.py`, `pipeline.py` (AM); `mcp/tools/data.py`
  (IE). Each defines `def register(server: FastMCP) -> None: pass`.
- `services/sample_data.py` (IE): `async def create_sample_workspace(db, *, user, now) ->
  Workspace` raising `NotImplementedError`.
- `core/refs.py` (AM): `resolve_round(db, ws, ref: str | None, *, required: bool)`,
  `resolve_investor(db, ws, ref: str)`, `resolve_stage(round, ref: str)`, raising
  `NotImplementedError`.
- `schemas/rounds.py`, `investors.py`, `participants.py`, `activities.py` (AM);
  `schemas/data.py` (IE): empty modules.

Exposes these contracts (documented in `CLAUDE.md`):
- `get_principal`, `require_scopes(...)`, `require_owner_session()`, and `get_workspace_ctx`
  → `WorkspaceContext(workspace_id, timezone, currency, principal, actor)`.
- `Actor` built from the principal plus the `X-Agent-Name`/`X-Agent-Model` headers (REST) or
  the MCP request headers.
- `ratelimit.enforce(request_or_ctx, bucket_kind)` as a dependency, plus an MCP helper.
- `APIError` subclasses and the error envelope; FastAPI validation errors → `validation_error`.
- The test fixtures `db`, `app`, `client`, `session_client(user, workspace)` (cookie + CSRF),
  `key_client(key)`, `mcp_call(key, tool, args)` (JSON-RPC over the real `/mcp` route),
  `outbox` (emails sent), `frozen_now`.

### Foundation-web (FW)
Owns:
- `web/package.json`, `package-lock.json`, `next.config.ts` (`output: "standalone"`),
  `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `web/.env.example`,
  `web/README.md`, `web/middleware.ts`
- `web/app/layout.tsx`, `web/app/globals.css` (every token in SYSTEM §1, the Tailwind
  `@theme` mapping, the dark-mode blocks), `web/app/icon.svg`, `web/app/not-found.tsx`,
  `web/app/robots.ts`
- `web/app/design/**` (the component inventory page)
- `web/app/(auth)/layout.tsx`, `(auth)/signin/**`, `(auth)/signin/check/**`,
  `(auth)/auth/verify/**`, `(auth)/invite/[token]/**`
- `web/app/(app)/layout.tsx`, `web/app/(app)/w/[ws]/layout.tsx` (loads the session and
  workspace, renders `TopBar` with the round list), `web/app/(app)/app/page.tsx` (redirect)
- `web/components/ui/**`: every component in SYSTEM §3, including `TopBar`, `Ledger`,
  `FunnelBar`, `BoardColumn`, `BoardCard`, `Sheet`, `Timeline`, `ActorName`, `CodeBlock`,
  `SecretReveal`, `FileDrop`. They are presentational, take data via props, and have no data
  fetching.
- `web/lib/api/client.ts` (fetch wrapper: base URL, `credentials: "include"`, CSRF header,
  `X-Workspace`, error envelope → typed `ApiError`, server-side variant forwarding cookies),
  `web/lib/api/core.ts` (types and calls for auth, session, me, workspaces, and the round list
  used by `TopBar`), `web/lib/format.ts` (`money`, `moneyCompact`, dates, relative time),
  `web/lib/theme.ts`, `web/lib/cn.ts`, `web/lib/session.ts`
- `.github/workflows/web.yml` is **not** FW's (IE owns CI).

---

## Phase 3

### API+MCP (AM)
Owns:
- `backend/raisebook/core/refs.py` (replaces the stub)
- `backend/raisebook/schemas/rounds.py`, `investors.py`, `participants.py`, `activities.py`
- `backend/raisebook/services/normalize.py`, `rounds.py`, `stages.py`, `investors.py`,
  `participants.py`, `activities.py`, `followups.py`, `summary.py`, `search.py`
- `backend/raisebook/api/rounds.py`, `investors.py`, `participants.py`, `activities.py`,
  `follow_ups.py` (replace the stubs; the export route `GET /v1/rounds/{round}/export` lives
  in IE's `api/exports.py`)
- `backend/raisebook/mcp/shaping.py`, `mcp/tools/workspace.py` (`get_workspace`),
  `mcp/tools/rounds.py` (`list_rounds`, `get_round_summary`), `mcp/tools/investors.py`
  (`search_investors`, `get_investor`, `add_investor`, `update_investor`),
  `mcp/tools/pipeline.py` (`add_to_round`, `move_stage`, `log_activity`, `set_follow_up`,
  `list_due_follow_ups`, `record_commitment`)
- `backend/tests/api/**`, `backend/tests/mcp/**` (except `tests/mcp/test_data_tools.py`),
  `backend/tests/services/test_normalize.py` and the other service tests for its services,
  `backend/tests/isolation/test_rest_isolation.py` and `test_mcp_isolation.py` (these
  enumerate **all** routes and tools, including IE's; IE's routes must pass them),
  `backend/tests/test_permissions_features.py`

Provides to IE: `services.normalize` (normalization and the dedupe key functions),
`services.investors.find_match(db, ws, fields) -> Match | None`,
`services.investors.create/update`, `services.participants.upsert`, `services.activities.log`.
IE calls these, never raw SQL, for investor and participant writes. To avoid blocking, AM lands
`normalize.py` and the signatures of those functions first (in its first commit).

### App-UI (UI)
Owns:
- `web/app/(app)/w/[ws]/page.tsx` (redirect to the first open round)
- `web/app/(app)/w/[ws]/r/[round]/**` (Pipeline, Overview, round settings)
- `web/app/(app)/w/[ws]/investors/**`
- `web/app/(app)/w/[ws]/settings/page.tsx` (General), `settings/members/**`,
  `settings/api-keys/**`, `settings/mcp/**`, and `settings/layout.tsx` (the sub-nav,
  including the link to Data)
- `web/app/(app)/account/**`
- `web/app/(auth)/onboarding/**`
- `web/components/app/**` (stateful feature components: `PipelineBoard` with drag and the
  keyboard alternative, `PipelineTable`, `InvestorSheet`, `AddInvestorDialog`, `StagesEditor`,
  `ConnectAgent`, …)
- `web/lib/api/rounds.ts`, `investors.ts`, `activities.ts`, `settings.ts` (members, invites,
  API keys, workspace settings)

### Landing+Docs (LD)
Owns:
- `web/app/(marketing)/**` (`layout.tsx`, `page.tsx`, `docs/**`, `privacy/page.tsx`,
  `terms/page.tsx`, `sitemap.ts`, `opengraph-image.tsx`)
- `web/components/marketing/**` (landing vignettes built from `components/ui`, with fictional
  data in `web/components/marketing/sample.ts`)
- Root `README.md` (with the free-forever promise, privacy promise, quick start, MCP snippet,
  self-hosting pointer, license), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (the
  verbatim AGPL-3.0 text from https://www.gnu.org/licenses/agpl-3.0.txt)

### Import-Export+Ops (IE)
Owns:
- `backend/raisebook/schemas/data.py`, `services/csv_io.py`, `services/imports.py`,
  `services/exports.py`, `services/sample_data.py` (replaces the stub)
- `backend/raisebook/api/imports.py`, `api/exports.py` (replace the stubs; these include
  `GET /v1/export`, `GET /v1/investors/export`, `GET /v1/rounds/{round}/export`)
- `backend/raisebook/mcp/tools/data.py` (`import_investors_csv`, `export_round`)
- `backend/tests/services/test_csv_io.py`, `test_imports.py`, `test_exports.py`,
  `test_sample_data.py`, `backend/tests/api/test_imports_api.py`, `test_exports_api.py`,
  `backend/tests/mcp/test_data_tools.py`, `backend/tests/fixtures/*.csv` and `*.json`
  (fictional data only)
- `web/app/(app)/w/[ws]/import/**`, `web/app/(app)/w/[ws]/settings/data/**`,
  `web/components/data/**`, `web/lib/api/data.ts`
- `deploy/**` (`api.Dockerfile`, `web.Dockerfile`, `docker-compose.yml`, `Caddyfile`,
  `.env.example`, `README.md` with the self-hosting steps)
- `.github/workflows/backend.yml`, `.github/workflows/web.yml`, `SECURITY.md`, root
  `.gitignore` (after the spec phase), `backend/.dockerignore`, `web/.dockerignore`

---

## Integration notes
- The router and the MCP tool registry are owned by FB and already list every module, so no
  Phase 3 builder edits them.
- `CLAUDE.md` belongs to the spec/integration role. Builders put new commands or contracts in
  their report, and the integrator merges them.
- If two Phase 3 builders need the same new UI primitive, each builds its own private version
  under its own `components/<area>/`, and the integrator lifts one into `components/ui/` later.

---

## UX pass 1 (2026-10-12)
Ownership for the UX pass is in `docs/UX-PASS-1.md` §3 (WS-A Pickers & Setup, WS-B
Pipeline, WS-C Shell, WS-D Import), plus WS-G (Continue with Google). After the pass, the
same areas stay with the same roles. Files that pass added:
- WS-A: `web/components/ui/{Combobox,TimezonePicker,CurrencyPicker,DateField}.tsx`,
  `web/lib/{tz/**,currency.ts,dates.ts,rank.ts}`, `web/lib/**/*.test.ts`,
  `web/lib/testing/**`, `web/components/app/settings/NewWorkspaceDialog.tsx`.
- WS-B: `web/components/ui/{Avatar,FilterBar}.tsx`, `web/components/ui/useVirtualRows.ts`,
  the `participants/bulk-update` route, schemas and tests.
- WS-C: `web/components/ui/{CommandPalette,ShortcutsSheet}.tsx`,
  `web/lib/{hotkeys,commands,keys,match}.ts`, `web/components/app/TodayQueue.tsx`,
  `web/app/(app)/_shell/AppKeyboard.tsx`.
- WS-D: `web/public/templates/**`, the import preview additions in `schemas/data.py`.
- WS-G: `backend/raisebook/services/google_auth.py`, the `/v1/auth/google/*` and
  `/v1/auth/providers` routes in `api/auth.py`, `alembic/versions/0002_*.py`,
  `backend/tests/test_google_signin.py`, `web/components/app/auth/GoogleButton.tsx`,
  `web/lib/api/auth-providers.ts`.
- Integrator: `web/components/ui/index.ts` exports for components outside WS-A,
  `web/lib/api/types.ts`, `docs/SPEC.md`, `design/SYSTEM.md`, this file.
