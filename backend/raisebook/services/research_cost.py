"""Cost estimates for research runs (RESEARCH-PLAN §5.2). Money is USD micros (1 = $0.000001).

``estimate_micros(kind, models, prices)`` multiplies fixed token budgets per step by the
per-token prices from OpenRouter's public models list (plus per-call ``web_search`` and
``request`` prices). When the live list is not cached, :data:`PRICE_SNAPSHOT` (the preset
models' prices recorded from ``GET /api/v1/models`` on 2026-10-13) keeps estimates working
without a network call. An unknown model id gives ``None`` ("no estimate").

Estimates are upper-bound guides shown with "≈"; the real cost of every call comes from
OpenRouter's reported usage and is what the ledger records.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal

from raisebook.models.enums import ResearchKind
from raisebook.services.openrouter import ModelInfo


@dataclass(frozen=True)
class StepBudget:
    calls: int
    prompt_tokens: int
    completion_tokens: int
    searches: bool  # per-call web_search price applies


# Fixed token budgets per step (RESEARCH-PLAN §5.2).
IDENTITY_STEP = StepBudget(1, 1_500, 500, True)
SEARCH_STEP = StepBudget(3, 1_000, 1_200, True)
WRITER_STEP = StepBudget(1, 14_000, 3_500, False)
PREFILL_STEP = StepBudget(1, 20_000, 1_500, False)


@dataclass(frozen=True)
class RunModels:
    identity: str
    search: str
    writer: str


def _m(model_id: str, prompt: str, completion: str, web_search: str = "0") -> ModelInfo:
    return ModelInfo(
        id=model_id,
        name=model_id,
        prompt=Decimal(prompt),
        completion=Decimal(completion),
        web_search=Decimal(web_search),
    )


# Recorded from https://openrouter.ai/api/v1/models on 2026-10-13 (USD per token / per call).
PRICE_SNAPSHOT: dict[str, ModelInfo] = {
    m.id: m
    for m in (
        _m("perplexity/sonar", "0.000001", "0.000001", "0.005"),
        _m("perplexity/sonar-pro", "0.000003", "0.000015", "0.005"),
        _m("anthropic/claude-opus-5.5", "0.000004", "0.00002"),
        _m("anthropic/claude-sonnet-5.5", "0.000002", "0.00001"),
        _m("google/gemini-3.8-flash", "0.00000075", "0.00000375"),
    )
}

_MICROS = Decimal(1_000_000)


def step_micros(model: ModelInfo, step: StepBudget) -> int:
    per_call = (
        model.prompt * step.prompt_tokens
        + model.completion * step.completion_tokens
        + model.request
        + (model.web_search if step.searches else Decimal(0))
    )
    total = per_call * step.calls * _MICROS
    return int(total.to_integral_value(rounding=ROUND_CEILING))


def price_of(model_id: str, prices: Mapping[str, ModelInfo] | None) -> ModelInfo | None:
    if prices is not None and model_id in prices:
        return prices[model_id]
    return PRICE_SNAPSHOT.get(model_id)


def estimate_micros(
    kind: ResearchKind, models: RunModels, prices: Mapping[str, ModelInfo] | None = None
) -> int | None:
    """Upper-bound estimate for one run of ``kind``; None when a model's price is unknown.

    A dossier (or refresh) includes the identity step: it is skipped at run time when the
    investor's identity is already confirmed, so the estimate stays an upper bound.
    """
    identity = price_of(models.identity, prices)
    if kind == ResearchKind.IDENTITY:
        return None if identity is None else step_micros(identity, IDENTITY_STEP)
    if kind == ResearchKind.PREFILL:
        writer = price_of(models.writer, prices)
        return None if writer is None else step_micros(writer, PREFILL_STEP)
    if kind in (ResearchKind.DOSSIER, ResearchKind.REFRESH):
        search = price_of(models.search, prices)
        writer = price_of(models.writer, prices)
        if identity is None or search is None or writer is None:
            return None
        return (
            step_micros(identity, IDENTITY_STEP)
            + step_micros(search, SEARCH_STEP)
            + step_micros(writer, WRITER_STEP)
        )
    return 0  # agent dossiers cost the workspace nothing


def micros_to_usd(micros: int | None) -> float | None:
    return None if micros is None else round(micros / 1_000_000, 6)


def usd_to_micros(usd: Decimal | float | int) -> int:
    value = Decimal(str(usd)) * _MICROS
    return int(value.to_integral_value(rounding=ROUND_CEILING))
