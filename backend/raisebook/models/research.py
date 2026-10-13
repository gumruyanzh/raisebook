"""Investor research tables (RESEARCH-PLAN §1.5 to §1.13). ORM mirrors of 0003_research.

Public facts (``research_sources``, ``investor_identities``, ``investor_identity_candidates``,
``dossier_facts``) live apart from private analysis (``dossiers``, ``research_runs``,
``research_batches``, ``field_suggestions``) so a future opt-in shared layer reads only the
public tables (R8). Composite ``(workspace_id, …)`` foreign keys keep every link inside one
workspace.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.actor import Actor
from raisebook.core.database import Base
from raisebook.models._common import CreatedAtMixin, TimestampMixin, check_in, pk
from raisebook.models.enums import (
    IdentityStatus,
    RemovalStatus,
    ResearchKind,
    RunStatus,
    SuggestionStatus,
    Verdict,
)


def _ws_fk(local: str, table: str, *, ondelete: str, name: str) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(
        ["workspace_id", local],
        [f"{table}.workspace_id", f"{table}.id"],
        ondelete=ondelete,
        name=name,
    )


class ActorColumns:
    """Who asked (shaped like ``activities``); the worker acts as this actor."""

    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    actor_label: Mapped[str | None] = mapped_column(Text)
    agent_model: Mapped[str | None] = mapped_column(Text)
    via: Mapped[str] = mapped_column(Text, nullable=False)

    def set_actor(self, actor: Actor) -> None:
        for k, v in actor.activity_fields().items():
            setattr(self, k, v)


class ResearchBatch(ActorColumns, CreatedAtMixin, Base):
    __tablename__ = "research_batches"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id", name="uq_research_batches_workspace_id_id"),
        _ws_fk("round_id", "rounds", ondelete="SET NULL", name="fk_research_batches_ws_round"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    total: Mapped[int] = mapped_column(Integer, nullable=False)
    estimate_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    confirmed_micros: Mapped[int | None] = mapped_column(BigInteger)


class ResearchRun(ActorColumns, TimestampMixin, Base):
    __tablename__ = "research_runs"
    __table_args__ = (
        check_in("kind", ResearchKind),
        check_in("status", RunStatus),
        UniqueConstraint("workspace_id", "id", name="uq_research_runs_workspace_id_id"),
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_research_runs_ws_inv"),
        _ws_fk("round_id", "rounds", ondelete="SET NULL", name="fk_research_runs_ws_round"),
        _ws_fk("batch_id", "research_batches", ondelete="CASCADE", name="fk_research_runs_ws_b"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    investor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    batch_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'queued'"))
    preset: Mapped[str | None] = mapped_column(Text)
    identity_model: Mapped[str | None] = mapped_column(Text)
    search_model: Mapped[str | None] = mapped_column(Text)
    writer_model: Mapped[str | None] = mapped_column(Text)
    estimate_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    reserved_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    # The ledger month the open reservation sits in (released from that month, not today's).
    reserved_month: Mapped[date | None] = mapped_column(Date)
    cost_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    usage: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'"), default=list
    )
    progress: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'"), default=dict
    )
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    dossier_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ResearchSource(CreatedAtMixin, Base):
    __tablename__ = "research_sources"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id", name="uq_research_sources_workspace_id_id"),
        _ws_fk("run_id", "research_runs", ondelete="CASCADE", name="fk_research_sources_ws_run"),
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_research_sources_ws_i"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    url_key: Mapped[str] = mapped_column(Text, nullable=False)
    domain: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    snippet: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[date | None] = mapped_column(Date)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    matched_anchor: Mapped[str | None] = mapped_column(Text)
    accepted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    rejected_reason: Mapped[str | None] = mapped_column(Text)


class InvestorIdentity(TimestampMixin, Base):
    __tablename__ = "investor_identities"
    __table_args__ = (
        check_in("status", IdentityStatus),
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_inv_identities_ws_inv"),
        _ws_fk("run_id", "research_runs", ondelete="SET NULL", name="fk_inv_identities_ws_run"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'none'"))
    linkedin_url: Mapped[str | None] = mapped_column(Text)
    linkedin_key: Mapped[str | None] = mapped_column(Text)
    firm: Mapped[str | None] = mapped_column(Text)
    firm_website: Mapped[str | None] = mapped_column(Text)
    firm_domain: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    source: Mapped[str | None] = mapped_column(Text)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_type: Mapped[str | None] = mapped_column(Text)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    actor_label: Mapped[str | None] = mapped_column(Text)
    agent_model: Mapped[str | None] = mapped_column(Text)
    via: Mapped[str | None] = mapped_column(Text)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class InvestorIdentityCandidate(CreatedAtMixin, Base):
    __tablename__ = "investor_identity_candidates"
    __table_args__ = (
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_identity_cands_ws_inv"),
        _ws_fk("run_id", "research_runs", ondelete="CASCADE", name="fk_identity_cands_ws_run"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    rank: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    firm: Mapped[str | None] = mapped_column(Text)
    linkedin_url: Mapped[str | None] = mapped_column(Text)
    firm_website: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    evidence_source_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, server_default=text("'{}'"), default=list
    )
    picked: Mapped[bool | None] = mapped_column(Boolean)


class Dossier(ActorColumns, CreatedAtMixin, Base):
    """Private analysis: verdict, Brief, Fit assessment, Ways in, Talking points."""

    __tablename__ = "dossiers"
    __table_args__ = (
        check_in("verdict", Verdict),
        UniqueConstraint("workspace_id", "id", name="uq_dossiers_workspace_id_id"),
        UniqueConstraint("investor_id", "version", name="uq_dossiers_investor_version"),
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_dossiers_ws_inv"),
        _ws_fk("round_id", "rounds", ondelete="SET NULL", name="fk_dossiers_ws_round"),
        _ws_fk("run_id", "research_runs", ondelete="SET NULL", name="fk_dossiers_ws_run"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="1")
    author_kind: Mapped[str] = mapped_column(Text, nullable=False)
    author_label: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    analysis: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'"), default=dict
    )
    unverified: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'"), default=list
    )
    previous_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    new_fact_keys: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'"), default=list
    )


class DossierFacts(CreatedAtMixin, Base):
    """Public layer of a dossier: the identity anchor used and the cited public claims."""

    __tablename__ = "dossier_facts"
    __table_args__ = (
        _ws_fk("dossier_id", "dossiers", ondelete="CASCADE", name="fk_dossier_facts_ws_d"),
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_dossier_facts_ws_inv"),
    )

    dossier_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    identity: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'"), default=dict
    )
    facts: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'"), default=list
    )
    as_of: Mapped[date] = mapped_column(Date, nullable=False)


class FieldSuggestion(CreatedAtMixin, Base):
    __tablename__ = "field_suggestions"
    __table_args__ = (
        check_in("status", SuggestionStatus),
        _ws_fk("investor_id", "investors", ondelete="CASCADE", name="fk_suggestions_ws_inv"),
        _ws_fk("round_id", "rounds", ondelete="CASCADE", name="fk_suggestions_ws_round"),
        _ws_fk("dossier_id", "dossiers", ondelete="CASCADE", name="fk_suggestions_ws_dossier"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    dossier_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    field: Mapped[str] = mapped_column(Text, nullable=False)
    current_value: Mapped[Any] = mapped_column(JSONB)
    suggested_value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decider_actor_type: Mapped[str | None] = mapped_column(Text)
    decider_actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    decider_api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    decider_actor_label: Mapped[str | None] = mapped_column(Text)
    decider_agent_model: Mapped[str | None] = mapped_column(Text)
    decider_via: Mapped[str | None] = mapped_column(Text)


class ResearchRemovalRequest(CreatedAtMixin, Base):
    """Global (not workspace-scoped): someone asks Raisebook to delete research about them."""

    __tablename__ = "research_removal_requests"
    __table_args__ = (check_in("status", RemovalStatus),)

    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    linkedin_url: Mapped[str | None] = mapped_column(Text)
    firm: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str | None] = mapped_column(Text)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'unverified'"))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_note: Mapped[str | None] = mapped_column(Text)
    applied_counts: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class ResearchSuppression(CreatedAtMixin, Base):
    __tablename__ = "research_suppressions"

    id: Mapped[uuid.UUID] = pk()
    linkedin_key: Mapped[str | None] = mapped_column(Text)
    email_sha256: Mapped[bytes | None] = mapped_column(LargeBinary)
    name_key: Mapped[str | None] = mapped_column(Text)
    request_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("research_removal_requests.id", ondelete="SET NULL")
    )


class ResearchUpload(CreatedAtMixin, Base):
    """A deck PDF held only until its prefill job finishes (≤ 24 h, housekeeping)."""

    __tablename__ = "research_uploads"
    __table_args__ = (
        _ws_fk("run_id", "research_runs", ondelete="CASCADE", name="fk_research_uploads_ws_run"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
