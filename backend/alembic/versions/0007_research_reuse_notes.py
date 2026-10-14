"""research: investor notes as starting facts (owner decision 2026-10-14).

- ``workspace_ai_settings.use_notes_in_research`` (default false): when an owner or admin
  turns it on, the investor's notes (trimmed, privacy-filtered) go to the search prompts as
  "already known" and to the writer as facts labeled "from your notes".

Fresh-dossier skipping and reuse across one owner's workspaces need no schema: they read
existing rows (``dossiers``, ``research_runs``, ``research_sources``, ``investor_identities``).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UP = (
    "ALTER TABLE workspace_ai_settings"
    " ADD COLUMN use_notes_in_research boolean NOT NULL DEFAULT false",
)

DOWN = ("ALTER TABLE workspace_ai_settings DROP COLUMN use_notes_in_research",)


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
