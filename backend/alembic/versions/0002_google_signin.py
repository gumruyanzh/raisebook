"""Continue with Google: ``users.google_sub``.

The Google account id (OIDC ``sub``) bound on a user's first Google sign-in. Nullable
(magic-link-only accounts have none) and unique (one Google account, one Raisebook
account). Adding a nullable column is metadata-only in Postgres: no table rewrite.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


UPGRADE = (
    "ALTER TABLE users ADD COLUMN google_sub text",
    "ALTER TABLE users ADD CONSTRAINT uq_users_google_sub UNIQUE (google_sub)",
    "ALTER TABLE users ADD CONSTRAINT ck_users_google_sub_valid"
    " CHECK (google_sub IS NULL OR length(google_sub) BETWEEN 1 AND 255)",
)

DOWNGRADE = (
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_google_sub_valid",
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_google_sub",
    "ALTER TABLE users DROP COLUMN IF EXISTS google_sub",
)


def upgrade() -> None:
    # asyncpg runs one statement per call.
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
