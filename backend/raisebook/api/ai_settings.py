"""AI research settings (RESEARCH-PLAN §6.1; R4, R9, R12).

- ``GET /v1/workspace/ai-settings`` (read): preset, models, cap, this month's usage,
  estimates per preset, and the key's status: ``key_last4`` only, never the key.
- ``PUT /v1/workspace/ai-settings/key`` (owner signed in to the web): validate the
  OpenRouter key with OpenRouter, verify the models, seal and store it.
- ``DELETE /v1/workspace/ai-settings/key`` (owner signed in): delete it now; queued research
  is cancelled.
- ``PATCH /v1/workspace/ai-settings`` (``raisebook:admin``): preset, Advanced model ids, cap.
- ``GET /v1/research/models`` (read): OpenRouter's public model list for the Advanced picker.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    workspace_ctx,
)
from raisebook.auth.scopes import SCOPE_ADMIN, SCOPE_WRITE
from raisebook.core import ratelimit
from raisebook.core.errors import OpenRouterUnavailable
from raisebook.models.ai import WorkspaceAiSettings
from raisebook.models.enums import AiPreset, ResearchKind
from raisebook.schemas.ai_settings import (
    AiKeyIn,
    AiSettingsOut,
    AiSettingsUpdate,
    EstimatesOut,
    ModelOut,
    PresetOut,
    UsageOut,
)
from raisebook.schemas.common import ERROR_RESPONSES, DataList
from raisebook.services import ai_settings as ai_svc
from raisebook.services import openrouter, spend
from raisebook.services.research_cost import RunModels, estimate_micros, micros_to_usd

router = APIRouter(prefix="/v1", tags=["ai research"], responses=ERROR_RESPONSES)


def _usd(micros: int) -> float:
    return round(micros / 1_000_000, 6)


async def _run_counts(db: AsyncSession, ws: WorkspaceContext, month: date) -> dict[str, int]:
    """Finished paid runs this month, in founder words (dossiers, matches) instead of calls."""
    nxt = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
    rows = (
        await db.execute(
            text(
                "SELECT kind, count(*) FROM research_runs WHERE workspace_id = :ws"
                " AND cost_micros > 0 AND kind IN ('dossier', 'refresh', 'identity')"
                " AND (created_at AT TIME ZONE :tz)::date >= :a"
                " AND (created_at AT TIME ZONE :tz)::date < :b GROUP BY kind"
            ),
            {"ws": ws.workspace_id, "tz": ws.timezone, "a": month, "b": nxt},
        )
    ).all()
    by = {str(k): int(n) for k, n in rows}
    return {
        "dossiers": by.get("dossier", 0) + by.get("refresh", 0),
        "matches": by.get("identity", 0),
    }


async def settings_out(
    db: AsyncSession, ws: WorkspaceContext, row: WorkspaceAiSettings, now: datetime
) -> AiSettingsOut:
    month = spend.month_of(now, ws.timezone)
    used = await spend.usage(db, ws.workspace_id, month)
    prices = ai_svc.known_prices(row)  # never a network call on GET
    current = RunModels(row.identity_model, row.search_model, row.writer_model)
    presets = [
        PresetOut(
            id=p.id.value,
            label=p.label,
            identity_model=p.identity,
            search_model=p.search,
            writer_model=p.writer,
            dossier_usd=micros_to_usd(estimate_micros(ResearchKind.DOSSIER, p.models, prices)),
        )
        for p in ai_svc.PRESETS.values()
    ]
    by_id = {p.id: p.dossier_usd for p in presets}
    kek = ai_svc.kek_configured()
    status = ai_svc.key_status(row)
    principal = ws.principal
    return AiSettingsOut(
        has_key=row.has_key,
        key_status=status,
        key_last4=row.key_last4,
        key_label=row.key_label,
        key_set_at=row.key_set_at,
        key_validated_at=row.key_validated_at,
        key_error=row.key_error,
        key_error_at=row.key_error_at,
        preset=AiPreset(row.preset),
        identity_model=row.identity_model,
        search_model=row.search_model,
        writer_model=row.writer_model,
        models_verified_at=row.models_verified_at,
        monthly_cap_usd=_usd(row.monthly_cap_micros),
        usage=UsageOut(
            month=month.strftime("%Y-%m"),
            spent_usd=_usd(used.spent_micros),
            reserved_usd=_usd(used.reserved_micros),
            remaining_usd=_usd(used.remaining(row.monthly_cap_micros)),
            calls=used.calls,
            **(await _run_counts(db, ws, month)),
            cap_reached=used.remaining(row.monthly_cap_micros) <= 0,
        ),
        estimates=EstimatesOut(
            best=by_id.get("best"),
            balanced=by_id.get("balanced"),
            budget=by_id.get("budget"),
            current=micros_to_usd(estimate_micros(ResearchKind.DOSSIER, current, prices)),
            identity=micros_to_usd(estimate_micros(ResearchKind.IDENTITY, current, prices)),
        ),
        presets=presets,
        kek_configured=kek,
        research_available=kek and status == "ok",
        can_manage_key=principal.is_session
        and principal.role is not None
        and principal.role.value == "owner",
        can_edit=principal.has(SCOPE_WRITE, SCOPE_ADMIN),
    )


@router.get("/workspace/ai-settings", response_model=AiSettingsOut)
async def get_ai_settings(
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> AiSettingsOut:
    """Research settings: preset, models, monthly limit and usage. Shows the key's last 4
    characters only."""
    row = await ai_svc.get_or_default(db, ws)
    return await settings_out(db, ws, row, now)


@router.put("/workspace/ai-settings/key", response_model=AiSettingsOut)
async def put_ai_key(
    body: AiKeyIn,
    request: Request,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> AiSettingsOut:
    """Save the workspace's OpenRouter key (owner, signed in). OpenRouter checks it first;
    it is stored encrypted and never shown again (only its last 4 characters)."""
    ws.principal.require_owner_session()
    await ratelimit.enforce("ai_key", str(ws.workspace_id), request=request, now=now)
    row = await ai_svc.save_key(db, ws, body.key.get_secret_value(), now=now)
    await db.commit()
    return await settings_out(db, ws, row, now)


@router.delete("/workspace/ai-settings/key", status_code=204, response_class=Response)
async def delete_ai_key(
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Delete the OpenRouter key now (owner, signed in). Queued research is cancelled."""
    ws.principal.require_owner_session()
    await ai_svc.remove_key(db, ws, now=now)
    await db.commit()
    return Response(status_code=204)


