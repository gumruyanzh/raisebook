"""Presets pinned to the recorded OpenRouter models list, and the cost estimator (§5)."""

from __future__ import annotations

from decimal import Decimal

from raisebook.models.enums import AiPreset, ResearchKind
from raisebook.services import ai_settings
from raisebook.services.openrouter import ModelInfo
from raisebook.services.research_cost import (
    PRICE_SNAPSHOT,
    RunModels,
    estimate_micros,
    micros_to_usd,
    usd_to_micros,
)
from tests.research.fixtures_models import PRESET_IDS
from tests.research.openrouter_mock import models_fixture


def fixture_models() -> dict[str, ModelInfo]:
    out = {}
    for raw in models_fixture()["data"]:
        info = ModelInfo.from_api(raw)
        assert info is not None
        out[info.id] = info
    return out


def test_presets_match_the_recorded_models_list() -> None:
    models = fixture_models()
    for preset in ai_settings.PRESETS.values():
        assert (preset.identity, preset.search, preset.writer) == PRESET_IDS[preset.id.value]
        for model_id in (preset.identity, preset.search, preset.writer):
            assert model_id in models, model_id
        writer = models[preset.writer]
        assert writer.supports_structured and writer.supports_file  # dossier JSON + deck input
        assert models[preset.search].has_native_search
    assert ai_settings.IDENTITY_MODEL == "perplexity/sonar"
    assert ai_settings.DEFAULT_PRESET == AiPreset.BEST


def test_price_snapshot_matches_the_fixture() -> None:
    models = fixture_models()
    for model_id, snap in PRICE_SNAPSHOT.items():
        live = models[model_id]
        assert (snap.prompt, snap.completion) == (live.prompt, live.completion), model_id
        if snap.web_search:
            assert snap.web_search == live.web_search


def test_estimates_per_preset() -> None:
    prices = fixture_models()
    usd = {
        p.id.value: micros_to_usd(estimate_micros(ResearchKind.DOSSIER, p.models, prices))
        for p in ai_settings.PRESETS.values()
    }
    assert usd == {"best": 0.211, "balanced": 0.0916, "budget": 0.052225}
    identity = estimate_micros(ResearchKind.IDENTITY, ai_settings.PRESETS[AiPreset.BEST].models)
    assert identity == 7_000  # "Match all 411 ≈ $2.88"
    assert micros_to_usd(identity * 411) == 2.877
    assert estimate_micros(ResearchKind.AGENT, ai_settings.PRESETS[AiPreset.BEST].models) == 0
    prefill = estimate_micros(ResearchKind.PREFILL, ai_settings.PRESETS[AiPreset.BEST].models)
    assert prefill == 110_000


def test_unknown_model_has_no_estimate() -> None:
    models = RunModels("perplexity/sonar", "example/unknown", "anthropic/claude-opus-5.5")
    assert estimate_micros(ResearchKind.DOSSIER, models, {}) is None
    assert estimate_micros(ResearchKind.IDENTITY, models, {}) == 7_000


def test_model_info_parsing_is_lenient() -> None:
    info = ModelInfo.from_api(
        {"id": "example/m", "pricing": {"prompt": "-1", "completion": "abc"}, "context_length": "x"}
    )
    assert info is not None and info.prompt == Decimal(0) and info.completion == Decimal(0)
    assert info.context_length is None and not info.supports_structured
    assert ModelInfo.from_api({"name": "no id"}) is None


def test_usd_micros() -> None:
    assert usd_to_micros(Decimal("25")) == 25_000_000
    assert usd_to_micros(0.000001) == 1
    assert micros_to_usd(None) is None
    assert ai_settings.cap_micros(Decimal("12.50")) == 12_500_000
