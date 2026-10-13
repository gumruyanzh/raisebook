"""AI research settings per workspace (RESEARCH-PLAN §6.1, R4, R9, R12).

- **Presets** (R9): Best (default), Balanced, Budget; "custom" when any model id was set by
  hand (Advanced). The identity step always uses the cheap search model.
- **Key** (R12): one OpenRouter key per workspace, set or removed only by an owner signed in
  to the web. It is validated against OpenRouter (``GET /key``) and the current models are
  verified on ``GET /models`` before it is stored, sealed with the server KEK. Only the last
  4 characters are ever returned. "Remove key" NULLs every key column at once and cancels the
  workspace's queued research.
- **Monthly cap** (R4): default $25, at most $10,000, editable with ``raisebook:admin``.

The row is created lazily: a workspace without one reads the defaults.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core import secrets
from raisebook.core.errors import (
    InvalidOpenRouterKey,
    ModelUnavailable,
    NoAiKey,
    OpenRouterUnavailable,
    ResearchUnavailable,
    ValidationFailed,
)
from raisebook.models.ai import WorkspaceAiSettings
from raisebook.models.enums import AiPreset
from raisebook.services import jobs as jobs_svc
from raisebook.services import openrouter
from raisebook.services.research_cost import RunModels


@dataclass(frozen=True)
class Preset:
    id: AiPreset
    label: str
    identity: str
    search: str
    writer: str

    @property
    def models(self) -> RunModels:
        return RunModels(self.identity, self.search, self.writer)


IDENTITY_MODEL = "perplexity/sonar"

# Verified against https://openrouter.ai/api/v1/models on 2026-10-13 (and again on every key
# save and preset change). A test pins these to tests/research/fixtures/openrouter_models.json.
PRESETS: dict[AiPreset, Preset] = {
    AiPreset.BEST: Preset(
        AiPreset.BEST, "Best", IDENTITY_MODEL, "perplexity/sonar-pro", "anthropic/claude-opus-5.5"
    ),
    AiPreset.BALANCED: Preset(
        AiPreset.BALANCED,
        "Balanced",
        IDENTITY_MODEL,
        "perplexity/sonar",
        "anthropic/claude-sonnet-5.5",
    ),
    AiPreset.BUDGET: Preset(
        AiPreset.BUDGET, "Budget", IDENTITY_MODEL, "perplexity/sonar", "google/gemini-3.8-flash"
    ),
}
DEFAULT_PRESET = AiPreset.BEST
DEFAULT_CAP_MICROS = 25_000_000  # $25 (R4)
MAX_CAP_MICROS = 10_000_000_000  # $10,000

MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]{0,150}$")
_KEY_RE = re.compile(r"^[\x21-\x7e]{20,300}$")  # printable ASCII, no spaces

NO_KEY_REASON = "no_key"
KEY_REMOVED_MESSAGE = "The OpenRouter key was removed, so this research was cancelled."


def preset_for(identity: str, search: str, writer: str) -> AiPreset:
    for p in PRESETS.values():
        if (p.identity, p.search, p.writer) == (identity, search, writer):
            return p.id
    return AiPreset.CUSTOM


def default_row(workspace_id: UUID) -> WorkspaceAiSettings:
    """The settings a workspace has before anyone saves any (not added to the session)."""
    p = PRESETS[DEFAULT_PRESET]
    return WorkspaceAiSettings(
        workspace_id=workspace_id,
        preset=p.id.value,
        identity_model=p.identity,
        search_model=p.search,
        writer_model=p.writer,
        monthly_cap_micros=DEFAULT_CAP_MICROS,
    )


async def get_row(db: AsyncSession, workspace_id: UUID) -> WorkspaceAiSettings | None:
    row: WorkspaceAiSettings | None = await db.scalar(
        select(WorkspaceAiSettings).where(WorkspaceAiSettings.workspace_id == workspace_id)
    )
    return row


async def get_or_default(db: AsyncSession, ws: WorkspaceContext) -> WorkspaceAiSettings:
    return await get_row(db, ws.workspace_id) or default_row(ws.workspace_id)


async def _locked_row(db: AsyncSession, workspace_id: UUID, now: datetime) -> WorkspaceAiSettings:
    """The settings row, created with defaults if missing, locked for this transaction."""
    p = PRESETS[DEFAULT_PRESET]
    await db.execute(
        text(
            "INSERT INTO workspace_ai_settings (workspace_id, preset, identity_model, search_model,"
            " writer_model, monthly_cap_micros, created_at, updated_at)"
            " VALUES (:ws, :preset, :i, :s, :w, :cap, :now, :now) ON CONFLICT DO NOTHING"
        ),
        {
            "ws": workspace_id,
            "preset": p.id.value,
            "i": p.identity,
            "s": p.search,
            "w": p.writer,
            "cap": DEFAULT_CAP_MICROS,
            "now": now,
        },
    )
    row = await db.scalar(
        select(WorkspaceAiSettings)
        .where(WorkspaceAiSettings.workspace_id == workspace_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


def require_keyring() -> secrets.Keyring:
    """The server's keyring, or 503 ``research_unavailable`` (no or unusable KEK)."""
    try:
        ring = secrets.get_keyring()
    except secrets.SecretsConfigError:
        ring = None
    if ring is None:
        raise ResearchUnavailable()
    return ring