@router.patch("/workspace/ai-settings", response_model=AiSettingsOut)
async def patch_ai_settings(
    body: AiSettingsUpdate,
    ws: WorkspaceContext = Depends(workspace_ctx(SCOPE_WRITE, SCOPE_ADMIN)),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> AiSettingsOut:
    """Change the preset (best, balanced, budget), set model ids by hand (Advanced; the
    preset becomes ``custom``) or the monthly limit in USD (admin)."""
    changes = body.model_dump(include=body.model_fields_set, exclude_none=True)
    row = await ai_svc.update_settings(db, ws, changes, now=now)
    await db.commit()
    return await settings_out(db, ws, row, now)


@router.get("/research/models", response_model=DataList[ModelOut])
async def list_research_models(
    ws: WorkspaceContext = Depends(get_workspace_ctx),
) -> DataList[ModelOut]:
    """OpenRouter's public model list (cached 6 h) for picking models under Advanced."""
    try:
        models = await openrouter.models()
    except openrouter.OpenRouterError as exc:
        raise OpenRouterUnavailable() from exc
    mtok = 1_000_000
    return DataList(
        data=[
            ModelOut(
                id=m.id,
                name=m.name,
                prompt_per_mtok_usd=float(m.prompt * mtok),
                completion_per_mtok_usd=float(m.completion * mtok),
                web_search_usd=float(m.web_search),
                context_length=m.context_length,
                supports_structured=m.supports_structured,
                supports_file=m.supports_file,
                native_search=m.has_native_search,
            )
            for m in sorted(models.values(), key=lambda m: m.id)
        ]
    )
