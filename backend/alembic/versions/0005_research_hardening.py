"""research hardening after verification (R2 to R4, R9, R12).

- ``workspace_ai_settings.model_prices`` (jsonb): the OpenRouter prices and parameters of the
  workspace's chosen models, stored whenever they are verified (key save, preset change).
  Estimates, the cap pre-check and the worker's reservations read them, so an Advanced
  model's price no longer depends on one process's in-memory cache.
- ``workspace_ai_settings.key_error`` / ``key_error_at``: OpenRouter refused the saved key
  during a run (``openrouter_key_rejected`` / ``openrouter_out_of_credits``). Settings shows
  it; saving the key again clears it.
- ``dossiers.verdict`` may be ``unrated``: written without a company profile, so there is no
  fit verdict and nothing is written to the round's fit.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-13
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UP = (
    "ALTER TABLE workspace_ai_settings ADD COLUMN model_prices jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE workspace_ai_settings ADD COLUMN key_error text",
    "ALTER TABLE workspace_ai_settings ADD COLUMN key_error_at timestamptz",
    "ALTER TABLE dossiers DROP CONSTRAINT ck_dossiers_verdict_valid",
    """ALTER TABLE dossiers ADD CONSTRAINT ck_dossiers_verdict_valid
  CHECK (verdict IN ('strong', 'possible', 'poor', 'unrated'))""",
)

DOWN = (
    "UPDATE dossiers SET verdict = 'possible' WHERE verdict = 'unrated'",
    "ALTER TABLE dossiers DROP CONSTRAINT ck_dossiers_verdict_valid",
    """ALTER TABLE dossiers ADD CONSTRAINT ck_dossiers_verdict_valid
  CHECK (verdict IN ('strong', 'possible', 'poor'))""",
    "ALTER TABLE workspace_ai_settings DROP COLUMN IF EXISTS key_error_at",
    "ALTER TABLE workspace_ai_settings DROP COLUMN IF EXISTS key_error",
    "ALTER TABLE workspace_ai_settings DROP COLUMN IF EXISTS model_prices",
)


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
