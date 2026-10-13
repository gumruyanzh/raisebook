"use client";

import { useEffect, useState } from "react";

import { Button, Dialog, useToast } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { createRound } from "@/lib/api/rounds";
import type { Round } from "@/lib/api/types";

import { draftFromRound, roundBody, RoundFields, type RoundDraft } from "../RoundForm";

const DEFAULT_STAGES = "New → Researching → Contacted → Replied → Meeting → Diligence → Committed → Passed";

const ROUND_NAMES = ["Seed", "Pre-seed", "Seed extension", "Series A", "Bridge", "Series B", "Series C"];

/** The first usual round name that isn't taken yet ("Seed", then "Pre-seed"…), else "". */
export function suggestRoundName(existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  return ROUND_NAMES.find((n) => !taken.has(n.toLowerCase())) ?? "";
}

/** "New round": terms only; stages start from the defaults and are edited in round settings. */
export function NewRoundDialog({
  open,
  onClose,
  client,
  defaultCurrency,
  existingNames,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  defaultCurrency: string;
  existingNames: string[];
  onCreated: (r: Round) => void;
}) {
  const toast = useToast();
  const suggest = suggestRoundName(existingNames);
  const [draft, setDraft] = useState<RoundDraft>(() => ({ ...draftFromRound(null, defaultCurrency), name: suggest }));
  const [errors, setErrors] = useState<Partial<Record<keyof RoundDraft, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft({ ...draftFromRound(null, defaultCurrency), name: suggest });
      setErrors({});
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const { body, errors: errs } = roundBody(draft);
    setErrors(errs);
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createRound(client, body);
      toast.show(`${r.name} created.`);
      onCreated(r);
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate") setErrors({ name: "A round with this name already exists." });
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={560}
      title="New round"
      onSubmit={() => void submit()}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy ? "Creating…" : false}>
            Create round
          </Button>
        </>
      }
    >
      <RoundFields
        draft={draft}
        onChange={setDraft}
        errors={errors}
        hint={<>You can change stages later. We start you with {DEFAULT_STAGES}.</>}
      />
      {error ? <p className="t-body-s mt-10 text-bad">{error}</p> : null}
    </Dialog>
  );
}
