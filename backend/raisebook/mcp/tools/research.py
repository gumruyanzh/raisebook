# mypy: disable-error-code="type-arg"
"""MCP tools for investor research (RESEARCH-PLAN §7; R11): get_dossier, list_research_runs,
research_investor, match_identity, save_dossier.

They call the same services as REST (``services.research``, ``services.dossiers``,
``services.research_identity``); references resolve through ``core.refs``. ``save_dossier``
lets an agent research with its own tools and submit the result, validated by the same rules
as model dossiers, at no cost to the workspace and without an OpenRouter key.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from pydantic import Field

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.refs import resolve_investor, resolve_round
from raisebook.mcp import shaping
from raisebook.mcp.annotations import read_only, write
from raisebook.mcp.tools._args import InvestorArg, RoundOpt
from raisebook.mcp.tools._common import Clock, parse_uuid, tool_call
from raisebook.models.enums import ResearchKind
from raisebook.schemas.research import DossierArg
from raisebook.services import dossiers as dossiers_svc
from raisebook.services import investors as investors_svc
from raisebook.services import research as research_svc
from raisebook.services import research_identity as identity_svc

Section = Literal[
    "brief", "fit", "activity", "thesis", "ways_in", "talking_points", "red_flags", "all"
]

SAVE_DOSSIER_DESCRIPTION = """Save a dossier you researched with your own tools (web search, fetch). It costs the workspace nothing and needs no OpenRouter key; it is shown "by <your agent name>". Schema v1: `identity` {name, firm?, title?, linkedin_url?, firm_website?} must be the investor's confirmed identity when one exists (same LinkedIn profile, or same firm domain and name); with none yet it must be the same person (same name, same firm when both are known) and becomes the confirmed identity, but while "Is this them?" waits for a pick (needs_pick) nothing is saved: use match_identity first. linkedin_url must be a linkedin.com/in/ profile and firm_website an http(s) URL. `sources` [{id, url, title?, snippet?, published_at?, fetched_at?}] are pages you actually fetched; a source must be about this person (their LinkedIn profile, their firm's site, or a page naming them with their firm). `facts` [{key, section: profile|fit|activity|thesis|red_flags, kind, text ≤400, date?, source_ids}] each cite ≥1 of your source ids; uncited facts are dropped and listed in `dropped`. `analysis` {brief: {verdict: strong|possible|poor, why, best_way_in, opener, risk, fact_keys}, fit, ways_in [{text, basis: public, fact_keys}], talking_points}; ways in need public evidence (never guess who knows whom). `suggestions` {firm?, title?, check_min?, …: {value, fact_keys}} fill the investor's empty fields; others become suggestions the founder accepts. Professional information only: never personal phones, home addresses, family, health, politics or religion (stripped or dropped). Pass `idempotency_key` to make retries safe."""  # noqa: E501


def _run_brief(r: dict[str, Any], investor: str | None = None) -> dict[str, Any]:
    prog = r.get("progress") or {}
    out = {
        "id": str(r["id"]),
        "investor": investor,
        "kind": r["kind"],
        "status": r["status"],
        "cost_usd": r.get("cost_usd") or None,
        "estimate_usd": r.get("estimate_usd") if r["status"] in ("queued", "running") else None,
        "progress": f"{prog.get('done', 0)}/{prog.get('total', 0)}" if prog.get("total") else None,
        "step": prog.get("step"),
        "error": r.get("error"),
        "dossier_id": str(r["dossier_id"]) if r.get("dossier_id") else None,
        "result": r.get("result"),
        "can_resume": r.get("can_resume") or None,
    }
    pruned: dict[str, Any] = shaping.prune(out)
    return pruned