def kek_configured() -> bool:
    try:
        return secrets.get_keyring() is not None
    except secrets.SecretsConfigError:
        return False


def key_status(row: WorkspaceAiSettings) -> str:
    """``none``, ``ok``, or ``unreadable`` (sealed under a KEK this server no longer has)."""
    if not row.has_key or row.key_kek_id is None:
        return "none"
    try:
        ring = secrets.get_keyring()
    except secrets.SecretsConfigError:
        ring = None
    if ring is None or ring.get(row.key_kek_id) is None:
        return "unreadable"
    return "ok"


def _clean_key(raw: str) -> str:
    key = (raw or "").strip()
    if not _KEY_RE.match(key):
        raise ValidationFailed(
            "key",
            "That does not look like an OpenRouter key. Copy it again from openrouter.ai/keys "
            "(it starts with sk-or-).",
        )
    return key


def _map_openrouter(exc: openrouter.OpenRouterError) -> Exception:
    if exc.code == "openrouter_key_rejected":
        return InvalidOpenRouterKey()
    if exc.code == "openrouter_out_of_credits":
        # The key is valid; the account just has no credits yet. Store it (the caller decides).
        return InvalidOpenRouterKey(
            "OpenRouter accepted this key but its account has no credits. Add credits at "
            "openrouter.ai, then save the key again."
        )
    return OpenRouterUnavailable()


async def verify_models(ids: Mapping[str, str]) -> None:
    """Every id must exist on OpenRouter's models list; the writer must return structured JSON.

    ``ids`` maps the step (``identity``/``search``/``writer``) to the model id.
    """
    try:
        known = await openrouter.models()
    except openrouter.OpenRouterError as exc:
        raise _map_openrouter(exc) from exc
    for step, model_id in ids.items():
        info = known.get(model_id)
        if info is None:
            raise ModelUnavailable(
                f"OpenRouter has no model {model_id!r} (the {step} model). Pick Advanced and "
                "choose another id.",
                details={"step": step, "model": model_id},
            )
        if step == "writer" and not info.supports_structured:
            raise ModelUnavailable(
                f"{model_id} cannot return structured JSON; pick another writer.",
                details={"step": step, "model": model_id},
            )


def _models_of(row: WorkspaceAiSettings) -> dict[str, str]:
    return {
        "identity": row.identity_model,
        "search": row.search_model,
        "writer": row.writer_model,
    }


async def save_key(
    db: AsyncSession, ws: WorkspaceContext, raw_key: str, *, now: datetime
) -> WorkspaceAiSettings:
    """Validate, seal and store the workspace's OpenRouter key (owner session; the API checks).

    Nothing is stored unless OpenRouter accepts the key and the current models exist.
    """
    ring = require_keyring()
    key = _clean_key(raw_key)
    try:
        info = await openrouter.OpenRouterClient(key).check_key()
    except openrouter.OpenRouterError as exc:
        raise _map_openrouter(exc) from exc
    row = await _locked_row(db, ws.workspace_id, now)
    await verify_models(_models_of(row))
    sealed = secrets.seal(key, aad=secrets.openrouter_aad(ws.workspace_id), ring=ring)
    row.key_ciphertext = sealed.ciphertext
    row.key_nonce = sealed.nonce
    row.key_dek_wrapped = sealed.dek_wrapped
    row.key_dek_nonce = sealed.dek_nonce
    row.key_kek_id = sealed.kek_id
    row.key_last4 = secrets.last4(key)
    row.key_label = info.label
    row.key_set_at = now
    row.key_set_by_user_id = ws.actor.user_id
    row.key_validated_at = now
    row.models_verified_at = now
    row.updated_at = now
    await db.flush()
    return row


async def remove_key(db: AsyncSession, ws: WorkspaceContext, *, now: datetime) -> int:
    """Delete the key immediately (R12) and cancel queued research. Returns runs cancelled."""
    row = await _locked_row(db, ws.workspace_id, now)
    row.key_ciphertext = None
    row.key_nonce = None
    row.key_dek_wrapped = None
    row.key_dek_nonce = None
    row.key_kek_id = None
    row.key_last4 = None
    row.key_label = None
    row.key_set_at = None
    row.key_set_by_user_id = None
    row.key_validated_at = None
    row.updated_at = now
    await db.flush()
    result = await db.execute(
        text(
            "UPDATE research_runs SET status = 'cancelled', error_code = :code,"
            " error_message = :msg, finished_at = :now, updated_at = :now"
            " WHERE workspace_id = :ws AND status = 'queued' AND kind <> 'agent'"
        ),
        {"code": NO_KEY_REASON, "msg": KEY_REMOVED_MESSAGE, "now": now, "ws": ws.workspace_id},
    )
    await jobs_svc.cancel_queued(
        db,
        workspace_id=ws.workspace_id,
        now=now,
        kinds=[jobs_svc.KIND_RESEARCH_RUN, jobs_svc.KIND_COMPANY_PREFILL],
        reason=NO_KEY_REASON,
    )
    return int(getattr(result, "rowcount", 0) or 0)


