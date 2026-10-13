"""research: every table investor research needs (docs/RESEARCH-PLAN.md §1).

One migration for the whole feature so later parts add no schema:

- ``workspace_ai_settings``: preset, model ids, monthly cap and the sealed OpenRouter key
  (envelope encryption: ciphertext under a per-key DEK, the DEK wrapped by the server KEK).
- ``ai_usage_months``: the spend ledger (spent + reserved per workspace month).
- ``company_profiles``: what the company is and wants (rounds inherit it).
- ``jobs``: the Postgres job queue (``FOR UPDATE SKIP LOCKED`` claims, leases).
- ``research_batches`` / ``research_runs``: who researched whom, cost, progress (private).
- ``research_sources``, ``investor_identities``, ``investor_identity_candidates``,
  ``dossier_facts``: the public-facts layer, kept apart from ``dossiers`` and
  ``field_suggestions`` (private analysis), so a future opt-in shared layer reads only
  public tables (R8).
- ``research_removal_requests`` / ``research_suppressions``: the removal process (global).
- ``research_uploads``: transient deck PDFs (deleted after the prefill job).
- ``activities.kind`` gains ``research``.

Workspace tables use composite ``(workspace_id, …)`` foreign keys, so no row can point into
another workspace, and investor / round / workspace deletes cascade.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-13
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _actor(prefix: str = "", *, required: bool = True) -> str:
    """Actor columns shaped like ``activities`` (who asked, through which channel)."""
    p = prefix
    null = "NOT NULL" if required else ""
    return f"""
  {p}actor_type    text {null},
  {p}actor_user_id uuid,
  {p}api_key_id    uuid,
  {p}actor_label   text,
  {p}agent_model   text,
  {p}via           text {null},"""


def _actor_checks(table: str, prefix: str = "", *, required: bool = True) -> str:
    p = prefix
    opt_type = "" if required else f"{p}actor_type IS NULL OR "
    opt_via = "" if required else f"{p}via IS NULL OR "
    return f"""
  CONSTRAINT ck_{table}_{p}actor_type_valid CHECK (
    {opt_type}{p}actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT ck_{table}_{p}via_valid CHECK (
    {opt_via}{p}via IN ('web', 'api', 'mcp', 'import', 'system')),
  CONSTRAINT ck_{table}_{p}actor_label_valid CHECK (
    {p}actor_label IS NULL OR length({p}actor_label) <= 120),
  CONSTRAINT ck_{table}_{p}agent_model_valid CHECK (
    {p}agent_model IS NULL OR length({p}agent_model) <= 80),
  CONSTRAINT fk_{table}_{p}actor_user_id_users FOREIGN KEY ({p}actor_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_{table}_{p}api_key_id_api_keys FOREIGN KEY ({p}api_key_id)
    REFERENCES api_keys (id) ON DELETE SET NULL,"""


SETTINGS = """
CREATE TABLE workspace_ai_settings (
  workspace_id        uuid NOT NULL,
  preset              text NOT NULL DEFAULT 'best',
  identity_model      text NOT NULL DEFAULT 'perplexity/sonar',
  search_model        text NOT NULL DEFAULT 'perplexity/sonar-pro',
  writer_model        text NOT NULL DEFAULT 'anthropic/claude-opus-5.5',
  monthly_cap_micros  bigint NOT NULL DEFAULT 25000000,
  key_ciphertext      bytea,
  key_nonce           bytea,
  key_dek_wrapped     bytea,
  key_dek_nonce       bytea,
  key_kek_id          text,
  key_last4           text,
  key_label           text,
  key_set_at          timestamptz,
  key_set_by_user_id  uuid,
  key_validated_at    timestamptz,
  models_verified_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_workspace_ai_settings PRIMARY KEY (workspace_id),
  CONSTRAINT ck_workspace_ai_settings_preset_valid CHECK (
    preset IN ('best', 'balanced', 'budget', 'custom')),
  CONSTRAINT ck_workspace_ai_settings_models_valid CHECK (
    length(identity_model) BETWEEN 1 AND 200 AND length(search_model) BETWEEN 1 AND 200
    AND length(writer_model) BETWEEN 1 AND 200),
  CONSTRAINT ck_workspace_ai_settings_cap_valid CHECK (
    monthly_cap_micros BETWEEN 0 AND 10000000000),
  CONSTRAINT ck_workspace_ai_settings_key_complete CHECK (
    (key_ciphertext IS NULL AND key_nonce IS NULL AND key_dek_wrapped IS NULL
      AND key_dek_nonce IS NULL AND key_kek_id IS NULL AND key_last4 IS NULL)
    OR (key_ciphertext IS NOT NULL AND key_nonce IS NOT NULL AND key_dek_wrapped IS NOT NULL
      AND key_dek_nonce IS NOT NULL AND key_kek_id IS NOT NULL AND key_last4 IS NOT NULL)),
  CONSTRAINT ck_workspace_ai_settings_key_last4_valid CHECK (
    key_last4 IS NULL OR length(key_last4) BETWEEN 1 AND 4),
  CONSTRAINT ck_workspace_ai_settings_key_kek_id_valid CHECK (
    key_kek_id IS NULL OR length(key_kek_id) BETWEEN 1 AND 32),
  CONSTRAINT ck_workspace_ai_settings_key_label_valid CHECK (
    key_label IS NULL OR length(key_label) <= 200),
  CONSTRAINT fk_workspace_ai_settings_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_workspace_ai_settings_key_set_by_user_id_users FOREIGN KEY (key_set_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE ai_usage_months (
  workspace_id    uuid NOT NULL,
  month           date NOT NULL,
  spent_micros    bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,
  calls           integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_ai_usage_months PRIMARY KEY (workspace_id, month),
  CONSTRAINT ck_ai_usage_months_month_valid CHECK (extract(day FROM month) = 1),
  CONSTRAINT ck_ai_usage_months_amounts_valid CHECK (
    spent_micros >= 0 AND reserved_micros >= 0 AND calls >= 0),
  CONSTRAINT fk_ai_usage_months_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE
);

CREATE TABLE company_profiles (
  workspace_id       uuid NOT NULL,
  pitch              text,
  sectors            text[] NOT NULL DEFAULT '{}',
  stage              text,
  location           text,
  traction           text[] NOT NULL DEFAULT '{}',
  wants_lead         text,
  check_min          bigint,
  check_max          bigint,
  strategic_help     text,
  website_url        text,
  deck_filename      text,
  prefilled_at       timestamptz,
  updated_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_company_profiles PRIMARY KEY (workspace_id),
  CONSTRAINT ck_company_profiles_pitch_valid CHECK (pitch IS NULL OR length(pitch) <= 200),
  CONSTRAINT ck_company_profiles_sectors_valid CHECK (cardinality(sectors) <= 10),
  CONSTRAINT ck_company_profiles_stage_valid CHECK (
    stage IS NULL OR stage IN ('pre-seed', 'seed', 'series-a', 'series-b+', 'other')),
  CONSTRAINT ck_company_profiles_location_valid CHECK (
    location IS NULL OR length(location) <= 200),
  CONSTRAINT ck_company_profiles_traction_valid CHECK (cardinality(traction) <= 3),
  CONSTRAINT ck_company_profiles_wants_lead_valid CHECK (
    wants_lead IS NULL OR wants_lead IN ('lead', 'follow', 'either')),
  CONSTRAINT ck_company_profiles_check_valid CHECK (
    (check_min IS NULL OR check_min >= 0) AND (check_max IS NULL OR check_max >= 0)
    AND (check_min IS NULL OR check_max IS NULL OR check_min <= check_max)),
  CONSTRAINT ck_company_profiles_strategic_help_valid CHECK (
    strategic_help IS NULL OR length(strategic_help) <= 500),
  CONSTRAINT ck_company_profiles_website_url_valid CHECK (
    website_url IS NULL OR length(website_url) <= 500),
  CONSTRAINT ck_company_profiles_deck_filename_valid CHECK (
    deck_filename IS NULL OR length(deck_filename) <= 255),
  CONSTRAINT fk_company_profiles_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_company_profiles_updated_by_user_id_users FOREIGN KEY (updated_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
)
"""

JOBS = """
CREATE TABLE jobs (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued',
  priority     smallint NOT NULL DEFAULT 100,
  attempts     smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CONSTRAINT pk_jobs PRIMARY KEY (id),
  CONSTRAINT ck_jobs_kind_valid CHECK (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),
  CONSTRAINT ck_jobs_payload_valid CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ck_jobs_status_valid CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT ck_jobs_attempts_valid CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 50),
  CONSTRAINT ck_jobs_running_locked CHECK (
    status <> 'running' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  CONSTRAINT ck_jobs_last_error_valid CHECK (last_error IS NULL OR length(last_error) <= 500),
  CONSTRAINT ck_jobs_dedupe_key_valid CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 200),
  CONSTRAINT fk_jobs_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE INDEX ix_jobs_claim ON jobs (priority, run_after, created_at) WHERE status = 'queued';
CREATE INDEX ix_jobs_lease ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX ix_jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX ix_jobs_workspace ON jobs (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX uq_jobs_dedupe_active ON jobs (dedupe_key)
  WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL
"""

RUNS = f"""
CREATE TABLE research_batches (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  kind             text NOT NULL,
  round_id         uuid,
  total            integer NOT NULL,
  estimate_micros  bigint NOT NULL DEFAULT 0,
  confirmed_micros bigint,{_actor()}
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_batches PRIMARY KEY (id),
  CONSTRAINT uq_research_batches_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT ck_research_batches_kind_valid CHECK (kind IN ('identity', 'dossier')),
  CONSTRAINT ck_research_batches_total_valid CHECK (total BETWEEN 0 AND 1000),
  CONSTRAINT ck_research_batches_amounts_valid CHECK (
    estimate_micros >= 0 AND (confirmed_micros IS NULL OR confirmed_micros >= 0)),{_actor_checks("research_batches")}
  CONSTRAINT fk_research_batches_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_research_batches_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE SET NULL (round_id)
);
CREATE INDEX ix_research_batches_ws_created ON research_batches (workspace_id, created_at DESC);

CREATE TABLE research_runs (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  investor_id     uuid,
  round_id        uuid,
  batch_id        uuid,
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',
  preset          text,
  identity_model  text,
  search_model    text,
  writer_model    text,
  estimate_micros bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,
  reserved_month  date,
  cost_micros     bigint NOT NULL DEFAULT 0,
  usage           jsonb NOT NULL DEFAULT '[]',
  progress        jsonb NOT NULL DEFAULT '{{}}',
  result          jsonb,
  error_code      text,
  error_message   text,
  dossier_id      uuid,{_actor()}
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_runs PRIMARY KEY (id),
  CONSTRAINT uq_research_runs_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT ck_research_runs_kind_valid CHECK (
    kind IN ('identity', 'dossier', 'refresh', 'prefill', 'agent')),
  CONSTRAINT ck_research_runs_status_valid CHECK (status IN ('queued', 'running', 'succeeded',
    'partial', 'failed', 'cancelled', 'capped', 'blocked_identity')),
  CONSTRAINT ck_research_runs_preset_valid CHECK (
    preset IS NULL OR preset IN ('best', 'balanced', 'budget', 'custom')),
  CONSTRAINT ck_research_runs_investor_required CHECK (kind = 'prefill' OR investor_id IS NOT NULL),
  CONSTRAINT ck_research_runs_amounts_valid CHECK (
    estimate_micros >= 0 AND reserved_micros >= 0 AND cost_micros >= 0),
  CONSTRAINT ck_research_runs_reserved_month CHECK (reserved_micros = 0 OR reserved_month IS NOT NULL),
  CONSTRAINT ck_research_runs_json_valid CHECK (
    jsonb_typeof(usage) = 'array' AND jsonb_typeof(progress) = 'object'),
  CONSTRAINT ck_research_runs_error_valid CHECK (
    (error_code IS NULL OR length(error_code) <= 64)
    AND (error_message IS NULL OR length(error_message) <= 500)),{_actor_checks("research_runs")}
  CONSTRAINT fk_research_runs_workspace_id_workspaces FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_research_runs_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_research_runs_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE SET NULL (round_id),
  CONSTRAINT fk_research_runs_workspace_batch FOREIGN KEY (workspace_id, batch_id)
    REFERENCES research_batches (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_research_runs_investor ON research_runs (workspace_id, investor_id, created_at DESC);
CREATE INDEX ix_research_runs_ws_created ON research_runs (workspace_id, created_at DESC);
CREATE INDEX ix_research_runs_batch ON research_runs (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX ix_research_runs_active ON research_runs (workspace_id)
  WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX uq_research_runs_active_kind ON research_runs (investor_id, kind)
  WHERE status IN ('queued', 'running') AND investor_id IS NOT NULL;
CREATE UNIQUE INDEX uq_research_runs_active_prefill ON research_runs (workspace_id)
  WHERE status IN ('queued', 'running') AND kind = 'prefill'
"""

PUBLIC_LAYER = f"""
CREATE TABLE research_sources (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  run_id          uuid,
  investor_id     uuid NOT NULL,
  url             text NOT NULL,
  url_key         text NOT NULL,
  domain          text NOT NULL,
  title           text,
  snippet         text,
  published_at    date,
  fetched_at      timestamptz NOT NULL,
  matched_anchor  text,
  accepted        boolean NOT NULL DEFAULT false,
  rejected_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_sources PRIMARY KEY (id),
  CONSTRAINT uq_research_sources_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT ck_research_sources_url_valid CHECK (
    length(url) BETWEEN 1 AND 2000 AND length(url_key) BETWEEN 1 AND 2000
    AND length(domain) BETWEEN 1 AND 255),
  CONSTRAINT ck_research_sources_title_valid CHECK (title IS NULL OR length(title) <= 300),
  CONSTRAINT ck_research_sources_snippet_valid CHECK (snippet IS NULL OR length(snippet) <= 1200),
  CONSTRAINT ck_research_sources_matched_anchor_valid CHECK (matched_anchor IS NULL
    OR matched_anchor IN ('linkedin', 'firm_domain', 'name_firm', 'name_title')),
  CONSTRAINT ck_research_sources_rejected_reason_valid CHECK (rejected_reason IS NULL
    OR rejected_reason IN ('anchor_mismatch', 'personal_domain', 'privacy', 'duplicate')),
  CONSTRAINT ck_research_sources_accepted_consistent CHECK (
    NOT accepted OR (matched_anchor IS NOT NULL AND rejected_reason IS NULL)),
  CONSTRAINT fk_research_sources_workspace_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_research_sources_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_research_sources_run_url ON research_sources (run_id, url_key)
  WHERE run_id IS NOT NULL;
CREATE INDEX ix_research_sources_investor ON research_sources (workspace_id, investor_id);

CREATE TABLE investor_identities (
  workspace_id uuid NOT NULL,
  investor_id  uuid NOT NULL,
  status       text NOT NULL DEFAULT 'none',
  linkedin_url text,
  linkedin_key text,
  firm         text,
  firm_website text,
  firm_domain  text,
  title        text,
  confidence   numeric(4, 3),
  source       text,
  run_id       uuid,{_actor(required=False)}
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_investor_identities PRIMARY KEY (workspace_id, investor_id),
  CONSTRAINT ck_investor_identities_status_valid CHECK (status IN ('none', 'pending', 'matched',
    'confirmed', 'needs_pick', 'not_found', 'rejected')),
  CONSTRAINT ck_investor_identities_source_valid CHECK (
    source IS NULL OR source IN ('auto', 'user', 'agent', 'existing')),
  CONSTRAINT ck_investor_identities_confidence_valid CHECK (
    confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT ck_investor_identities_fields_valid CHECK (
    (linkedin_url IS NULL OR length(linkedin_url) <= 500)
    AND (firm IS NULL OR length(firm) <= 200)
    AND (firm_website IS NULL OR length(firm_website) <= 500)
    AND (firm_domain IS NULL OR length(firm_domain) <= 255)
    AND (title IS NULL OR length(title) <= 200)),{_actor_checks("investor_identities", required=False)}
  CONSTRAINT fk_investor_identities_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_investor_identities_workspace_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE SET NULL (run_id)
);
CREATE INDEX ix_investor_identities_linkedin_key ON investor_identities (linkedin_key)
  WHERE linkedin_key IS NOT NULL;

CREATE TABLE investor_identity_candidates (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  investor_id         uuid NOT NULL,
  run_id              uuid NOT NULL,
  rank                smallint NOT NULL,
  name                text NOT NULL,
  title               text,
  firm                text,
  linkedin_url        text,
  firm_website        text,
  confidence          numeric(4, 3) NOT NULL,
  evidence_source_ids uuid[] NOT NULL DEFAULT '{{}}',
  picked              boolean,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_investor_identity_candidates PRIMARY KEY (id),
  CONSTRAINT ck_investor_identity_candidates_rank_valid CHECK (rank BETWEEN 1 AND 3),
  CONSTRAINT ck_investor_identity_candidates_confidence_valid CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT ck_investor_identity_candidates_fields_valid CHECK (
    length(name) BETWEEN 1 AND 200
    AND (title IS NULL OR length(title) <= 200)
    AND (firm IS NULL OR length(firm) <= 200)
    AND (linkedin_url IS NULL OR length(linkedin_url) <= 500)
    AND (firm_website IS NULL OR length(firm_website) <= 500)
    AND cardinality(evidence_source_ids) <= 20),
  CONSTRAINT fk_investor_identity_candidates_workspace_investor FOREIGN KEY (
    workspace_id, investor_id) REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_investor_identity_candidates_workspace_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_investor_identity_candidates_investor ON investor_identity_candidates (
  investor_id, rank)
"""

DOSSIERS = f"""
CREATE TABLE dossiers (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  investor_id    uuid NOT NULL,
  round_id       uuid,
  run_id         uuid,
  version        integer NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1,
  author_kind    text NOT NULL,
  author_label   text NOT NULL,
  verdict        text NOT NULL,
  analysis       jsonb NOT NULL DEFAULT '{{}}',
  unverified     jsonb NOT NULL DEFAULT '[]',
  previous_id    uuid,
  new_fact_keys  text[] NOT NULL DEFAULT '{{}}',{_actor()}
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_dossiers PRIMARY KEY (id),
  CONSTRAINT uq_dossiers_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT uq_dossiers_investor_version UNIQUE (investor_id, version),
  CONSTRAINT ck_dossiers_version_valid CHECK (version >= 1 AND schema_version >= 1),
  CONSTRAINT ck_dossiers_author_kind_valid CHECK (author_kind IN ('model', 'agent')),
  CONSTRAINT ck_dossiers_author_label_valid CHECK (length(author_label) BETWEEN 1 AND 200),
  CONSTRAINT ck_dossiers_verdict_valid CHECK (verdict IN ('strong', 'possible', 'poor')),
  CONSTRAINT ck_dossiers_json_valid CHECK (
    jsonb_typeof(analysis) = 'object' AND jsonb_typeof(unverified) = 'array'),
  CONSTRAINT ck_dossiers_new_fact_keys_valid CHECK (cardinality(new_fact_keys) <= 100),{_actor_checks("dossiers")}
  CONSTRAINT fk_dossiers_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_dossiers_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE SET NULL (round_id),
  CONSTRAINT fk_dossiers_workspace_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE SET NULL (run_id),
  CONSTRAINT fk_dossiers_workspace_previous FOREIGN KEY (workspace_id, previous_id)
    REFERENCES dossiers (workspace_id, id) ON DELETE SET NULL (previous_id)
);
CREATE INDEX ix_dossiers_investor ON dossiers (workspace_id, investor_id, version DESC);

ALTER TABLE research_runs ADD CONSTRAINT fk_research_runs_workspace_dossier
  FOREIGN KEY (workspace_id, dossier_id) REFERENCES dossiers (workspace_id, id)
  ON DELETE SET NULL (dossier_id);

CREATE TABLE dossier_facts (
  dossier_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  investor_id  uuid NOT NULL,
  identity     jsonb NOT NULL DEFAULT '{{}}',
  facts        jsonb NOT NULL DEFAULT '[]',
  as_of        date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_dossier_facts PRIMARY KEY (dossier_id),
  CONSTRAINT ck_dossier_facts_json_valid CHECK (
    jsonb_typeof(identity) = 'object' AND jsonb_typeof(facts) = 'array'),
  CONSTRAINT fk_dossier_facts_workspace_dossier FOREIGN KEY (workspace_id, dossier_id)
    REFERENCES dossiers (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_dossier_facts_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE field_suggestions (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  investor_id     uuid NOT NULL,
  round_id        uuid,
  dossier_id      uuid NOT NULL,
  field           text NOT NULL,
  current_value   jsonb,
  suggested_value jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  decided_at      timestamptz,{_actor("decider_", required=False)}
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_field_suggestions PRIMARY KEY (id),
  CONSTRAINT ck_field_suggestions_field_valid CHECK (field IN ('firm', 'title', 'type',
    'location', 'linkedin_url', 'website_url', 'email', 'check_min', 'check_max',
    'stage_focus', 'industries', 'fit')),
  CONSTRAINT ck_field_suggestions_status_valid CHECK (
    status IN ('pending', 'accepted', 'ignored', 'auto_applied', 'superseded')),
  CONSTRAINT ck_field_suggestions_fit_round CHECK ((field = 'fit') = (round_id IS NOT NULL)),{_actor_checks("field_suggestions", "decider_", required=False)}
  CONSTRAINT fk_field_suggestions_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_field_suggestions_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_field_suggestions_workspace_dossier FOREIGN KEY (workspace_id, dossier_id)
    REFERENCES dossiers (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_field_suggestions_pending ON field_suggestions (
  investor_id, coalesce(round_id, '00000000-0000-0000-0000-000000000000'::uuid), field)
  WHERE status = 'pending';
CREATE INDEX ix_field_suggestions_investor ON field_suggestions (workspace_id, investor_id, status)
"""

GLOBAL = """
CREATE TABLE research_removal_requests (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          citext NOT NULL,
  linkedin_url   text,
  firm           text,
  message        text,
  token_hash     bytea NOT NULL,
  status         text NOT NULL DEFAULT 'unverified',
  verified_at    timestamptz,
  decided_at     timestamptz,
  decided_note   text,
  applied_counts jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_removal_requests PRIMARY KEY (id),
  CONSTRAINT uq_research_removal_requests_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_research_removal_requests_status_valid CHECK (
    status IN ('unverified', 'verified', 'applied', 'rejected')),
  CONSTRAINT ck_research_removal_requests_fields_valid CHECK (
    length(btrim(name)) BETWEEN 1 AND 200
    AND length(email) <= 254 AND position('@' IN email) > 1
    AND (linkedin_url IS NULL OR length(linkedin_url) <= 500)
    AND (firm IS NULL OR length(firm) <= 200)
    AND (message IS NULL OR length(message) <= 2000)
    AND (decided_note IS NULL OR length(decided_note) <= 500))
);
CREATE INDEX ix_research_removal_requests_status ON research_removal_requests (status, created_at);

CREATE TABLE research_suppressions (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  linkedin_key text,
  email_sha256 bytea,
  name_key     text,
  request_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_suppressions PRIMARY KEY (id),
  CONSTRAINT ck_research_suppressions_any_key CHECK (
    linkedin_key IS NOT NULL OR email_sha256 IS NOT NULL OR name_key IS NOT NULL),
  CONSTRAINT fk_research_suppressions_request_id_research_removal_requests
    FOREIGN KEY (request_id) REFERENCES research_removal_requests (id) ON DELETE SET NULL
);
CREATE INDEX ix_research_suppressions_linkedin ON research_suppressions (linkedin_key)
  WHERE linkedin_key IS NOT NULL;
CREATE INDEX ix_research_suppressions_email ON research_suppressions (email_sha256)
  WHERE email_sha256 IS NOT NULL;
CREATE INDEX ix_research_suppressions_name ON research_suppressions (name_key)
  WHERE name_key IS NOT NULL;

CREATE TABLE research_uploads (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id       uuid NOT NULL,
  filename     text NOT NULL,
  content      bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_uploads PRIMARY KEY (id),
  CONSTRAINT ck_research_uploads_filename_valid CHECK (length(filename) BETWEEN 1 AND 255),
  CONSTRAINT ck_research_uploads_content_valid CHECK (octet_length(content) <= 10485760),
  CONSTRAINT fk_research_uploads_workspace_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_research_uploads_created ON research_uploads (created_at)
"""

_OLD_KINDS = (
    "'note', 'email', 'call', 'meeting', 'stage_change', 'follow_up_set', 'commitment', "
    "'investor_created', 'investor_updated', 'added_to_round', 'removed_from_round', "
    "'participant_updated'"
)

ACTIVITY_KIND_UP = (
    "ALTER TABLE activities DROP CONSTRAINT ck_activities_kind_valid",
    f"ALTER TABLE activities ADD CONSTRAINT ck_activities_kind_valid CHECK (kind IN ({_OLD_KINDS}, 'research'))",
)

ACTIVITY_KIND_DOWN = (
    "DELETE FROM activities WHERE kind = 'research'",
    "ALTER TABLE activities DROP CONSTRAINT ck_activities_kind_valid",
    f"ALTER TABLE activities ADD CONSTRAINT ck_activities_kind_valid CHECK (kind IN ({_OLD_KINDS}))",
)

TABLES_DOWN = (
    "research_uploads",
    "research_suppressions",
    "research_removal_requests",
    "field_suggestions",
    "dossier_facts",
    "investor_identity_candidates",
    "investor_identities",
    "research_sources",
)


def _run(script: str) -> None:
    """asyncpg runs one statement per call: split a script on statement ends."""
    for statement in script.split(";\n"):
        if statement.strip():
            op.execute(statement)


def upgrade() -> None:
    for script in (SETTINGS, JOBS, RUNS, PUBLIC_LAYER, DOSSIERS, GLOBAL):
        _run(script)
    for statement in ACTIVITY_KIND_UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in ACTIVITY_KIND_DOWN:
        op.execute(statement)
    for table in TABLES_DOWN:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute(
        "ALTER TABLE research_runs DROP CONSTRAINT IF EXISTS fk_research_runs_workspace_dossier"
    )
    for table in (
        "dossiers",
        "research_runs",
        "research_batches",
        "jobs",
        "company_profiles",
        "ai_usage_months",
        "workspace_ai_settings",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
