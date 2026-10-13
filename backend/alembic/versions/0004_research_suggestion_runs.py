"""research: identity write-back suggestions point at their run (RESEARCH-PLAN §1.8, §4.7).

An identity match (Part 2) fills an investor's empty LinkedIn / website / title / firm and
records each fill as an ``auto_applied`` ``field_suggestions`` row (the "from research"
mark). Those fills happen before any dossier exists, so a suggestion may come from a run
instead of a dossier:

- ``field_suggestions.dossier_id`` becomes nullable;
- ``field_suggestions.run_id`` (composite FK to ``research_runs``, ``SET NULL``) records the
  identity run that made the suggestion.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-13
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UP = (
    "ALTER TABLE field_suggestions ALTER COLUMN dossier_id DROP NOT NULL",
    "ALTER TABLE field_suggestions ADD COLUMN run_id uuid",
    """ALTER TABLE field_suggestions ADD CONSTRAINT fk_field_suggestions_workspace_run
  FOREIGN KEY (workspace_id, run_id) REFERENCES research_runs (workspace_id, id)
  ON DELETE SET NULL (run_id)""",
)

DOWN = (
    "DELETE FROM field_suggestions WHERE dossier_id IS NULL",
    "ALTER TABLE field_suggestions DROP CONSTRAINT IF EXISTS fk_field_suggestions_workspace_run",
    "ALTER TABLE field_suggestions DROP COLUMN IF EXISTS run_id",
    "ALTER TABLE field_suggestions ALTER COLUMN dossier_id SET NOT NULL",
)


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
