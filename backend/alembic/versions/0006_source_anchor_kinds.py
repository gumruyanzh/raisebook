"""research sources: more ways a page can match the anchor, and the ``conflict`` rejection.

- ``research_sources.matched_anchor`` may also be ``profile`` (the person's own X account),
  ``name_past_firm`` (the name with a firm the person is known to have left) and ``name`` (a
  distinctive full name with nothing pointing at someone else).
- ``research_sources.rejected_reason`` may also be ``conflict``: the name next to another firm
  than the anchor's or a known past one (likely someone else with the same name).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-13
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UP = (
    "ALTER TABLE research_sources DROP CONSTRAINT ck_research_sources_matched_anchor_valid",
    """ALTER TABLE research_sources ADD CONSTRAINT ck_research_sources_matched_anchor_valid
  CHECK (matched_anchor IS NULL OR matched_anchor IN ('linkedin', 'firm_domain', 'name_firm',
    'name_title', 'profile', 'name_past_firm', 'name'))""",
    "ALTER TABLE research_sources DROP CONSTRAINT ck_research_sources_rejected_reason_valid",
    """ALTER TABLE research_sources ADD CONSTRAINT ck_research_sources_rejected_reason_valid
  CHECK (rejected_reason IS NULL OR rejected_reason IN ('anchor_mismatch', 'conflict',
    'personal_domain', 'privacy', 'duplicate'))""",
)

DOWN = (
    """UPDATE research_sources SET matched_anchor = 'name_firm'
  WHERE matched_anchor IN ('profile', 'name_past_firm', 'name')""",
    "UPDATE research_sources SET rejected_reason = 'anchor_mismatch' WHERE rejected_reason = 'conflict'",
    "ALTER TABLE research_sources DROP CONSTRAINT ck_research_sources_matched_anchor_valid",
    """ALTER TABLE research_sources ADD CONSTRAINT ck_research_sources_matched_anchor_valid
  CHECK (matched_anchor IS NULL
    OR matched_anchor IN ('linkedin', 'firm_domain', 'name_firm', 'name_title'))""",
    "ALTER TABLE research_sources DROP CONSTRAINT ck_research_sources_rejected_reason_valid",
    """ALTER TABLE research_sources ADD CONSTRAINT ck_research_sources_rejected_reason_valid
  CHECK (rejected_reason IS NULL
    OR rejected_reason IN ('anchor_mismatch', 'personal_domain', 'privacy', 'duplicate'))""",
)


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
