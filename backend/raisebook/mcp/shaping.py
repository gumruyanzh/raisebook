"""Compact JSON for MCP tool results (SPEC §6.1). Owner: API+MCP (AM).

Tool results are read by an LLM, so they are compact and never silently truncated:

- null fields (and empty lists in compact investor rows) are omitted;
- money is plain integers, with ``currency`` next to it where it matters;
- in lists, ``notes`` and activity bodies are cut to 1,000 chars; in ``get_investor`` the
  investor's notes are cut to 8,000. A cut text ends with ``… [truncated]`` and the object
  carries ``"notes_truncated": true`` (or ``"body_truncated": true``).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import BaseModel

LIST_TEXT_LIMIT = 1_000
DETAIL_NOTES_LIMIT = 8_000
TRUNCATION_MARKER = "… [truncated]"


def truncate(text: str | None, limit: int) -> tuple[str | None, bool]:
    if text is None or len(text) <= limit:
        return text, False
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.8:
        cut = cut[:space]
    return cut.rstrip() + TRUNCATION_MARKER, True


def _prune(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _prune(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_prune(v) for v in value]
    return value


def dump(model: BaseModel | Mapping[str, Any]) -> dict[str, Any]:
    """A model (or dict) as compact JSON-ready data with null fields removed."""
    if isinstance(model, BaseModel):
        data = model.model_dump(mode="json", by_alias=True, exclude_none=True)
    else:
        data = dict(model)
    out: dict[str, Any] = _prune(data)
    return out


def dump_all(models: Iterable[BaseModel]) -> list[dict[str, Any]]:
    return [dump(m) for m in models]


def cut_field(obj: dict[str, Any], field: str, limit: int, flag: str) -> dict[str, Any]:
    text, cut = truncate(obj.get(field), limit)
    if text is not None:
        obj[field] = text
    if cut:
        obj[flag] = True
    return obj


def investor(model: BaseModel, *, notes_limit: int = LIST_TEXT_LIMIT) -> dict[str, Any]:
    out: dict[str, Any] = dump(model)
    for key in ("tags", "industries", "stage_focus", "rounds"):
        if out.get(key) == []:
            out.pop(key)
    return cut_field(out, "notes", notes_limit, "notes_truncated")


def activity(model: BaseModel, *, body_limit: int = LIST_TEXT_LIMIT) -> dict[str, Any]:
    out: dict[str, Any] = dump(model)
    if out.get("data") == {}:
        out.pop("data")
    return cut_field(out, "body", body_limit, "body_truncated")


def participant(model: BaseModel) -> dict[str, Any]:
    out: dict[str, Any] = dump(model)
    inv = out.get("investor")
    if isinstance(inv, dict) and inv.get("tags") == []:
        inv.pop("tags")
    return out


def stage_brief(stage: Mapping[str, Any] | BaseModel) -> dict[str, Any]:
    data = dump(stage)
    return {k: data[k] for k in ("key", "label", "kind") if k in data}
