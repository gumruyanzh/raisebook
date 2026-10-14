"use client";

import { useEffect, useRef, useState } from "react";

import { errorMessage, type ApiClient } from "@/lib/api/client";
import { cancelBatch, type Batch } from "@/lib/api/research";
import { num } from "@/lib/format";
import { batchOutcome, formatUsd } from "@/lib/research";

import { useBatchPoll } from "./hooks";

/**
 * A bulk run's progress line in the round toolbar (RESEARCH-PLAN §8.5): "Researching 12 of
 * 37 · $2.31 · Cancel", polled every 2s while runs are active; it reports how it ended and
 * then steps aside. `onTick` refreshes the rows as runs finish.
 */
export function BatchProgress({
  batch: initial,
  client,
  onTick,
  onDone,
  onNeedsPick,
  onAcceptAll,
}: {
  batch: Batch;
  client: ApiClient;
  onTick: () => void;
  onDone: () => void;
  /** Show the people the batch left waiting for a person (a pick, or a LinkedIn). */
  onNeedsPick?: () => void;
  /** Accept every pending suggestion in the round; resolves to how many were accepted. */
  onAcceptAll?: () => Promise<number>;
}) {
  const last = useRef<string>("");
  const batch = useBatchPoll(client, initial, (b) => {
    const sig = JSON.stringify(b.counts);
    if (sig !== last.current) {
      last.current = sig;
      onTick();
    }
  });
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [accepted, setAccepted] = useState<number | null>(null);
  const [accepting, setAccepting] = useState(false);
  const b = batch ?? initial;
  const finished = b.total - b.active;
  const identity = b.kind === "identity";
  const ended = b.active === 0;
  const o = batchOutcome(b);
  // A batch that left work for a person (picks, a key to fix) stays until dismissed.
  useEffect(() => {
    if (!ended || o.needsYou || o.problem) return;
    const t = setTimeout(onDone, 12_000);
    return () => clearTimeout(t);
  }, [ended, onDone, o.needsYou, o.problem]);
  const outcome = o.line;
  return (
    <span className="t-micro inline-flex min-w-0 items-center gap-8 whitespace-nowrap text-muted" role="status" aria-live="polite">
      {ended ? (
        <>
          <span className="text-fg">{identity ? "Matching finished" : "Research finished"}</span>
          <span className="truncate">{outcome}</span>
          {b.spent_usd ? <span>· {formatUsd(b.spent_usd)}</span> : null}
          {o.problem ? <span className="text-bad">{o.problem}</span> : null}
          {o.needsYou && onNeedsPick ? (
            <button type="button" className="link border-0 bg-transparent p-0" onClick={onNeedsPick}>
              Show them
            </button>
          ) : null}
          {!identity && onAcceptAll && (b.counts.succeeded ?? 0) > 0 ? (
            accepted !== null ? (
              <span>· {num(accepted)} suggestions accepted</span>
            ) : (
              <button
                type="button"
                className="link border-0 bg-transparent p-0"
                disabled={accepting}
                onClick={async () => {
                  setAccepting(true);
                  try {
                    setAccepted(await onAcceptAll());
                  } catch (e) {
                    setErr(errorMessage(e));
                  } finally {
                    setAccepting(false);
                  }
                }}
              >
                {accepting ? "Accepting…" : "Accept all suggestions"}
              </button>
            )
          ) : null}
          <button type="button" className="link border-0 bg-transparent p-0" onClick={onDone}>
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span className="text-fg">
            {identity ? "Matching" : "Researching"} {num(Math.min(b.total, finished + 1))} of {num(b.total)}
          </span>
          {b.spent_usd ? <span>· {formatUsd(b.spent_usd)}</span> : null}
          <button
            type="button"
            className="link border-0 bg-transparent p-0"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await cancelBatch(client, b.id);
                onTick();
              } catch (e) {
                setErr(errorMessage(e));
              } finally {
                setCancelling(false);
              }
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </>
      )}
      {err ? <span className="text-bad">{err}</span> : null}
    </span>
  );
}