def _model_id(field: str, value: Any) -> str:
    model_id = str(value or "").strip()
    if not MODEL_ID_RE.match(model_id) or len(model_id) > 200:
        raise ValidationFailed(
            field, "Use an OpenRouter model id like 'anthropic/claude-sonnet-5.5'."
        )
    return model_id


def cap_micros(usd: Decimal | float | int) -> int:
    value = Decimal(str(usd))
    if value < 0 or value > Decimal(MAX_CAP_MICROS) / 1_000_000:
        raise ValidationFailed("monthly_cap_usd", "The monthly limit must be $0 to $10,000.")
    if value != value.quantize(Decimal("0.01")):
        raise ValidationFailed("monthly_cap_usd", "Use whole cents for the monthly limit.")
    return int(value * 1_000_000)


async def update_settings(
    db: AsyncSession, ws: WorkspaceContext, changes: Mapping[str, Any], *, now: datetime
) -> WorkspaceAiSettings:
    """PATCH preset / Advanced model ids / monthly cap (``raisebook:admin``; the API checks)."""
    row = await _locked_row(db, ws.workspace_id, now)
    models = _models_of(row)
    preset = changes.get("preset")
    if preset is not None:
        preset = AiPreset(preset)
        if preset != AiPreset.CUSTOM:
            p = PRESETS[preset]
            models = {"identity": p.identity, "search": p.search, "writer": p.writer}
    for step in ("identity", "search", "writer"):
        field = f"{step}_model"
        if changes.get(field) is not None:
            models[step] = _model_id(field, changes[field])
    models_changed = models != _models_of(row)
    if models_changed and row.has_key:
        await verify_models(models)
        row.models_verified_at = now
    row.identity_model = models["identity"]
    row.search_model = models["search"]
    row.writer_model = models["writer"]
    detected = preset_for(models["identity"], models["search"], models["writer"])
    row.preset = AiPreset.CUSTOM.value if preset == AiPreset.CUSTOM else detected.value
    if changes.get("monthly_cap_usd") is not None:
        row.monthly_cap_micros = cap_micros(changes["monthly_cap_usd"])
    row.updated_at = now
    await db.flush()
    return row


def sealed_of(row: WorkspaceAiSettings) -> secrets.Sealed | None:
    if (
        row.key_ciphertext is None
        or row.key_nonce is None
        or row.key_dek_wrapped is None
        or row.key_dek_nonce is None
        or row.key_kek_id is None
    ):
        return None
    return secrets.Sealed(
        row.key_ciphertext, row.key_nonce, row.key_dek_wrapped, row.key_dek_nonce, row.key_kek_id
    )


async def open_key(db: AsyncSession, workspace_id: UUID) -> str:
    """The plaintext key, for an OpenRouter call only (never return, log or store it).

    Raises 503 ``research_unavailable`` without a KEK and 422 ``no_ai_key`` when the
    workspace has no key or it can no longer be opened (an owner re-enters it).
    """
    ring = require_keyring()
    row = await get_row(db, workspace_id)
    sealed = sealed_of(row) if row is not None else None
    if sealed is None:
        raise NoAiKey()
    try:
        return secrets.open_sealed(sealed, aad=secrets.openrouter_aad(workspace_id), ring=ring)
    except secrets.SecretUnavailable as exc:
        raise NoAiKey(
            "The saved OpenRouter key can no longer be read on this server. An owner can enter "
            "it again in Settings → AI research."
        ) from exc


async def rotate_all(db: AsyncSession) -> dict[str, int]:
    """``rbctl secrets rotate``: re-wrap every DEK under the current KEK. Counts only."""
    ring = require_keyring()
    counts = {"rewrapped": 0, "current": 0, "unreadable": 0}
    rows = list(
        await db.scalars(
            select(WorkspaceAiSettings)
            .where(WorkspaceAiSettings.key_ciphertext.is_not(None))
            .with_for_update()
        )
    )
    for row in rows:
        sealed = sealed_of(row)
        if sealed is None:
            continue
        if sealed.kek_id == ring.current.id:
            counts["current"] += 1
            continue
        try:
            fresh = secrets.rewrap(sealed, aad=secrets.openrouter_aad(row.workspace_id), ring=ring)
        except secrets.SecretUnavailable:
            counts["unreadable"] += 1
            continue
        row.key_dek_wrapped = fresh.dek_wrapped
        row.key_dek_nonce = fresh.dek_nonce
        row.key_kek_id = fresh.kek_id
        counts["rewrapped"] += 1
    await db.flush()
    return counts
