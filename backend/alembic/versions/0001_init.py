"""init: the whole SPEC §3 schema.

Tables, CHECK constraints, partial unique indexes, composite (workspace_id, id)
foreign keys that stop cross-workspace links, and the ``activities_guard_update``
append-only trigger. Written as explicit SQL so it reads like the spec.

Raisebook addition to SPEC §3.1: ``login_tokens.invite_id`` (the invite attached
to a magic-link request, accepted in the verify transaction, SPEC §4.1 step 3).

Revision ID: 0001
Revises:
Create Date: 2026-10-10
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


EXTENSIONS = """
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
"""

IDENTITY = """
CREATE TABLE users (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  email          citext NOT NULL,
  name           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_signin_at timestamptz,
  CONSTRAINT pk_users PRIMARY KEY (id),
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT ck_users_email_valid CHECK (length(email) <= 254 AND position('@' IN email) > 1),
  CONSTRAINT ck_users_name_valid CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 120)
);

CREATE TABLE workspaces (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  slug               citext NOT NULL,
  name               text NOT NULL,
  is_sandbox         boolean NOT NULL DEFAULT false,
  default_currency   char(3) NOT NULL DEFAULT 'USD',
  timezone           text NOT NULL DEFAULT 'UTC',
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_workspaces PRIMARY KEY (id),
  CONSTRAINT uq_workspaces_slug UNIQUE (slug),
  CONSTRAINT ck_workspaces_slug_valid CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  CONSTRAINT ck_workspaces_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_workspaces_currency_valid CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fk_workspaces_created_by_user_id_users FOREIGN KEY (created_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  role         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_memberships PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT ck_memberships_role_valid CHECK (role IN ('owner', 'editor', 'viewer')),
  CONSTRAINT fk_memberships_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_user_id_users FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_memberships_user ON memberships (user_id);

CREATE TABLE invites (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  email               citext NOT NULL,
  role                text NOT NULL,
  token_hash          bytea NOT NULL,
  invited_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_by_user_id uuid,
  revoked_at          timestamptz,
  CONSTRAINT pk_invites PRIMARY KEY (id),
  CONSTRAINT uq_invites_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_invites_email_valid CHECK (length(email) <= 254),
  CONSTRAINT ck_invites_role_valid CHECK (role IN ('owner', 'editor', 'viewer')),
  CONSTRAINT fk_invites_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_invites_invited_by_user_id_users FOREIGN KEY (invited_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_invites_accepted_by_user_id_users FOREIGN KEY (accepted_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_invites_pending ON invites (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Magic links. The user row is created on first successful verify, not on request.
CREATE TABLE login_tokens (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  token_hash    bytea NOT NULL,
  redirect_path text,
  invite_id     uuid,
  requested_ip  inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  CONSTRAINT pk_login_tokens PRIMARY KEY (id),
  CONSTRAINT uq_login_tokens_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_login_tokens_redirect_path_valid CHECK (
    redirect_path IS NULL OR (left(redirect_path, 1) = '/' AND left(redirect_path, 2) <> '//')),
  CONSTRAINT fk_login_tokens_invite_id_invites FOREIGN KEY (invite_id)
    REFERENCES invites (id) ON DELETE SET NULL
);
CREATE INDEX ix_login_tokens_email_created ON login_tokens (email, created_at DESC);

CREATE TABLE user_sessions (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  secret_hash  bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  user_agent   text,
  ip           inet,
  CONSTRAINT pk_user_sessions PRIMARY KEY (id),
  CONSTRAINT ck_user_sessions_user_agent_valid CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  CONSTRAINT fk_user_sessions_user_id_users FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_user_sessions_user ON user_sessions (user_id);

CREATE TABLE api_keys (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  name               text NOT NULL,
  agent_name         text,
  key_prefix         text NOT NULL,
  key_hash           bytea NOT NULL,
  mode               text NOT NULL,
  scopes             text[] NOT NULL,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  CONSTRAINT pk_api_keys PRIMARY KEY (id),
  CONSTRAINT uq_api_keys_key_hash UNIQUE (key_hash),
  CONSTRAINT ck_api_keys_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_api_keys_agent_name_valid CHECK (
    agent_name IS NULL OR agent_name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$'),
  CONSTRAINT ck_api_keys_mode_valid CHECK (mode IN ('live', 'test')),
  CONSTRAINT ck_api_keys_scopes_valid CHECK (
    cardinality(scopes) >= 1
    AND scopes <@ ARRAY['raisebook:read', 'raisebook:write', 'raisebook:admin']::text[]
    AND 'raisebook:read' = ANY (scopes)),
  CONSTRAINT fk_api_keys_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_keys_created_by_user_id_users FOREIGN KEY (created_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX ix_api_keys_workspace ON api_keys (workspace_id);
"""

ROUNDS = """
CREATE TABLE rounds (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  slug                citext NOT NULL,
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'open',
  instrument          text NOT NULL DEFAULT 'safe',
  currency            char(3) NOT NULL,
  target_amount       bigint NOT NULL DEFAULT 0,
  valuation_cap       bigint,
  pre_money_valuation bigint,
  target_close_on     date,
  closed_on           date,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_rounds PRIMARY KEY (id),
  CONSTRAINT uq_rounds_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT uq_rounds_workspace_id_slug UNIQUE (workspace_id, slug),
  CONSTRAINT ck_rounds_slug_valid CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  CONSTRAINT ck_rounds_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_rounds_status_valid CHECK (status IN ('open', 'closed')),
  CONSTRAINT ck_rounds_instrument_valid CHECK (
    instrument IN ('safe', 'priced', 'convertible_note', 'other')),
  CONSTRAINT ck_rounds_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_rounds_target_amount_valid CHECK (target_amount >= 0),
  CONSTRAINT ck_rounds_valuation_cap_valid CHECK (valuation_cap IS NULL OR valuation_cap > 0),
  CONSTRAINT ck_rounds_pre_money_valuation_valid CHECK (
    pre_money_valuation IS NULL OR pre_money_valuation > 0),
  CONSTRAINT ck_rounds_closed_on_valid CHECK (closed_on IS NULL OR status = 'closed'),
  CONSTRAINT ck_rounds_notes_valid CHECK (notes IS NULL OR length(notes) <= 20000),
  CONSTRAINT fk_rounds_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_rounds_ws_name ON rounds (workspace_id, lower(name));

CREATE TABLE round_stages (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  round_id     uuid NOT NULL,
  key          text NOT NULL,
  label        text NOT NULL,
  color        text NOT NULL,
  kind         text NOT NULL,
  position     smallint NOT NULL,
  CONSTRAINT pk_round_stages PRIMARY KEY (id),
  CONSTRAINT ck_round_stages_key_valid CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT ck_round_stages_label_valid CHECK (length(btrim(label)) BETWEEN 1 AND 40),
  CONSTRAINT ck_round_stages_color_valid CHECK (color IN ('slate', 'violet', 'cobalt', 'teal',
    'amber', 'orange', 'green', 'gray', 'olive', 'sky')),
  CONSTRAINT ck_round_stages_kind_valid CHECK (kind IN ('open', 'active', 'won', 'lost')),
  CONSTRAINT ck_round_stages_position_valid CHECK (position BETWEEN 0 AND 31),
  CONSTRAINT fk_round_stages_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_round_stages_round_id_id UNIQUE (round_id, id),
  CONSTRAINT uq_round_stages_round_id_key UNIQUE (round_id, key),
  CONSTRAINT uq_round_stages_position UNIQUE (round_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX uq_round_stages_one_won  ON round_stages (round_id) WHERE kind = 'won';
CREATE UNIQUE INDEX uq_round_stages_one_lost ON round_stages (round_id) WHERE kind = 'lost';
"""

INVESTORS = """
CREATE TABLE investors (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  name           text NOT NULL,
  firm           text,
  title          text,
  type           text NOT NULL DEFAULT 'other',
  check_min      bigint,
  check_max      bigint,
  check_note     text,
  stage_focus    text[] NOT NULL DEFAULT '{}',
  industries     text[] NOT NULL DEFAULT '{}',
  tags           text[] NOT NULL DEFAULT '{}',
  location       text,
  email          citext,
  linkedin_url   text,
  website_url    text,
  x_url          text,
  notes          text,
  source         text,
  warm_intro_by  text,
  linkedin_key   text,
  name_key       text NOT NULL,
  search_text    text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_investors PRIMARY KEY (id),
  CONSTRAINT uq_investors_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT ck_investors_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_investors_firm_valid CHECK (firm IS NULL OR length(firm) <= 200),
  CONSTRAINT ck_investors_title_valid CHECK (title IS NULL OR length(title) <= 200),
  CONSTRAINT ck_investors_type_valid CHECK (type IN ('vc', 'angel', 'family_office',
    'corporate_vc', 'accelerator', 'scout', 'other')),
  CONSTRAINT ck_investors_check_min_valid CHECK (check_min IS NULL OR check_min >= 0),
  CONSTRAINT ck_investors_check_max_valid CHECK (check_max IS NULL OR check_max >= 0),
  CONSTRAINT ck_investors_check_note_valid CHECK (check_note IS NULL OR length(check_note) <= 200),
  CONSTRAINT ck_investors_location_valid CHECK (location IS NULL OR length(location) <= 200),
  CONSTRAINT ck_investors_email_valid CHECK (
    email IS NULL OR (length(email) <= 254 AND position('@' IN email) > 1)),
  CONSTRAINT ck_investors_linkedin_url_valid CHECK (linkedin_url IS NULL OR length(linkedin_url) <= 500),
  CONSTRAINT ck_investors_website_url_valid CHECK (website_url IS NULL OR length(website_url) <= 500),
  CONSTRAINT ck_investors_x_url_valid CHECK (x_url IS NULL OR length(x_url) <= 500),
  CONSTRAINT ck_investors_notes_valid CHECK (notes IS NULL OR length(notes) <= 20000),
  CONSTRAINT ck_investors_source_valid CHECK (source IS NULL OR length(source) <= 200),
  CONSTRAINT ck_investors_warm_intro_by_valid CHECK (
    warm_intro_by IS NULL OR length(warm_intro_by) <= 200),
  CONSTRAINT ck_investors_check_range_valid CHECK (
    check_min IS NULL OR check_max IS NULL OR check_min <= check_max),
  CONSTRAINT ck_investors_arrays_valid CHECK (
    cardinality(stage_focus) <= 10 AND cardinality(industries) <= 30 AND cardinality(tags) <= 30),
  CONSTRAINT fk_investors_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_investors_ws_email    ON investors (workspace_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX uq_investors_ws_linkedin ON investors (workspace_id, linkedin_key) WHERE linkedin_key IS NOT NULL;
CREATE INDEX ix_investors_ws_name_key ON investors (workspace_id, name_key);
CREATE INDEX ix_investors_ws_updated  ON investors (workspace_id, updated_at DESC);
CREATE INDEX ix_investors_search_trgm ON investors USING gin (search_text public.gin_trgm_ops);
CREATE INDEX ix_investors_tags        ON investors USING gin (tags);
CREATE INDEX ix_investors_industries  ON investors USING gin (industries);
"""

PARTICIPANTS = """
CREATE TABLE round_participants (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  round_id         uuid NOT NULL,
  investor_id      uuid NOT NULL,
  stage_id         uuid NOT NULL,
  fit              smallint NOT NULL DEFAULT 0,
  probability      smallint,
  amount_soft      bigint,
  amount_committed bigint,
  committed_on     date,
  follow_up_on     date,
  follow_up_note   text,
  next_step        text,
  owner_user_id    uuid,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_round_participants PRIMARY KEY (id),
  CONSTRAINT ck_round_participants_fit_valid CHECK (fit BETWEEN 0 AND 5),
  CONSTRAINT ck_round_participants_probability_valid CHECK (
    probability IS NULL OR probability BETWEEN 0 AND 100),
  CONSTRAINT ck_round_participants_amount_soft_valid CHECK (amount_soft IS NULL OR amount_soft >= 0),
  CONSTRAINT ck_round_participants_amount_committed_valid CHECK (
    amount_committed IS NULL OR amount_committed > 0),
  CONSTRAINT ck_round_participants_follow_up_note_valid CHECK (
    follow_up_note IS NULL OR length(follow_up_note) <= 500),
  CONSTRAINT ck_round_participants_next_step_valid CHECK (
    next_step IS NULL OR length(next_step) <= 500),
  CONSTRAINT fk_round_participants_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_round_participants_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_round_participants_round_stage FOREIGN KEY (round_id, stage_id)
    REFERENCES round_stages (round_id, id),
  CONSTRAINT fk_round_participants_owner_membership FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES memberships (workspace_id, user_id) ON DELETE SET NULL (owner_user_id),
  CONSTRAINT uq_round_participants_round_investor UNIQUE (round_id, investor_id)
);
CREATE INDEX ix_participants_round_stage ON round_participants (round_id, stage_id);
CREATE INDEX ix_participants_investor    ON round_participants (investor_id);
CREATE INDEX ix_participants_followup    ON round_participants (workspace_id, follow_up_on)
  WHERE follow_up_on IS NOT NULL;
"""

ACTIVITIES = """
CREATE TABLE import_runs (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  format        text NOT NULL,
  filename      text,
  round_id      uuid,
  actor_type    text NOT NULL,
  actor_user_id uuid,
  api_key_id    uuid,
  actor_label   text,
  options       jsonb NOT NULL DEFAULT '{}',
  counts        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_import_runs PRIMARY KEY (id),
  CONSTRAINT ck_import_runs_format_valid CHECK (format IN ('csv', 'prototype_json')),
  CONSTRAINT ck_import_runs_filename_valid CHECK (filename IS NULL OR length(filename) <= 255),
  CONSTRAINT ck_import_runs_actor_type_valid CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT fk_import_runs_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_import_runs_actor_user_id_users FOREIGN KEY (actor_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_import_runs_api_key_id_api_keys FOREIGN KEY (api_key_id)
    REFERENCES api_keys (id) ON DELETE SET NULL,
  CONSTRAINT fk_import_runs_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE SET NULL (round_id)
);
CREATE INDEX ix_import_runs_ws_created ON import_runs (workspace_id, created_at DESC);

CREATE TABLE activities (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  investor_id     uuid NOT NULL,
  round_id        uuid,
  kind            text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  body            text,
  data            jsonb NOT NULL DEFAULT '{}',
  actor_type      text NOT NULL,
  actor_user_id   uuid,
  api_key_id      uuid,
  actor_label     text,
  agent_model     text,
  via             text NOT NULL,
  import_run_id   uuid,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_activities PRIMARY KEY (id),
  CONSTRAINT ck_activities_kind_valid CHECK (kind IN ('note', 'email', 'call', 'meeting',
    'stage_change', 'follow_up_set', 'commitment',
    'investor_created', 'investor_updated',
    'added_to_round', 'removed_from_round', 'participant_updated')),
  CONSTRAINT ck_activities_body_valid CHECK (body IS NULL OR length(body) <= 20000),
  CONSTRAINT ck_activities_data_valid CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT ck_activities_actor_type_valid CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT ck_activities_actor_label_valid CHECK (
    actor_label IS NULL OR length(actor_label) <= 120),
  CONSTRAINT ck_activities_agent_model_valid CHECK (
    agent_model IS NULL OR length(agent_model) <= 80),
  CONSTRAINT ck_activities_via_valid CHECK (via IN ('web', 'api', 'mcp', 'import', 'system')),
  CONSTRAINT ck_activities_idempotency_key_valid CHECK (
    idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT ck_activities_actor_label_required CHECK (
    actor_type = 'user' OR actor_label IS NOT NULL),
  CONSTRAINT fk_activities_actor_user_id_users FOREIGN KEY (actor_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_activities_api_key_id_api_keys FOREIGN KEY (api_key_id)
    REFERENCES api_keys (id) ON DELETE SET NULL,
  CONSTRAINT fk_activities_import_run_id_import_runs FOREIGN KEY (import_run_id)
    REFERENCES import_runs (id) ON DELETE SET NULL,
  CONSTRAINT fk_activities_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_activities_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_activities_investor ON activities (investor_id, occurred_at DESC);
CREATE INDEX ix_activities_round    ON activities (round_id, occurred_at DESC) WHERE round_id IS NOT NULL;
CREATE INDEX ix_activities_ws_feed  ON activities (workspace_id, created_at DESC);
CREATE INDEX ix_activities_ws_actor ON activities (workspace_id, actor_type, created_at DESC);
CREATE UNIQUE INDEX uq_activities_idem ON activities (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
"""

# Append-only: only the ON DELETE SET NULL cascades may touch a row (a column becoming NULL).
GUARD_FN = """
CREATE FUNCTION activities_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  nullable_refs CONSTANT text[] := ARRAY['actor_user_id', 'api_key_id', 'import_run_id'];
BEGIN
  IF (to_jsonb(NEW) - nullable_refs) IS DISTINCT FROM (to_jsonb(OLD) - nullable_refs)
     OR (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id)
     OR (NEW.api_key_id IS NOT NULL AND NEW.api_key_id IS DISTINCT FROM OLD.api_key_id)
     OR (NEW.import_run_id IS NOT NULL AND NEW.import_run_id IS DISTINCT FROM OLD.import_run_id)
  THEN
    RAISE EXCEPTION 'activities are append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
"""

GUARD_TRIGGER = """
CREATE TRIGGER activities_guard_update
BEFORE UPDATE ON activities
FOR EACH ROW EXECUTE FUNCTION activities_guard_update();
"""

RATE_LIMITS = """
CREATE UNLOGGED TABLE rate_limit_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  CONSTRAINT pk_rate_limit_counters PRIMARY KEY (bucket, window_start)
);
CREATE INDEX ix_rate_limit_counters_window ON rate_limit_counters (window_start);
"""


def _run(script: str) -> None:
    """asyncpg runs one statement per call: split a script on statement ends."""
    for statement in script.split(";\n"):
        if statement.strip():
            op.execute(statement)


def upgrade() -> None:
    for script in (EXTENSIONS, IDENTITY, ROUNDS, INVESTORS, PARTICIPANTS, ACTIVITIES):
        _run(script)
    op.execute(GUARD_FN)  # one statement: its body contains semicolons
    _run(GUARD_TRIGGER)
    _run(RATE_LIMITS)


def downgrade() -> None:
    for table in (
        "rate_limit_counters",
        "activities",
        "import_runs",
        "round_participants",
        "investors",
        "round_stages",
        "rounds",
        "api_keys",
        "user_sessions",
        "login_tokens",
        "invites",
        "memberships",
        "workspaces",
        "users",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute("DROP FUNCTION IF EXISTS activities_guard_update()")
