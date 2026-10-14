"""meetings: scheduled meetings with investors and a private per-user calendar feed.

- ``meetings``: one investor (``investor_id``, cascade), an optional round (``round_id``, set
  to NULL when the round is deleted), start and end (timestamptz, at most 24 hours), the
  workspace timezone at scheduling, place, video link, agenda, status (scheduled, done,
  cancelled, no_show), the outcome and the ``meeting`` activity that recorded it, the source
  (manual, email, agent, calendar), an ICS ``sequence`` and who scheduled it.
- ``meeting_guests``: more people from the same firm (cascade on either side).
- ``calendar_feeds``: one hashed secret per user for the ICS subscription URL.
- ``activities.kind`` gains ``meeting_scheduled`` and ``meeting_updated``; activities about a
  meeting carry ``data.meeting_id`` (indexed), so the timeline is the meeting's audit trail.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MEETINGS = """
CREATE TABLE meetings (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  investor_id         uuid NOT NULL,
  round_id            uuid,
  title               text NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  timezone            text NOT NULL,
  location            text,
  video_url           text,
  agenda              text,
  status              text NOT NULL DEFAULT 'scheduled',
  outcome             text,
  outcome_activity_id uuid,
  source              text NOT NULL DEFAULT 'manual',
  sequence            integer NOT NULL DEFAULT 0,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  actor_type          text NOT NULL,
  actor_user_id       uuid,
  api_key_id          uuid,
  actor_label         text,
  agent_model         text,
  via                 text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_meetings PRIMARY KEY (id),
  CONSTRAINT uq_meetings_workspace_id_id UNIQUE (workspace_id, id),
  CONSTRAINT ck_meetings_title_valid CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT ck_meetings_time_valid CHECK (
    ends_at > starts_at AND ends_at <= starts_at + interval '24 hours'),
  CONSTRAINT ck_meetings_timezone_valid CHECK (length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT ck_meetings_location_valid CHECK (location IS NULL OR length(location) <= 500),
  CONSTRAINT ck_meetings_video_url_valid CHECK (
    video_url IS NULL OR (length(video_url) <= 1000 AND video_url ~* '^https?://')),
  CONSTRAINT ck_meetings_agenda_valid CHECK (agenda IS NULL OR length(agenda) <= 5000),
  CONSTRAINT ck_meetings_outcome_valid CHECK (outcome IS NULL OR length(outcome) <= 5000),
  CONSTRAINT ck_meetings_status_valid CHECK (
    status IN ('scheduled', 'done', 'cancelled', 'no_show')),
  CONSTRAINT ck_meetings_source_valid CHECK (
    source IN ('manual', 'email', 'agent', 'calendar')),
  CONSTRAINT ck_meetings_actor_type_valid CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT ck_meetings_via_valid CHECK (via IN ('web', 'api', 'mcp', 'import', 'system')),
  CONSTRAINT ck_meetings_actor_label_valid CHECK (
    actor_label IS NULL OR length(actor_label) <= 120),
  CONSTRAINT ck_meetings_agent_model_valid CHECK (
    agent_model IS NULL OR length(agent_model) <= 80),
  CONSTRAINT fk_meetings_workspace FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT fk_meetings_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_meetings_workspace_round FOREIGN KEY (workspace_id, round_id)
    REFERENCES rounds (workspace_id, id) ON DELETE SET NULL (round_id),
  CONSTRAINT fk_meetings_outcome_activity FOREIGN KEY (outcome_activity_id)
    REFERENCES activities (id) ON DELETE SET NULL,
  CONSTRAINT fk_meetings_actor_user_id_users FOREIGN KEY (actor_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_meetings_api_key_id_api_keys FOREIGN KEY (api_key_id)
    REFERENCES api_keys (id) ON DELETE SET NULL
);
CREATE INDEX ix_meetings_ws_starts ON meetings (workspace_id, starts_at);
CREATE INDEX ix_meetings_investor ON meetings (investor_id, starts_at);
CREATE INDEX ix_meetings_round ON meetings (round_id, starts_at) WHERE round_id IS NOT NULL;
CREATE TABLE meeting_guests (
  meeting_id   uuid NOT NULL,
  investor_id  uuid NOT NULL,
  workspace_id uuid NOT NULL,
  CONSTRAINT pk_meeting_guests PRIMARY KEY (meeting_id, investor_id),
  CONSTRAINT fk_meeting_guests_workspace_meeting FOREIGN KEY (workspace_id, meeting_id)
    REFERENCES meetings (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_guests_workspace_investor FOREIGN KEY (workspace_id, investor_id)
    REFERENCES investors (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_meeting_guests_investor ON meeting_guests (investor_id);
CREATE TABLE calendar_feeds (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  token_hash   bytea NOT NULL,
  token_hint   text NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_calendar_feeds PRIMARY KEY (id),
  CONSTRAINT uq_calendar_feeds_user_id UNIQUE (user_id),
  CONSTRAINT uq_calendar_feeds_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_calendar_feeds_token_hint_valid CHECK (length(token_hint) <= 8),
  CONSTRAINT fk_calendar_feeds_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_activities_meeting ON activities ((data->>'meeting_id'))
  WHERE data ? 'meeting_id'
"""

_OLD_KINDS = (
    "'note', 'email', 'call', 'meeting', 'stage_change', 'follow_up_set', 'commitment', "
    "'investor_created', 'investor_updated', 'added_to_round', 'removed_from_round', "
    "'participant_updated', 'research'"
)

ACTIVITY_KIND_UP = (
    "ALTER TABLE activities DROP CONSTRAINT ck_activities_kind_valid",
    "ALTER TABLE activities ADD CONSTRAINT ck_activities_kind_valid CHECK (kind IN ("
    f"{_OLD_KINDS}, 'meeting_scheduled', 'meeting_updated'))",
)

DOWN = (
    "DROP INDEX IF EXISTS ix_activities_meeting",
    "DROP TABLE IF EXISTS calendar_feeds",
    "DROP TABLE IF EXISTS meeting_guests",
    "DROP TABLE IF EXISTS meetings",
    "DELETE FROM activities WHERE kind IN ('meeting_scheduled', 'meeting_updated')",
    "ALTER TABLE activities DROP CONSTRAINT ck_activities_kind_valid",
    f"ALTER TABLE activities ADD CONSTRAINT ck_activities_kind_valid CHECK (kind IN ({_OLD_KINDS}))",
)


def _run(script: str) -> None:
    """asyncpg runs one statement per call: split a script on statement ends."""
    for statement in script.split(";\n"):
        if statement.strip():
            op.execute(statement)


def upgrade() -> None:
    _run(MEETINGS)
    for statement in ACTIVITY_KIND_UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
