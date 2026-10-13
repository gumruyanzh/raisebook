"""Compact JSON for MCP tool results (SPEC §6.1).

Tool results are read by an LLM, so they carry what an agent needs and nothing the
UI alone uses. Results are never silently truncated:

- null fields and empty lists/objects are omitted everywhere;
- stages are ``{key, label}`` (``kind`` only where money/funnel logic needs it); stage
  colors and positions, ``created_at``/``updated_at``/``stage_changed_at`` are dropped;
- an investor that is already the subject of the response is not repeated inside its
  participant, and ``type`` is omitted when it is ``other`` (unknown);
- activities are ``{id, kind, at, body?, data?, round?, investor?, by}`` where ``by``
  reads ``"claude-code · claude-opus-5-5 (agent via mcp)"``;
- money is plain integers, with ``currency`` next to it where it matters;
- in lists, ``notes`` and activity bodies are cut to 1,000 chars; in ``get_investor`` the
  investor's notes are cut to 8,000. A cut text ends with ``… [truncated]`` and the object
  carries ``"notes_truncated": true`` (or ``"body_truncated": true``).

Tools return these dicts; ``mcp.server`` serializes them as compact JSON text.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import BaseModel

LIST_TEXT_LIMIT = 1_000
DETAIL_NOTES_LIMIT = 8_000
TRUNCATION_MARKER = "… [truncated]"

_UI_ONLY = ("color", "position", "created_at", "updated_at", "stage_changed_at")


def truncate(text: str | None, limit: int) -> tuple[str | None, bool]:
    if text is None or len(text) <= limit:
        return text, False
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.8:
        cut = cut[:space]
    return cut.rstrip() + TRUNCATION_MARKER, True


def prune(value: Any) -> Any:
    """Drop None values and empty lists/dicts, recursively."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            pv = prune(v)
            if pv is None or pv == [] or pv == {}:
                continue
            out[k] = pv
        return out
    if isinstance(value, list):
        return [prune(v) for v in value]
    return value


def dump(model: BaseModel | Mapping[str, Any]) -> dict[str, Any]:
    """A model (or dict) as compact JSON-ready data (nulls and empty collections removed)."""
    if isinstance(model, BaseModel):
        data = model.model_dump(mode="json", by_alias=True, exclude_none=True)
    else:
        data = dict(model)
    out: dict[str, Any] = prune(data)
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


def stage_brief(stage: Mapping[str, Any] | BaseModel, *, kind: bool = False) -> dict[str, Any]:
    data = dump(stage)
    keys = ("key", "label", "kind") if kind else ("key", "label")
    return {k: data[k] for k in keys if k in data}


def _investor_dict(out: dict[str, Any]) -> dict[str, Any]:
    if out.get("type") == "other":
        out.pop("type")
    for k in _UI_ONLY:
        out.pop(k, None)
    return out


def research_brief(res: Mapping[str, Any]) -> dict[str, Any] | None:
    """An investor's research summary, only what an agent can act on (None: nothing yet)."""
    status = res.get("identity_status")
    out: dict[str, Any] = {
        "identity": status if status not in (None, "none") else None,
        "verdict": res.get("verdict"),
        "dossier_at": res.get("dossier_at"),
        "stale": res.get("stale") or None,
        "pending_suggestions": res.get("pending_suggestions") or None,
        "running": (res.get("active_run") or {}).get("kind"),
        "from_research": res.get("from_research") or None,
    }
    pruned: dict[str, Any] = prune(out)
    return pruned or None


def investor(
    model: BaseModel | Mapping[str, Any], *, notes_limit: int = LIST_TEXT_LIMIT
) -> dict[str, Any]:
    out = _investor_dict(dump(model))
    res = out.pop("research", None)
    brief = research_brief(res) if isinstance(res, dict) else None
    if brief:
        out["research"] = brief
    rounds = out.get("rounds")
    if isinstance(rounds, list):
        out["rounds"] = [
            prune(
                {
                    "round": r.get("round_slug"),
                    "stage": (r.get("stage") or {}).get("key"),
                    "fit": r.get("fit") or None,
                    "follow_up_on": r.get("follow_up_on"),
                    "amount_committed": r.get("amount_committed"),
                }
            )
            for r in rounds
        ]
    return cut_field(out, "notes", notes_limit, "notes_truncated")


def actor_by(actor: Mapping[str, Any]) -> str:
    label = str(actor.get("label") or "")
    typ = actor.get("type")
    if typ == "system":
        return "Raisebook"
    if typ == "agent":
        model = actor.get("agent_model")
        name = f"{label} · {model}" if model else label
        return f"{name} (agent via {actor.get('via', 'api')})"
    return label


def activity(
    model: BaseModel | Mapping[str, Any],
    *,
    body_limit: int = LIST_TEXT_LIMIT,
    with_investor: bool = True,
) -> dict[str, Any]:
    raw = dump(model)
    out: dict[str, Any] = {
        "id": raw.get("id"),
        "kind": raw.get("kind"),
        "at": raw.get("occurred_at"),
    }
    if with_investor and raw.get("investor_name"):
        out["investor"] = raw["investor_name"]
    if raw.get("round_slug"):
        out["round"] = raw["round_slug"]
    if raw.get("body"):
        out["body"] = raw["body"]
    if raw.get("data"):
        out["data"] = raw["data"]
    out["by"] = actor_by(raw.get("actor") or {})
    return cut_field(out, "body", body_limit, "body_truncated")


def participant(
    model: BaseModel | Mapping[str, Any], *, with_investor: bool = True
) -> dict[str, Any]:
    out = dump(model)
    out.pop("round_id", None)
    for k in _UI_ONLY:
        out.pop(k, None)
    if isinstance(out.get("stage"), dict):
        out["stage"] = stage_brief(out["stage"])
    inv = out.get("investor")
    if not with_investor:
        out.pop("investor", None)
    elif isinstance(inv, dict):
        out["investor"] = _investor_dict(inv)
    if out.get("fit") == 0:
        out.pop("fit")  # 0 = unrated
    owner = out.get("owner")
    if isinstance(owner, dict):
        out["owner"] = prune({"name": owner.get("name"), "email": owner.get("email")})
    return out
