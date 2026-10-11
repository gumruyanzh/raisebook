"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, ConfirmDialog, SaveState, SectionLabel, useToast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { deleteRound, updateRound } from "@/lib/api/rounds";
import type { Round } from "@/lib/api/types";
import { num, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { draftFromRound, roundBody, RoundFields, type RoundDraft } from "./RoundForm";
import { StagesEditor } from "./StagesEditor";

/** Round settings (SYSTEM §4.6): terms, stages, close or reopen, delete. */
export function RoundSettings({ round: initial }: { round: Round }) {
  const { workspace, client, canWrite, isOwner } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [round, setRound] = useState(initial);
  const [draft, setDraft] = useState<RoundDraft>(() => draftFromRound(initial));
  const [errors, setErrors] = useState<Partial<Record<keyof RoundDraft, string>>>({});
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const base = `/w/${encodeURIComponent(workspace.slug)}`;

  const saveTerms = async () => {
    const { body, errors: errs } = roundBody(draft);
    setErrors(errs);
    if (!body) return;
    setState("saving");
    setError(null);
    try {
      const r = await updateRound(client, round.id, body);
      setRound(r);
      setDraft(draftFromRound(r));
      setState("saved");
      toast.show(`${r.name} saved.`);
      if (r.slug !== round.slug) router.replace(`${base}/r/${encodeURIComponent(r.slug)}/settings`);
      router.refresh();
    } catch (err) {
      setState("error");
      if (err instanceof ApiError && err.code === "duplicate") setErrors({ name: "Another round already has this name." });
      else setError(errorMessage(err));
    }
  };

  const toggleStatus = async () => {
    setStatusBusy(true);
    try {
      const closing = round.status === "open";
      const r = await updateRound(client, round.id, closing ? { status: "closed" } : { status: "open", closed_on: null });
      setRound(r);
      toast.show(closing ? `${r.name} is closed.` : `${r.name} is open again.`);
      router.refresh();
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setStatusBusy(false);
    }
  };

  const doDelete = async () => {
    setDelBusy(true);
    setDelErr(null);
    try {
      await deleteRound(client, round.id, round.slug);
      toast.show(`${round.name} was deleted.`);
      router.replace(base);
      router.refresh();
    } catch (err) {
      setDelErr(errorMessage(err));
      setDelBusy(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromRound(round));
  const investors = round.participant_count;

  return (
    <div className="flex max-w-[960px] flex-col gap-32">
      <section aria-label="Round terms">
        <SectionLabel aside={<SaveState state={state} />}>Round terms</SectionLabel>
        <form
          className="rounded-md border border-line bg-surface p-16"
          onSubmit={(e) => {
            e.preventDefault();
            void saveTerms();
          }}
        >
          <RoundFields draft={draft} onChange={setDraft} errors={errors} disabled={!canWrite} showNotes />
          <div className="mt-14 flex flex-wrap items-center gap-8">
            <Button type="submit" variant="primary" disabled={!canWrite || !dirty} busy={state === "saving" ? "Saving…" : false}>
              Save terms
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(draftFromRound(round))}>
                Discard changes
              </Button>
            ) : null}
            {error ? <span className="t-body-s text-bad">{error}</span> : null}
          </div>
        </form>
      </section>

      <StagesEditor
        client={client}
        round={round}
        canWrite={canWrite}
        onSaved={(r) => {
          setRound(r);
          router.refresh();
        }}
      />

      <section aria-label="Status">
        <SectionLabel>Status</SectionLabel>
        <div className="flex flex-wrap items-center gap-12 rounded-md border border-line bg-surface p-16">
          <p className="min-w-0 flex-1">
            {round.status === "open"
              ? "Close the round when it's done. It stays in Raisebook with its full history, and agents stop defaulting to it."
              : `Closed${round.closed_on ? ` on ${round.closed_on}` : ""}. Reopen it to keep working the pipeline.`}
          </p>
          <Button disabled={!canWrite} busy={statusBusy ? "Saving…" : false} onClick={() => void toggleStatus()}>
            {round.status === "open" ? "Close round" : "Reopen round"}
          </Button>
        </div>
      </section>

      {isOwner ? (
        <section aria-label="Danger zone">
          <SectionLabel>Danger zone</SectionLabel>
          <div className="flex flex-wrap items-center gap-12 rounded-md border border-bad bg-surface p-16">
            <p className="min-w-0 flex-1">
              Deleting {round.name} removes {plural(investors, "investor")} from it and every timeline entry tied to the
              round. Contacts stay in your directory.
            </p>
            <Button variant="danger-quiet" onClick={() => setDel(true)}>
              Delete round…
            </Button>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        onConfirm={doDelete}
        busy={delBusy}
        error={delErr}
        typed={round.slug}
        title={`Delete ${round.name}?`}
        confirmLabel="Delete round permanently"
      >
        <p>
          {num(investors)} {investors === 1 ? "investor is" : "investors are"} removed from this round, and its stages and
          round timeline entries are deleted. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}
