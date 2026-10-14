"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { Button, Input, Kbd } from "@/components/ui";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { pickIdentity, startResearch, type AiSettings, type ResearchSummary, type Run, type Suggestion } from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { useHotkey } from "@/lib/hotkeys";
import { approxUsd, groupSuggestions, isActive, researchActions, sectionsOf, startedNote, suggestionLine } from "@/lib/research";

import { Brief } from "./Brief";
import { forgetInvestorResearch, requestDossierTab, useInvestorResearch, useRunPoll } from "./hooks";
import { IdentityPicker } from "./IdentityPicker";
import { ResearchError, SpendLimitNote } from "./ResearchError";
import { RunProgress } from "./RunProgress";

/** Not found / "none of these": type their LinkedIn, or search again (one cheap call). */
function FindAgain({
  investorId,
  name,
  client,
  settings,
  onPicked,
  onSearch,
}: {
  investorId: string;
  name: string;
  client: ApiClient;
  settings: AiSettings | null | undefined;
  onPicked: () => void;
  onSearch: () => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"save" | "search" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="flex min-w-0 items-center gap-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!url.trim()) return;
        setBusy("save");
        setErr(null);
        try {
          await pickIdentity(client, investorId, { linkedin_url: url.trim() });
          onPicked();
        } catch (x) {
          setErr(errorMessage(x));
        } finally {
          setBusy(null);
        }
      }}
    >
      <Input
        size="sm"
        type="url"
        inputMode="url"
        placeholder="https://www.linkedin.com/in/…"
        aria-label={`LinkedIn URL for ${name}`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="min-w-0 flex-1"
      />
      <Button size="sm" type="submit" disabled={!url.trim()} busy={busy === "save" ? "Saving…" : false}>
        Use this
      </Button>
      {settings?.research_available && !settings.usage.cap_reached ? (
        <button
          type="button"
          className="link t-body-s shrink-0 border-0 bg-transparent p-0"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("search");
            try {
              await onSearch();
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "search" ? "Starting…" : `Search again ${approxUsd(settings.estimates.identity)}`}
        </button>
      ) : null}
      {err ? <span className="t-body-s text-bad">{err}</span> : null}
    </form>
  );
}

/** The research block's fixed height: the decision panel never moves between investors. */
/** The research block's height beside the keyboard panel (the `sm:h-[148px]` below). */
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
  onOpenDossier,
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
  /** Open the investor's file (the sheet), on its Dossier tab. */
  onOpenDossier?: () => void;
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
  const capReached = Boolean(settings?.usage.cap_reached);
  const start = async (kind: "dossier" | "identity" | "refresh" = "dossier") => {
    setStarting(true);
    setStartErr(null);
    try {
      const r = await startResearch(client, investorId, { kind, round });
      // A fresh dossier (or a confirmed identity) comes back instead of a new paid run.
      if (startedNote(r)) done();
      else if (r.run) setRun0(r.run);
    } catch (e) {
      setStartErr(e);
    } finally {
      setStarting(false);
    }
  };

  const view = data?.view ?? null;
  const parts = useMemo(() => (view ? sectionsOf(view) : null), [view]);
  const active = run && isActive(run.status);
  const stopped = run && !active && run.status !== "succeeded" && !view ? run : null;
  const status = row?.identity_status;
  let body: React.ReactNode;
  if (active) {
    body = (
      <div className="flex flex-col gap-6">
        <p className="text-muted">Researching {first}. Keep sorting; the Brief lands here when it is done.</p>
        <RunProgress run={run!} client={client} wsSlug={wsSlug} canWrite={canWrite} onChange={setRun0} />
      </div>
    );
  } else if (view && parts) {
    const actions = researchActions(view.dossier.created_at, new Date());
    body = (
      <Brief
        view={view}
        citations={parts.citations}
        briefCites={parts.briefCites}
        today={today}
        compact
        aside={
          actions.primary === "open" && onOpenDossier ? (
            <>
              <button
                type="button"
                className="link shrink-0 border-0 bg-transparent p-0"
                onClick={() => {
                  requestDossierTab(investorId);
                  onOpenDossier();
                }}
              >
                Open dossier
              </button>
              {canWrite && available && !capReached ? (
                <button type="button" className="shrink-0 border-0 bg-transparent p-0 text-muted hover:text-fg" onClick={() => void start("refresh")}>
                  Refresh {approxUsd(settings?.estimates.current)}
                </button>
              ) : null}
            </>
          ) : null
        }
      />
    );
  } else if (status === "needs_pick" && data?.identity) {
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
  } else if (status === "not_found" || status === "rejected") {
    body = (
      <div className="flex flex-col gap-6">
        <p className="t-body-s text-muted">
          {status === "not_found" ? `No public profile clearly matched ${name}.` : `None of the people found was ${first}.`} Add their LinkedIn to
          anchor research{canWrite ? ", or search again." : "."}
        </p>
        {canWrite ? <FindAgain investorId={investorId} name={name} client={client} settings={settings} onPicked={done} onSearch={() => start("identity")} /> : null}
        {startErr ? <ResearchError error={startErr} wsSlug={wsSlug} /> : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        {stopped ? (
          <RunProgress run={stopped} client={client} wsSlug={wsSlug} canWrite={canWrite} onChange={setRun0} compact />
        ) : (
          <p className="t-body-s text-muted">No dossier on {first} yet: who they are, recent deals, a way in and an opener, each with its source.</p>
        )}
        {canWrite && !stopped ? (
          capReached ? (
            <SpendLimitNote settings={settings} wsSlug={wsSlug} />
          ) : (
            <div>
              <Button size="sm" busy={starting ? "Starting…" : false} onClick={() => void start()}>
                Research {first} {approxUsd(settings?.estimates.current)}
              </Button>
            </div>
          )
        ) : null}
        {startErr ? <ResearchError error={startErr} wsSlug={wsSlug} /> : null}
      </div>
    );
  }

  return (
    // Fixed height beside the keyboard panel (no jump between investors); on a phone it grows,
    // so the "Is this them?" rows can show the whole title and firm.
    <div className="flex min-h-[148px] min-w-0 flex-col gap-6 sm:h-[148px] sm:overflow-hidden" aria-label={`Research on ${name}`}>
      <div className="min-h-0 flex-1 sm:overflow-hidden">{body}</div>
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
