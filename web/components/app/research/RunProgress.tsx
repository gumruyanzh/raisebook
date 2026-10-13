"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { cancelRun, resumeRun, type Run, type StepState } from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { isActive, runNextAction, runProgressLabel } from "@/lib/research";

const GLYPH: Record<StepState, string> = { done: "✓", running: "→", pending: "·", skipped: "–", failed: "✕" };

/**
 * A run's progress (RESEARCH-PLAN §8.7): the steps ("Finding who this is", "Searching recent
 * deals", "Writing", "Checking citations"), the cost so far, and for a stopped run the next
 * action (Resume, Raise limit, Pick identity, Fix key). The caller polls (`useRunPoll`).
 */
export function RunProgress({
  run,
  client,
  wsSlug,
  canWrite,
  onChange,
  onPickIdentity,
  compact = false,
  className,
}: {
  run: Run;
  client: ApiClient;
  wsSlug: string;
  canWrite: boolean;
  onChange: (run: Run) => void;
  onPickIdentity?: () => void;
  /** One line (Triage): no step list. */
  compact?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const active = isActive(run.status);
  const next = active ? null : runNextAction(run);
  const settings = `/w/${encodeURIComponent(wsSlug)}/settings/ai`;
  const failed = !active && run.status !== "succeeded";
  const act = async (fn: () => Promise<Run>) => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await fn());
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const steps = run.progress?.steps ?? [];
  return (
    <div className={cn("flex min-w-0 flex-col gap-6", className)} aria-live="polite">
      <div className="flex min-w-0 flex-wrap items-center gap-x-10 gap-y-4">
        <span className={cn("t-body-s min-w-0", failed ? "text-bad" : "text-fg")}>{runProgressLabel(run)}</span>
        {active && canWrite ? (
          <button type="button" className="link t-body-s border-0 bg-transparent p-0" disabled={busy} onClick={() => void act(() => cancelRun(client, run.id))}>
            Cancel
          </button>
        ) : null}
        {next === "resume" && canWrite ? (
          <Button size="sm" busy={busy ? "Resuming…" : false} onClick={() => void act(() => resumeRun(client, run.id))}>
            Resume
          </Button>
        ) : null}
        {next === "raise_limit" ? (
          <>
            <Link href={settings} className="link t-body-s">
              Raise the limit
            </Link>
            {canWrite && run.can_resume ? (
              <Button size="sm" busy={busy ? "Resuming…" : false} onClick={() => void act(() => resumeRun(client, run.id))}>
                Resume
              </Button>
            ) : null}
          </>
        ) : null}
        {next === "pick_identity" && onPickIdentity ? (
          <button type="button" className="link t-body-s border-0 bg-transparent p-0" onClick={onPickIdentity}>
            Pick who this is
          </button>
        ) : null}
        {next === "fix_key" ? (
          <Link href={settings} className="link t-body-s">
            Check the OpenRouter key
          </Link>
        ) : null}
      </div>
      {!compact && steps.length > 1 ? (
        <ol className="t-micro m-0 flex list-none flex-wrap gap-x-12 gap-y-2 p-0 text-muted">
          {steps.map((s) => (
            <li key={s.key} className={cn("inline-flex items-baseline gap-4", s.state === "running" && "text-fg", s.state === "failed" && "text-bad")}>
              <span aria-hidden>{GLYPH[s.state]}</span>
              {s.label}
              <span className="sr-only">({s.state})</span>
            </li>
          ))}
        </ol>
      ) : null}
      {failed && run.error?.message ? (
        <p className="t-body-s text-muted">
          {run.error.message} <span className="font-mono text-micro">{run.error.code}</span>
        </p>
      ) : null}
      {err ? <p className="t-body-s text-bad">{err}</p> : null}
    </div>
  );
}
