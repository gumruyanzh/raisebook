"use client";

import { useEffect, useState } from "react";

import { Button, ButtonLink, Dialog, Field, FitMeter, Input, Select, useToast } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { createInvestor, type CreateInvestorResult } from "@/lib/api/investors";
import { addParticipant, sortedStages } from "@/lib/api/rounds";
import type { Investor, InvestorType, Participant, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";

const TYPES = Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[];
const MATCHED: Record<string, string> = {
  email: "email",
  linkedin: "LinkedIn profile",
  name_firm: "name and firm",
};

interface Draft {
  name: string;
  firm: string;
  title: string;
  email: string;
  linkedin: string;
  type: InvestorType;
  stage: string;
  fit: number;
}

/**
 * "Add investor" (SYSTEM §4.2): Name, Firm, Title, Email, LinkedIn, Type, and with a round,
 * Stage and Fit. If the API finds an existing contact, the dialog says so and offers
 * "Add to this round" and "Open" instead of creating a duplicate.
 */
export function AddInvestorDialog({
  open,
  onClose,
  client,
  wsSlug,
  round,
  onAdded,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  wsSlug: string;
  /** Without a round, the contact is created in the directory only. */
  round?: Round | null;
  onAdded: (investor: Investor, participant: Participant | null) => void;
  /** Open an existing investor (the sheet on Pipeline, the page elsewhere). */
  onOpen?: (investorId: string) => void;
}) {
  const toast = useToast();
  const stages = round ? sortedStages(round.stages) : [];
  const blank = (): Draft => ({
    name: "",
    firm: "",
    title: "",
    email: "",
    linkedin: "",
    type: "vc",
    stage: stages[0]?.key ?? "",
    // Not rated until the person picks one (imports without a fit column agree).
    fit: 0,
  });
  const [d, setD] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string; field?: string } | null>(null);
  const [match, setMatch] = useState<CreateInvestorResult | null>(null);

  useEffect(() => {
    if (open) {
      setD(blank());
      setError(null);
      setMatch(null);
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const addToRound = async (inv: Investor) => {
    if (!round) return null;
    return addParticipant(client, round.id, { investor_id: inv.id, stage: d.stage || undefined, fit: d.fit });
  };

  const submit = async () => {
    if (!d.name.trim()) {
      setError({ message: "Enter the investor's name.", field: "name" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createInvestor(client, {
        name: d.name.trim(),
        firm: d.firm.trim() || null,
        title: d.title.trim() || null,
        email: d.email.trim() || null,
        linkedin_url: d.linkedin.trim() || null,
        type: d.type,
        on_duplicate: "return_existing",
      });
      if (!res.created) {
        setMatch(res);
        return;
      }
      const part = await addToRound(res.investor);
      toast.show(round ? `${res.investor.name} added to ${round.name}.` : `${res.investor.name} added to your contacts.`);
      onAdded(res.investor, part);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const fe = err.fieldErrors;
        const field = Object.keys(fe)[0];
        setError({ message: field ? `${field.replaceAll("_", " ")}: ${fe[field]}` : err.message, code: err.code, field });
      } else setError({ message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const existing = match?.investor;
  const alreadyInRound = Boolean(existing && round && existing.rounds.some((r) => r.round_id === round.id));

  if (existing) {
    const firm = existing.firm ? ` at ${existing.firm}` : "";
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Already in your contacts"
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {onOpen ? (
              <Button
                onClick={() => {
                  onOpen(existing.id);
                  onClose();
                }}
              >
                Open
              </Button>
            ) : (
              <ButtonLink href={`/w/${encodeURIComponent(wsSlug)}/investors/${existing.id}`}>Open</ButtonLink>
            )}
            {round && !alreadyInRound ? (
              <Button
                variant="primary"
                busy={busy ? "Adding…" : false}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const part = await addToRound(existing);
                    toast.show(`${existing.name} added to ${round.name}.`);
                    onAdded(existing, part);
                    onClose();
                  } catch (err) {
                    setError({ message: errorMessage(err) });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Add to this round
              </Button>
            ) : null}
          </>
        }
      >
        <p>
          {existing.name}
          {firm} is already in your contacts (matched on {MATCHED[match?.matched_on ?? ""] ?? "their details"}).
          {alreadyInRound ? ` They are already in ${round?.name}.` : null}
        </p>
        {error ? <p className="t-body-s mt-8 text-bad">{error.message}</p> : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add investor"
      description={round ? `Adds a contact and puts them on the ${round.name} board.` : "Adds a contact to your workspace."}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy ? "Adding…" : false}>
            Add investor
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2" error={error?.field === "name" ? error.message : null}>
          <Input autoFocus value={d.name} maxLength={200} onChange={(e) => set("name", e.target.value)} placeholder="Dana Whitfield" />
        </Field>
        <Field label="Firm" optional>
          <Input value={d.firm} maxLength={200} onChange={(e) => set("firm", e.target.value)} placeholder="Harbor Light Ventures" />
        </Field>
        <Field label="Title" optional>
          <Input value={d.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="Partner" />
        </Field>
        <Field label="Email" optional>
          <Input type="email" value={d.email} maxLength={254} onChange={(e) => set("email", e.target.value)} placeholder="dana@example.com" />
        </Field>
        <Field label="LinkedIn" optional>
          <Input value={d.linkedin} maxLength={500} onChange={(e) => set("linkedin", e.target.value)} placeholder="linkedin.com/in/…" />
        </Field>
        <Field label="Type">
          <Select value={d.type} onChange={(e) => set("type", e.target.value as InvestorType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {INVESTOR_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {round ? (
          <Field label={`Stage in ${round.name}`}>
            <Select value={d.stage} onChange={(e) => set("stage", e.target.value)}>
              {stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {round ? (
          <div className="flex flex-col gap-4">
            <span className="text-[12px] text-muted">Fit</span>
            <div className="flex h-32 items-center">
              <FitMeter editable value={d.fit} onChange={(v) => set("fit", v)} />
            </div>
          </div>
        ) : null}
      </div>
      {error && error.field !== "name" ? (
        <p className="t-body-s mt-10 text-bad">
          {error.message}
          {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
        </p>
      ) : null}
    </Dialog>
  );
}
