"use client";

import { useState } from "react";

import { Kbd } from "@/components/ui";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { acceptAllSuggestions, acceptSuggestion, ignoreSuggestion, type Suggestion } from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { groupSuggestions, suggestionLine } from "@/lib/research";

const BTN = "link t-body-s shrink-0 border-0 bg-transparent p-0 disabled:opacity-55";

/**
 * Pending research suggestions (R7): research never changes a filled field on its own. Each
 * line says what research found and what you have, with Accept and Ignore; "Accept all"
 * takes every one for this investor in one go. `compact` (Triage): one line each, truncated,
 * and the `A` key hint.
 */
export function SuggestionList({
  suggestions,
  investorId,
  client,
  currency,
  canWrite,
  onChanged,
  compact = false,
  max,
}: {
  suggestions: Suggestion[];
  investorId: string;
  client: ApiClient;
  currency: string;
  canWrite: boolean;
  /** After an accept or ignore: reload the investor and the dossier. */
  onChanged: (accepted: number) => void;
  compact?: boolean;
  /** Show at most this many lines ("and 2 more"). */
  max?: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const groups = groupSuggestions(suggestions.filter((s) => s.status === "pending"));
  if (!groups.length) return null;
  const run = async (key: string, fn: () => Promise<unknown>, accepted: number) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      onChanged(accepted);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const shown = max ? groups.slice(0, max) : groups;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((g) => (
          <li key={g.key} className={cn("flex min-w-0 items-baseline gap-10", compact ? "h-22 items-center" : "border-b border-line py-6 last:border-b-0")}>
            <span className={cn("min-w-0 flex-1", compact && "truncate")}>{suggestionLine(g, currency)}</span>
            {canWrite ? (
              <>
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => void run(g.key, () => acceptSuggestion(client, g.primary.id), 1)}>
                  {busy === g.key ? "Accepting…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="t-body-s shrink-0 border-0 bg-transparent p-0 text-muted hover:text-fg disabled:opacity-55"
                  disabled={busy !== null}
                  onClick={() => void run(`i${g.key}`, () => Promise.all(g.ids.map((id) => ignoreSuggestion(client, id))), 0)}
                >
                  Ignore
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {max && groups.length > max ? <p className="t-micro text-muted">and {groups.length - max} more in the dossier</p> : null}
      {canWrite && (groups.length > 1 || compact) ? (
        <p className="t-body-s flex items-center gap-6">
          <button
            type="button"
            className="link inline-flex items-center gap-4 border-0 bg-transparent p-0"
            disabled={busy !== null}
            onClick={() => void run("all", () => acceptAllSuggestions(client, { investorIds: [investorId] }), groups.length)}
          >
            {busy === "all" ? "Accepting…" : groups.length > 1 ? `Accept all ${groups.length}` : "Accept"}
          </button>
          {compact ? <Kbd>A</Kbd> : null}
        </p>
      ) : null}
      {err ? <p className="t-body-s text-bad">{err}</p> : null}
    </div>
  );
}
