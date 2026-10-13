"""Registers the research job handlers with the worker (listed in ``worker.HANDLER_MODULES``).

- ``research.run`` → :func:`services.research.run_job` (identity, dossier, refresh runs);
  recovery releases the dead run's spend reservation.
- ``company.prefill`` → :func:`services.company_profile.prefill_job`.
- ``research.removal`` → apply a verified removal request (operator action, global).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from raisebook import worker
from raisebook.services import company_profile, research, research_removal
from raisebook.services import jobs as jobs_svc
from raisebook.services.email import build_email_sender


async def removal_job(ctx: Any) -> None:
    request_id = UUID(str(ctx.job.payload["request_id"]))
    async with ctx.session() as db:
        await research_removal.apply_request(
            db, request_id, now=ctx.now(), sender=build_email_sender()
        )
        await db.commit()


worker.register(jobs_svc.KIND_RESEARCH_RUN, research.run_job, on_recover=research.on_recover)
worker.register(
    jobs_svc.KIND_COMPANY_PREFILL,
    company_profile.prefill_job,
    on_recover=company_profile.on_prefill_recover,
)
worker.register(jobs_svc.KIND_RESEARCH_REMOVAL, removal_job)
