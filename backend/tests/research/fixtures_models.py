"""Preset model ids as the owner approved them (RESEARCH-PLAN §5.1), for assertions."""

from __future__ import annotations

PRESET_IDS: dict[str, tuple[str, str, str]] = {
    "best": ("perplexity/sonar", "perplexity/sonar-pro", "anthropic/claude-opus-5.5"),
    "balanced": ("perplexity/sonar", "perplexity/sonar", "anthropic/claude-sonnet-5.5"),
    "budget": ("perplexity/sonar", "perplexity/sonar", "google/gemini-3.8-flash"),
}
