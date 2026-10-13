"use client";

import { useState } from "react";

import { Button, Input } from "@/components/ui";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import { pickIdentity, type Candidate, type Identity } from "@/lib/api/research";
import { cn } from "@/lib/cn";

const linkCls = "link t-body-s whitespace-nowrap";
const hostOf = (u: string | null | undefined) => (u ? u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "") : "");

/**
 * "Is this them?" (R3): 2–3 candidates when the identity step was not sure, ruled rows (no
 * cards). "This one" confirms the anchor every later search must match; "None of these"
 * stops research for this person; a LinkedIn URL typed by hand confirms without a call.
 * `compact` (Triage's decision panel): one line per candidate, buttons only.
 */
export function IdentityPicker({
  identity,
  name,
  client,
  canWrite,
  onPicked,
  compact = false,
}: {
  identity: Identity;
  name: string;
  client: ApiClient;
  canWrite: boolean;
  onPicked: (identity: Identity) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [url, setUrl] = useState("");
  const pick = async (key: string, body: Parameters<typeof pickIdentity>[2]) => {
    setBusy(key);
    setErr(null);
    try {
      onPicked(await pickIdentity(client, identity.investor_id, body));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const cands = identity.candidates.slice(0, 3);
  const first = name.split(/\s+/)[0] ?? name;
  const manualForm = (
    <form
      className="flex min-w-0 items-center gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) void pick("manual", { linkedin_url: url.trim() });
      }}
    >
      <Input
        size="sm"
        type="url"
        inputMode="url"
        autoFocus
        placeholder="https://www.linkedin.com/in/…"
        aria-label={`LinkedIn URL for ${name}`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="min-w-0 flex-1"
      />
      <Button size="sm" type="submit" disabled={!url.trim()} busy={busy === "manual" ? "Saving…" : false}>
        Use this
      </Button>
      <button type="button" className="t-body-s border-0 bg-transparent p-0 text-muted hover:text-fg" onClick={() => setManual(false)}>
        Cancel
      </button>
    </form>
  );

  if (compact) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <ul className="m-0 flex list-none flex-col p-0">
          {cands.map((c) => (
            <li key={c.id} className="flex h-32 min-w-0 items-center gap-8">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{[c.title, c.firm].filter(Boolean).join(", ") || c.name}</span>
                <span className="t-micro ml-6 text-muted">{c.confidence_label}</span>
              </span>
              {c.linkedin_url ? (
                <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" className={linkCls}>
                  LinkedIn ↗
                </a>
              ) : null}
              <Button size="sm" disabled={!canWrite} busy={busy === c.id ? "Saving…" : false} onClick={() => void pick(c.id, { candidate_id: c.id })}>
                This one
              </Button>
            </li>
          ))}
        </ul>
        {manual ? (
          manualForm
        ) : (
          <p className="t-body-s flex flex-wrap gap-x-16">
            <button type="button" className="link border-0 bg-transparent p-0" disabled={!canWrite} onClick={() => void pick("none", { none: true })}>
              None of these
            </button>
            <button type="button" className="link border-0 bg-transparent p-0" disabled={!canWrite} onClick={() => setManual(true)}>
              Enter LinkedIn URL
            </button>
          </p>
        )}
        {err ? <p className="t-body-s text-bad">{err}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <p className="text-fg">
        <b className="font-semibold">Is this {first}?</b>{" "}
        <span className="text-muted">
          {cands.length > 1 ? `${cands.length} people could be ${name}.` : `One person could be ${name}.`} Research runs once you pick; nothing
          deeper runs until then.
        </span>
      </p>
      <ul className="m-0 flex list-none flex-col border-t border-line p-0">
        {cands.map((c) => (
          <CandidateRow key={c.id} c={c} name={name} canWrite={canWrite} busy={busy === c.id} onPick={() => void pick(c.id, { candidate_id: c.id })} />
        ))}
      </ul>
      {manual ? (
        manualForm
      ) : (
        <p className="t-body-s flex flex-wrap items-center gap-x-16 gap-y-4">
          <button type="button" className="link border-0 bg-transparent p-0" disabled={!canWrite || busy !== null} onClick={() => void pick("none", { none: true })}>
            {busy === "none" ? "Saving…" : "None of these"}
          </button>
          <button type="button" className="link border-0 bg-transparent p-0" disabled={!canWrite} onClick={() => setManual(true)}>
            Enter their LinkedIn URL
          </button>
        </p>
      )}
      {err ? <p className="t-body-s text-bad">{err}</p> : null}
    </div>
  );
}

function CandidateRow({ c, name, canWrite, busy, onPick }: { c: Candidate; name: string; canWrite: boolean; busy: boolean; onPick: () => void }) {
  // The name is usually the same for every candidate: what tells them apart leads the row.
  const what = [c.title, c.firm].filter(Boolean).join(" · ") || c.name;
  const sameName = c.name.trim().toLowerCase() === name.trim().toLowerCase();
  const own = new Set([hostOf(c.firm_website), "linkedin.com"]);
  const others = c.sources.filter((s) => !own.has(s.domain.replace(/^www\./, "")));
  return (
    <li className="flex min-w-0 items-start gap-12 border-b border-line py-10">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-8">
          <span className="truncate font-semibold">{what}</span>
          <span className={cn("t-micro shrink-0", c.confidence_label === "likely" ? "text-fg" : "text-muted")}>{c.confidence_label}</span>
        </p>
        {sameName ? null : <p className="t-body-s truncate text-muted">{c.name}</p>}
        <p className="mt-4 flex flex-wrap items-baseline gap-x-10 gap-y-2">
          {c.linkedin_url ? (
            <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" className={linkCls}>
              LinkedIn ↗
            </a>
          ) : null}
          {c.firm_website ? (
            <a href={c.firm_website} target="_blank" rel="noopener noreferrer" className={linkCls}>
              {c.firm_website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")} ↗
            </a>
          ) : null}
          {others.slice(0, 3).map((s) => (
            <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title ?? s.url} className="t-micro text-muted hover:text-fg hover:underline">
              {s.domain}
            </a>
          ))}
        </p>
      </div>
      <Button size="sm" disabled={!canWrite} busy={busy ? "Saving…" : false} onClick={onPick}>
        This one
      </Button>
    </li>
  );
}
