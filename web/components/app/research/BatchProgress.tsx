"use client";

import { useEffect, useRef, useState } from "react";

import { errorMessage, type ApiClient } from "@/lib/api/client";
import { cancelBatch, type Batch } from "@/lib/api/research";
import { num } from "@/lib/format";
import { formatUsd } from "@/lib/research";

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
}: {
  batch: Batch;
  client: ApiClient;
  onTick: () => void;
  onDone: () => void;
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
  const b = batch ?? initial;
  const finished = b.total - b.active;
  const identity = b.kind === "identity";
  const ended = b.active === 0;
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(onDone, 12_000);
    return () => clearTimeout(t);
  }, [ended, onDone]);
  const c = b.counts;
  const outcome = [
    c.succeeded ? `${num(c.succeeded)} done` : "",
    c.blocked_identity ? `${num(c.blocked_identity)} need a pick` : "",
    c.partial ? `${num(c.partial)} partial` : "",
    c.capped ? `${num(c.capped)} stopped at the limit` : "",
    c.failed ? `${num(c.failed)} failed` : "",
    c.cancelled ? `${num(c.cancelled)} cancelled` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="t-micro inline-flex min-w-0 items-center gap-8 whitespace-nowrap text-muted" role="status" aria-live="polite">
      {ended ? (
        <>
          <span className="text-fg">{identity ? "Matching finished" : "Research finished"}</span>
          <span className="truncate">{outcome}</span>
          {b.spent_usd ? <span>· {formatUsd(b.spent_usd)}</span> : null}
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
