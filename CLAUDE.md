# Raisebook: working notes for agents

Raisebook (raisebook.org) is a free-forever, open-source (AGPL-3.0) fundraising CRM for
founders, with a first-class MCP server. Spec: `docs/SPEC.md`. Its **§0 decisions block
overrides the rest**: the package is `raisebook`, the env prefix is `RAISEBOOK_*`, the CLI is
`rbctl`, keys are `rb_live_` / `rb_test_`, and the scopes are `raisebook:read|write|admin`.
Design rules: `design/SYSTEM.md` (binding). Who edits what: `docs/OWNERSHIP.md`. Hosting is
undecided, so never deploy and never touch DNS. The repo is private until launch, and you do
not push unless asked.

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
uv run rbctl --help    # workspace create | apikey create/revoke | seed-demo --email | housekeeping
```
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
route (light, dark, 390px) are in `design/screens/final/`.

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
