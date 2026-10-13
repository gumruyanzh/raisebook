"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { Button, Kbd } from "@/components/ui";
import type { ApiClient } from "@/lib/api/client";
import { startResearch, type AiSettings, type ResearchSummary, type Run, type Suggestion } from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { useHotkey } from "@/lib/hotkeys";
import { approxUsd, groupSuggestions, isActive, sectionsOf, suggestionLine } from "@/lib/research";

import { Brief } from "./Brief";
import { forgetInvestorResearch, useInvestorResearch, useRunPoll } from "./hooks";
import { IdentityPicker } from "./IdentityPicker";
import { researchErrorText } from "./ResearchError";
import { RunProgress } from "./RunProgress";

/** The research block's fixed height: the decision panel never moves between investors. */
export const TRIAGE_RESEARCH_H = 148;

/**
 * Research in Triage's decision panel (RESEARCH-PLAN §8.4): the investor's Brief (five lines,
 * no sections), or "Is this them?" as one-line rows, or a Research button; pending
 * suggestions as one line with `A` = accept all for this investor (undoable with U). Digits
 * stay the stage keys.
 */
export function TriageResearch({
  investorId,
  name,
  row,
  settings,
  client,
  wsSlug,
  round,
  today,
  currency,
  canWrite,
  keysEnabled,
  onChanged,
  onAcceptAll,
}: {
  investorId: string;
  name: string;
  row: ResearchSummary | null | undefined;
  settings: AiSettings | null | undefined;
  client: ApiClient;
  wsSlug: string;
  round: string;
  today: string;
  currency: string;
  canWrite: boolean;
  keysEnabled: boolean;
  /** Research changed this investor (a run finished, an identity was picked). */
  onChanged: () => void;
  /** Accept every pending suggestion (Triage owns the undo). */
  onAcceptAll: (suggestions: Suggestion[]) => Promise<void>;
}) {
  const { data, loading } = useInvestorResearch(client, investorId, row);
  const [run0, setRun0] = useState<Run | null>(null);
  const [startErr, setStartErr] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const done = useCallback(() => {
    forgetInvestorResearch(investorId);
    onChanged();
  }, [investorId, onChanged]);
  const run = useRunPoll(client, run0 ?? data?.run ?? null, done);
  const first = name.split(/\s+/)[0] ?? name;
  const pending = useMemo(() => (data?.suggestions ?? []).filter((s) => s.status === "pending"), [data]);
  const groups = useMemo(() => groupSuggestions(pending), [pending]);
  const [accepting, setAccepting] = useState(false);
  const acceptAll = async () => {
    if (!pending.length || accepting) return;
    setAccepting(true);
    try {
      await onAcceptAll(pending);
    } finally {
      setAccepting(false);
    }
  };
  useHotkey("a", () => void acceptAll(), {
    enabled: keysEnabled && canWrite && pending.length > 0,
    description: "Accept research suggestions",
    group: "Triage",
  });

  const available = Boolean(settings?.research_available);
  const start = async () => {
    setStarting(true);
    setStartErr(null);
    try {
      const r = await startResearch(client, investorId, { kind: "dossier", round });
      setRun0(r.run);
    } catch (e) {
      setStartErr(e);
    } finally {
      setStarting(false);
    }
  };

  const view = data?.view ?? null;
  const parts = useMemo(() => (view ? sectionsOf(view) : null), [view]);
  const active = run && isActive(run.status);
  let body: React.ReactNode;
  if (active) {
    body = (
      <div className="flex flex-col gap-6">
        <p className="text-muted">Researching {first}. Keep sorting; the Brief lands here when it is done.</p>
        <RunProgress run={run!} client={client} wsSlug={wsSlug} canWrite={canWrite} onChange={setRun0} />
      </div>
    );
  } else if (view && parts) {
    body = <Brief view={view} citations={parts.citations} briefCites={parts.briefCites} today={today} compact />;
  } else if (row?.identity_status === "needs_pick" && data?.identity) {
    body = (
      <div className="flex flex-col gap-2">
        <p className="t-body-s text-muted">
          <b className="font-semibold text-fg">Is this {first}?</b> Research waits until you pick.
        </p>
        <IdentityPicker identity={data.identity} name={name} client={client} canWrite={canWrite} compact onPicked={done} />
      </div>
    );
  } else if (loading && !data) {
    body = <p className="t-body-s text-muted">Loading research…</p>;
  } else if (!available) {
    body = (
      <p className="t-body-s text-muted">
        No dossier on {first}. Research runs on your own OpenRouter key:{" "}
        <Link href={`/w/${encodeURIComponent(wsSlug)}/settings/ai`} className="link">
          set one up
        </Link>
        , or have your agent save one with <span className="font-mono text-micro">save_dossier</span>.
      </p>
    );
  } else {
    const e = startErr ? researchErrorText(startErr) : null;
    body = (
      <div className="flex flex-col gap-8">
        <p className="t-body-s text-muted">
          {row?.identity_status === "not_found"
            ? `No public profile clearly matched ${name}. Add their LinkedIn in the file to anchor research.`
            : `No dossier on ${first} yet: who they are, recent deals, a way in and an opener, each with its source.`}
        </p>
        {canWrite && row?.identity_status !== "not_found" ? (
          <div>
            <Button size="sm" busy={starting ? "Starting…" : false} onClick={() => void start()}>
              Research {first} {approxUsd(settings?.estimates.current)}
            </Button>
          </div>
        ) : null}
        {e ? (
          <p className="t-body-s text-bad">
            {e.text} {e.code ? <span className="font-mono text-micro">{e.code}</span> : null}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 overflow-hidden" style={{ height: TRIAGE_RESEARCH_H }} aria-label={`Research on ${name}`}>
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
      {groups.length && !active ? (
        <div className="flex h-22 min-w-0 shrink-0 items-center gap-10 border-t border-line pt-4">
          <span className="t-body-s min-w-0 flex-1 truncate">{suggestionLine(groups[0]!, currency)}</span>
          {groups.length > 1 ? <span className="t-micro shrink-0 text-muted">+{groups.length - 1} more</span> : null}
          {canWrite ? (
            <button
              type="button"
              className={cn("link t-body-s inline-flex shrink-0 items-center gap-4 border-0 bg-transparent p-0", accepting && "opacity-55")}
              onClick={() => void acceptAll()}
              disabled={accepting}
            >
              {groups.length > 1 ? `Accept all ${groups.length}` : "Accept"} {keysEnabled ? <Kbd>A</Kbd> : null}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
