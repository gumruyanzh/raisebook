"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Dialog } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { batchBody, estimateResearch, startBatch, type AiSettings, type Batch, type Estimate } from "@/lib/api/research";
import { num } from "@/lib/format";
import { capUsd, estimateLine, formatUsd, overCapLine, perRunLine, skippedLine } from "@/lib/research";

export interface ResearchTarget {
  kind: "identity" | "dossier";
  investorIds?: string[] | null;
  round?: string | null;
  /** "the 37 selected", "everyone in Seed". */
  scope: string;
}

/**
 * The upfront estimate and confirm for bulk research (R4; RESEARCH-PLAN §8.5): how many, who
 * is left out and why, the cost per run and in total, and what is left under the monthly
 * limit. Over the limit it offers the part that fits, or raising the limit (owners).
 */
export function EstimateDialog({
  target,
  client,
  wsSlug,
  settings,
  onClose,
  onStarted,
}: {
  target: ResearchTarget | null;
  client: ApiClient;
  wsSlug: string;
  settings: AiSettings | null | undefined;
  onClose: () => void;
  onStarted: (batch: Batch, runs: number) => void;
}) {
  const [est, setEst] = useState<Estimate | null>(null);
  const [err, setErr] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState<"all" | "part" | null>(null);
  const [confirmUsd, setConfirmUsd] = useState<number | null>(null);
  const open = target !== null;

  useEffect(() => {
    if (!target) return;
    let live = true;
    setEst(null);
    setErr(null);
    setConfirmUsd(null);
    estimateResearch(client, target.kind, { investorIds: target.investorIds, round: target.round })
      .then((e) => live && setEst(e))
      .catch((e) => live && setErr({ text: errorMessage(e), code: e instanceof ApiError ? e.code : undefined }));
    return () => {
      live = false;
    };
  }, [target, client]);

  const cap = settings?.monthly_cap_usd ?? 0;
  const over = est ? overCapLine(est, cap) : null;
  const identity = target?.kind === "identity";
  const go = async (partial: boolean) => {
    if (!target || !est) return;
    setBusy(partial ? "part" : "all");
    setErr(null);
    const n = partial ? est.fits : est.count;
    const total = confirmUsd ?? (partial ? (est.per_run_usd ?? 0) * n : (est.total_usd ?? 0));
    try {
      const r = await startBatch(client, batchBody(target.kind, { investorIds: target.investorIds, round: target.round }, total, partial));
      onStarted(r.batch, r.runs);
    } catch (e) {
      if (e instanceof ApiError && e.code === "estimate_changed") {
        const d = (e.details ?? {}) as { total_usd?: number };
        if (typeof d.total_usd === "number") setConfirmUsd(d.total_usd);
        setErr({ text: e.message, code: e.code });
      } else if (e instanceof ApiError && e.code === "spend_cap_reached") {
        const d = (e.details ?? {}) as { fits?: number; count?: number };
        if (typeof d.fits === "number" && typeof d.count === "number") setEst({ ...est, fits: d.fits, count: d.count });
        setErr({ text: e.message, code: e.code });
      } else {
        setErr({ text: errorMessage(e), code: e instanceof ApiError ? e.code : undefined });
      }
    } finally {
      setBusy(null);
    }
  };

  const title = identity ? "Match identities" : "Research investors";
  const verbN = (n: number) => (identity ? `Match ${num(n)}` : `Research ${num(n)}`);
  const skipped = est ? skippedLine(est.skipped) : "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={target ? `For ${target.scope}.` : undefined}
      width={520}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {est && over && est.fits > 0 ? (
            <Button variant="primary" busy={busy === "part" ? "Starting…" : false} disabled={busy !== null} onClick={() => void go(true)}>
              {verbN(est.fits)} {est.per_run_usd !== null ? `≈ ${formatUsd(est.per_run_usd * est.fits)}` : ""}
            </Button>
          ) : est && est.count > 0 && !over ? (
            <Button variant="primary" busy={busy === "all" ? "Starting…" : false} disabled={busy !== null} onClick={() => void go(false)}>
              {confirmUsd !== null ? `${verbN(est.count)} ≈ ${formatUsd(confirmUsd)}` : estimateLine(est)}
            </Button>
          ) : null}
        </>
      }
    >
      {!est && !err ? <p className="text-muted">Working out the cost…</p> : null}
      {est ? (
        <div className="flex flex-col gap-12">
          {est.count === 0 ? (
            <p>Nobody here needs it{skipped ? `: ${skipped}.` : "."}</p>
          ) : (
            <dl className="m-0 grid grid-cols-[132px_minmax(0,1fr)] gap-x-10 gap-y-6 text-13">
              <dt className="text-muted">{identity ? "To match" : "To research"}</dt>
              <dd className="m-0">
                <b className="font-semibold">{num(est.count)}</b> {est.count === 1 ? "investor" : "investors"}
                {perRunLine(est) ? <span className="text-muted"> · {perRunLine(est)}</span> : null}
              </dd>
              <dt className="text-muted">Estimate</dt>
              <dd className="m-0 font-mono">{est.total_usd !== null ? `≈ ${formatUsd(est.total_usd)}` : "unknown"}</dd>
              {skipped ? (
                <>
                  <dt className="text-muted">Left out</dt>
                  <dd className="m-0">{skipped}</dd>
                </>
              ) : null}
              <dt className="text-muted">Left this month</dt>
              <dd className="m-0">
                <span className="font-mono">{formatUsd(est.remaining_usd)}</span>
                <span className="text-muted"> of your {capUsd(cap)} limit</span>
              </dd>
            </dl>
          )}
          {!identity && est.no_profile ? (
            <p className="rounded-sm border border-warm bg-warm-soft px-12 py-8 text-warm-ink" role="status">
              <b className="font-semibold">No company profile yet.</b> These dossiers will have no fit verdict and no talking points, and
              nothing changes anyone&apos;s fit.{" "}
              <Link href={`/w/${encodeURIComponent(wsSlug)}/settings/company`} className="underline underline-offset-2">
                Add your company profile
              </Link>{" "}
              first to get them.
            </p>
          ) : null}
          {!identity && est.needs_identity ? (
            <p className="t-body-s text-muted">
              {num(est.needs_identity)} {est.needs_identity === 1 ? "has" : "have"} no identity yet: each is matched first, and stops to ask
              you when unsure (only the match is charged then).
            </p>
          ) : null}
          {over ? (
            <p className="rounded-sm border border-warm bg-warm-soft px-12 py-8 text-warm-ink" role="status">
              <b className="font-semibold">{over}</b>{" "}
              {est.order === "fit" && est.fits > 0 ? "The best fit go first (Hot, then Warm, then Maybe). " : null}
              {settings?.can_edit ? (
                <>
                  <Link href={`/w/${encodeURIComponent(wsSlug)}/settings/ai`} className="underline underline-offset-2">
                    Raise the limit
                  </Link>{" "}
                  to do all {num(est.count)}.
                </>
              ) : (
                "An owner can raise the limit."
              )}
            </p>
          ) : null}
          <p className="t-body-s text-muted">
            {identity
              ? "Each match is one cheap search. Clear matches are saved; unclear ones wait for you to pick."
              : "Runs go in the background and stop cleanly at the limit. The real cost of each run is recorded."}
          </p>
        </div>
      ) : null}
      {err ? (
        <p className="t-body-s mt-10 text-bad" role="alert">
          {err.text} {err.code ? <span className="font-mono text-micro">{err.code}</span> : null}
        </p>
      ) : null}
    </Dialog>
  );
}
