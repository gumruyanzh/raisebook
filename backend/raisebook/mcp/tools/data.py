# mypy: disable-error-code="type-arg"
# (FastMCP injects the request Context only into parameters annotated with the bare class.)
"""MCP tools: import_investors_csv, export_round (SPEC §6.4). Owner: Import-Export+Ops (IE).

Both call the same services as REST (``services.imports``, ``services.exports``) and share
the per-workspace ``import`` / ``export`` rate limits with it.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from raisebook.auth.scopes import SCOPE_READ, SCOPE_WRITE
from raisebook.config import get_settings
from raisebook.core import ratelimit, refs
from raisebook.core.errors import PayloadTooLarge
from raisebook.mcp import shaping
from raisebook.mcp.tools._common import Clock, ToolError, tool_call
from raisebook.schemas.data import ImportRequest
from raisebook.services import exports, imports
from raisebook.services.csv_io import ALL_FIELDS

MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_INLINE_EXPORT = 1024 * 1024
DRY_RUN_ROWS = 50


def register(server: FastMCP) -> None:
    @server.tool(
        annotations=ToolAnnotations(
            title="Import investors from CSV",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=False,
        )
    )
    async def import_investors_csv(
        csv: Annotated[
            str, Field(description="CSV text (at most 2 MB), first row = column headers.")
        ],
        round: Annotated[
            str | None,
            Field(
                description="Round id, slug or name to add imported investors to; the stage, "
                "fit, follow-up and amount columns only apply with a round.",
                max_length=200,
            ),
        ] = None,
        mapping: Annotated[
            dict[str, str | None] | None,
            Field(
                description='Override the automatic column mapping: {"Column header": field '
                "or null to ignore}. Fields: " + ", ".join(ALL_FIELDS) + "."
            ),
        ] = None,
        default_stage: Annotated[
            str | None,
            Field(description="Stage key or label for rows without a stage column value."),
        ] = None,
        on_duplicate: Annotated[
            Literal["skip", "fill_empty", "update"],
            Field(
                description="For investors that already exist: skip = leave them and their "
                "round fields untouched (default); fill_empty = fill blank fields only; update = "
                "overwrite with non-empty CSV values and apply the round columns."
            ),
        ] = "skip",
        source: Annotated[
            str | None,
            Field(
                description='Fills `source` on rows without one, e.g. "Robotics Demo Night".',
                max_length=200,
            ),
        ] = None,
        dry_run: Annotated[
            bool,
            Field(description="Default true: preview only, nothing is written until false."),
        ] = True,
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
                full = shaping.dump(pv.model_dump(mode="json", exclude={"samples"}))
                rows = full.pop("rows", [])
                # Only rows that need a look; plain creates are summarized in the counts.
                notable = [r for r in rows if r.get("action") != "create" or r.get("warnings")]
                out: dict[str, Any] = {"dry_run": True, **full}
                if notable:
                    out["rows"] = notable
                if len(pv.rows) < pv.row_count:
                    out["rows_previewed"] = len(pv.rows)
                out["next"] = (
                    "Nothing was written. Show the human these counts and any errors, then "
                    "call import_investors_csv again with the same arguments and dry_run=false."
                )
                return out
            result = await imports.commit(db, ws, req, now=Clock.now())
            done = shaping.dump(result.model_dump(mode="json"))
            done["dry_run"] = False
            return done

    @server.tool(
        annotations=ToolAnnotations(
            title="Export a round",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def export_round(
        round: Annotated[
            str | None,
            Field(
                description="Round id, slug or name. Omit when the workspace has exactly one "
                "open round.",
                max_length=200,
            ),
        ] = None,
        format: Annotated[
            Literal["json", "csv"],
            Field(description="json (structured, default) or csv (spreadsheet-ready text)."),
        ] = "json",
        include_activities: Annotated[
            bool, Field(description="json only: add each investor's timeline. Default false.")
        ] = False,
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
