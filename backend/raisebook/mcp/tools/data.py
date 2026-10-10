# mypy: disable-error-code="type-arg"
# (FastMCP injects the request Context only into parameters annotated with the bare class.)
"""MCP tools: import_investors_csv, export_round (SPEC §6.4). Owner: Import-Export+Ops (IE).

Both call the same services as REST (``services.imports``, ``services.exports``) and share
the per-workspace ``import`` / ``export`` rate limits with it.
"""

from __future__ import annotations

from typing import Any, Literal

from mcp.server.fastmcp import Context, FastMCP

from raisebook.auth.scopes import SCOPE_READ, SCOPE_WRITE
from raisebook.config import get_settings
from raisebook.core import ratelimit, refs
from raisebook.core.errors import PayloadTooLarge
from raisebook.mcp.annotations import read_only, write
from raisebook.mcp.tools._common import Clock, ToolError, tool_call
from raisebook.schemas.data import ImportRequest
from raisebook.services import exports, imports

MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_INLINE_EXPORT = 1024 * 1024
DRY_RUN_ROWS = 50


def register(server: FastMCP) -> None:
    @server.tool(annotations=write("Import investors from CSV", idempotent=False))
    async def import_investors_csv(
        csv: str,
        round: str | None = None,
        mapping: dict[str, str | None] | None = None,
        default_stage: str | None = None,
        on_duplicate: Literal["skip", "fill_empty", "update"] = "skip",
        source: str | None = None,
        dry_run: bool = True,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Import investors from CSV text (first row = headers). Columns are auto-mapped from common headers (Name, Firm/Fund/Company, Email, LinkedIn, Type, Check size, Tags, Stage, Fit, Follow up…); pass `mapping` to override ({"Column header": "field" or null to ignore}). Existing investors are matched like add_investor. dry_run defaults to true and returns a preview with counts and per-row actions; show it to the human, then call again with dry_run=false. With `round`, imported investors are added to that round, and the stage, fit, follow-up and amount columns apply."""  # noqa: E501
        if len(csv.encode("utf-8")) > MAX_CSV_BYTES:
            raise ToolError(
                "payload_too_large: the CSV is larger than 2 MB. Split it into smaller files, "
                "or upload it in the web app (Import), which takes up to 5 MB."
            )
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            await ratelimit.enforce("import", str(ws.workspace_id))
            req = ImportRequest(
                format="csv",
                content=csv,
                round=round,
                mapping=mapping,
                default_stage=default_stage,
                on_duplicate=on_duplicate,
                source=source,
            )
            if dry_run:
                pv = await imports.preview(db, ws, req, max_rows=DRY_RUN_ROWS)
                out = pv.model_dump(mode="json", exclude={"samples"})
                out["dry_run"] = True
                out["next"] = (
                    "Nothing was written. Show the human these counts and any errors, then "
                    "call import_investors_csv again with the same arguments and dry_run=false."
                )
                return out
            result = await imports.commit(db, ws, req, now=Clock.now())
            done = result.model_dump(mode="json")
            done["dry_run"] = False
            return done

    @server.tool(annotations=read_only("Export a round"))
    async def export_round(
        round: str | None = None,
        format: Literal["json", "csv"] = "json",
        include_activities: bool = False,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Export a round's pipeline: every investor in the round with contact fields, stage, fit, follow-up, amounts and last activity date. format=csv gives spreadsheet-ready text; json gives structured data. Set include_activities to add each investor's timeline (json only)."""  # noqa: E501
        async with tool_call(ctx, SCOPE_READ) as (db, ws):
            await ratelimit.enforce("export", str(ws.workspace_id))
            rnd = await refs.resolve_round(db, ws, round, required=True)
            assert rnd is not None
            f = await exports.export_round(
                db,
                ws,
                rnd,
                fmt=format,
                now=Clock.now(),
                include_activities=include_activities and format == "json",
            )
            if f.size > MAX_INLINE_EXPORT:
                base = get_settings().public_base_url.rstrip("/")
                url = f"{base}/v1/rounds/{rnd.slug}/export?format={format}"
                if include_activities and format == "json":
                    url += "&include_activities=true"
                raise PayloadTooLarge(
                    f"The export is {f.size // 1024} KB, over the 1 MB limit for MCP. Download "
                    f"it with GET {url} (same API key), or use format=csv without activities.",
                    details={"url": url, "size_bytes": f.size},
                )
            return {
                "round": {"slug": str(rnd.slug), "name": rnd.name},
                "format": format,
                "filename": f.filename,
                "row_count": f.row_count,
                "content": f.content,
            }
