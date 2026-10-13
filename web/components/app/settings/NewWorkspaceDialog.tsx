"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, CurrencyPicker, Dialog, Field, Input, TimezonePicker } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { createWorkspace } from "@/lib/api/core";
import { guessCurrency } from "@/lib/currency";
import { browserTimeZone, loadZoneData } from "@/lib/tz";

/**
 * "New workspace" as a short dialog (UX pass 1, P2-12): name, timezone and currency, then the
 * New round dialog of the new workspace. No full onboarding for a second company.
 * Wire it to the workspace switcher's "New workspace" entry (WS-C owns the TopBar).
 */
export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [tz, setTz] = useState("UTC");
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [currency, setCurrency] = useState("USD");
  const touched = useRef(false);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const zone = browserTimeZone();
    const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
    setName("");
    setTz(zone);
    setBrowserTz(zone);
    setCurrency(guessCurrency({ timeZone: zone, locale }));
    touched.current = false;
    setNameError(null);
    setError(null);
    loadZoneData().then(
      () => {
        if (!touched.current) setCurrency(guessCurrency({ timeZone: zone, locale }));
      },
      () => undefined,
    );
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      setNameError("Enter the company's name.");
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const w = await createWorkspace(api, { name: name.trim(), timezone: tz, default_currency: currency });
      onClose();
      router.push(`/w/${encodeURIComponent(w.slug)}/settings?new_round=1`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      dismissible={!busy}
      width={520}
      title="New workspace"
      description="One workspace per company. Its rounds, investors and members stay separate."
      onSubmit={() => void submit()}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy ? "Creating…" : false}>
            Create workspace
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-12 sm:grid-cols-[3fr_2fr]">
        <Field label="Company name" error={nameError} className="sm:col-span-2">
          <Input
            ref={nameRef}
            autoFocus
            value={name}
            maxLength={80}
            autoComplete="organization"
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            placeholder="Acme Robotics"
          />
        </Field>
        <Field label="Timezone" hint="Follow-ups are due by this calendar.">
          <TimezonePicker value={tz} suggest={browserTz} onChange={setTz} />
        </Field>
        <Field label="Default currency">
          <CurrencyPicker
            value={currency}
            suggestFrom={{ timeZone: tz }}
            onChange={(c) => {
              touched.current = true;
              setCurrency(c);
            }}
          />
        </Field>
      </div>
      {error ? (
        <p className="t-body-s mt-10 text-bad" role="alert">
          {error.message}
          {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
        </p>
      ) : null}
    </Dialog>
  );
}