def register(server: FastMCP) -> None:
    @server.tool(annotations=read_only("Read an investor's dossier"))
    async def get_dossier(
        investor: InvestorArg,
        version: Annotated[int | None, Field(ge=1, description="An older version.")] = None,
        section: Annotated[Section, Field(description="One section, or all (default).")] = "all",
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Read an investor's research dossier: the Brief (verdict, why, best way in, opener, risk) and the sections Fit, Recent activity, Thesis & public views, Ways in, Talking points and Red flags. Every claim ends with source refs like [s3] that point into `sources` (url, title, date). `new_since` marks a refresh; `stale` means older than 90 days. `unverified` claims are from model memory, not cited: never present them as facts."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            inv = await resolve_investor(db, ws, investor)
            view = await dossiers_svc.view(db, ws, inv, now=Clock.now(), version=version)
            d = view["dossier"]
            new_keys = set(d.get("new_fact_keys") or [])
            out: dict[str, Any] = {
                "investor": {"id": str(inv.id), "name": inv.name, "firm": inv.firm},
                "version": d["version"],
                "date": d["created_at"].date().isoformat(),
                "verdict": d["verdict"],
                "author": view["author"].get("by") or view["author"]["label"],
                "stale": view["stale"] or None,
                "sections": dossiers_svc.sections(view, section),
                "sources": [
                    shaping.prune(
                        {
                            "ref": f"s{i}",
                            "url": s["url"],
                            "title": s["title"],
                            "date": s["published_at"].isoformat() if s["published_at"] else None,
                        }
                    )
                    for i, s in enumerate(view["sources"], start=1)
                ],
                "unverified": d.get("unverified") or None,
                "pending_suggestions": len(view["suggestions"]) or None,
            }
            if view["new_since"] is not None and new_keys:
                out["new_since"] = {
                    "date": view["new_since"].date().isoformat(),
                    "facts": [f["text"] for f in view["facts"] if f["key"] in new_keys],
                }
            if view["refresh_offer"]:
                out["refresh_offer"] = (
                    "The investor is in a Meeting stage and the dossier is over 30 days old: "
                    "offer the founder a refresh (research_investor kind=refresh)."
                )
            result: dict[str, Any] = shaping.prune(out)
            return result

    @server.tool(annotations=read_only("List research runs"))
    async def list_research_runs(
        investor: Annotated[
            str | None,
            Field(description="Investor id, email, LinkedIn URL or exact name.", max_length=500),
        ] = None,
        status: Annotated[
            Literal[
                "queued",
                "running",
                "succeeded",
                "partial",
                "failed",
                "cancelled",
                "capped",
                "blocked_identity",
            ]
            | None,
            Field(description="Only runs in this status."),
        ] = None,
        kind: Annotated[
            Literal["identity", "dossier", "refresh", "prefill", "agent"] | None,
            Field(description="Only runs of this kind."),
        ] = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 20,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """List research runs, newest first: kind, status, cost in USD, progress and errors (with what to do next). A failed, partial or capped run keeps what it gathered and can be resumed by the founder in the app."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            inv = await resolve_investor(db, ws, investor) if investor else None
            rows, _ = await research_svc.list_runs(
                db,
                ws,
                investor_id=inv.id if inv else None,
                status=status,
                kind=kind,
                limit=limit,
            )
            names: dict[Any, str] = {}
            if rows:
                found = await investors_svc.get_many(
                    db, ws, [r.investor_id for r in rows if r.investor_id]
                )
                names = {k: v.name for k, v in found.items()}
            return {
                "runs": [
                    _run_brief(research_svc.run_dict(r), names.get(r.investor_id)) for r in rows
                ]
            }

    @server.tool(annotations=write("Research an investor"))
    async def research_investor(
        investor: InvestorArg,
        kind: Annotated[
            Literal["identity", "dossier", "refresh"],
            Field(
                description="identity = find who this is (cheap); dossier (default) = full "
                "research; refresh = research again and mark what is new."
            ),
        ] = "dossier",
        round: RoundOpt = None,
        dry_run: Annotated[
            bool, Field(description="Only estimate the cost; start nothing.")
        ] = False,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Start research on an investor with the workspace's OpenRouter key (it runs in the background; poll list_research_runs, then read get_dossier). Respects the monthly AI limit. Safe to repeat: a run already going is returned. Errors: no_ai_key (an owner adds a key in Settings → AI research; or research yourself and use save_dossier), spend_cap_reached, identity_required (call match_identity first)."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=False)
            if dry_run:
                est = await research_svc.bulk_estimate(
                    db,
                    ws,
                    kind=ResearchKind.IDENTITY if kind == "identity" else ResearchKind.DOSSIER,
                    now=now,
                    investor_ids=[inv.id],
                )
                return {"dry_run": True, **shaping.prune(est.as_dict())}
            started = await research_svc.start_run(
                db, ws, inv, kind=ResearchKind(kind), now=now, round_id=rnd.id if rnd else None
            )
            out = _run_brief(research_svc.run_dict(started.run), inv.name)
            out["created"] = started.created
            out["estimate_usd"] = started.estimate_micros / 1_000_000
            out["next"] = (
                "Research runs in the background (about a minute). Check it with "
                "list_research_runs, then read the result with get_dossier."
            )
            return out

    @server.tool(annotations=write("Match an investor's identity"))
    async def match_identity(
        investor: InvestorArg,
        pick: Annotated[
            str | None,
            Field(description="A candidate id, or its rank 1-3, from a previous call."),
        ] = None,
        linkedin_url: Annotated[
            str | None,
            Field(description="Their LinkedIn profile URL, if you know it.", max_length=500),
        ] = None,
        none: Annotated[
            bool, Field(description="True: none of the candidates is this investor.")
        ] = False,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Find or confirm who an investor is before deeper research (R3). Without a choice: returns the confirmed identity, the candidates to pick from ("Is this them?"), or starts the cheap identity search. With `pick` (candidate id or rank), `linkedin_url`, or `none`: confirms. Only pick a candidate the human or your own evidence supports."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            if pick is not None or linkedin_url is not None or none:
                rank = int(pick) if pick is not None and pick.strip().isdigit() else None
                cid = parse_uuid(pick, "pick") if pick is not None and rank is None else None
                await identity_svc.pick(
                    db,
                    ws,
                    inv,
                    now=now,
                    candidate_id=cid,
                    rank=rank,
                    none=none,
                    linkedin_url=linkedin_url,
                )
            row = await identity_svc.get_identity(db, ws, inv.id)
            ident = identity_svc.identity_dict(row)
            out: dict[str, Any] = {"investor": {"id": str(inv.id), "name": inv.name}}
            out["identity"] = shaping.prune(
                {k: v for k, v in ident.items() if k not in ("updated_at", "confirmed_at")}
            )
            status = ident["status"]
            if status in identity_svc.ANCHORED:
                out["next"] = "Identity confirmed. research_investor or save_dossier next."
                return out
            if status == "needs_pick":
                cands = await identity_svc.candidates_of(db, ws, inv.id)
                out["candidates"] = [
                    shaping.prune(
                        {
                            "id": str(c.id),
                            "rank": c.rank,
                            "name": c.name,
                            "title": c.title,
                            "firm": c.firm,
                            "linkedin_url": c.linkedin_url,
                            "firm_website": c.firm_website,
                            "confidence": float(c.confidence),
                        }
                    )
                    for c in cands
                ]
                out["next"] = "Ask the human which one it is, then call again with pick=<rank>."
                return out
            if status in ("not_found", "rejected"):
                out["next"] = "No match. Call again with linkedin_url when you know it."
                return out
            started = await research_svc.start_run(db, ws, inv, kind=ResearchKind.IDENTITY, now=now)
            out["run"] = _run_brief(research_svc.run_dict(started.run), inv.name)
            out["next"] = "Matching runs in the background; call match_identity again shortly."
            return out

    @server.tool(
        annotations=write("Save a dossier you researched", idempotent=False),
        description=SAVE_DOSSIER_DESCRIPTION,
    )
    async def save_dossier(
        investor: InvestorArg,
        dossier: Annotated[DossierArg, Field(description="DossierDoc v1 (see the tool text).")],
        round: RoundOpt = None,
        idempotency_key: Annotated[
            str | None, Field(description="Repeat-safe key for retries.", max_length=200)
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=False)
            saved = await research_svc.save_agent_dossier(
                db,
                ws,
                inv,
                dossier,
                now=now,
                round_id=rnd.id if rnd else None,
                idempotency_key=idempotency_key,
            )
            out: dict[str, Any] = shaping.prune(dict(saved.result))
            if saved.repeated:
                out["repeated"] = True
            return out
