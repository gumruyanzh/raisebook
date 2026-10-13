"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, Dialog, Field, Input, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { updateMe } from "@/lib/api/core";
import { useSession } from "@/lib/session";

const ASKED_KEY = "rb-name-asked";

/** "Add your name" dialog, opened from the account menu or the one-time toast. */
export function NameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      dismissible={!busy}
      title="Add your name"
      description="Co-founders see it on the timeline next to everything you do."
      onSubmit={async () => {
        const v = name.trim();
        if (!v) {
          setError("Enter the name your co-founders know you by.");
          return;
        }
        setBusy(true);
        try {
          await updateMe(api, { name: v });
          onClose();
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Not now
          </Button>
          <Button type="submit" variant="primary" busy={busy ? "Saving…" : false}>
            Save name
          </Button>
        </>
      }
    >
      <Field label="Your name" error={error ?? undefined}>
        <Input
          autoFocus
          value={name}
          maxLength={120}
          autoComplete="name"
          placeholder="Sam Rivera"
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
      </Field>
    </Dialog>
  );
}

/**
 * Asks once for a display name when the account has none (people who joined through an
 * emailed invite, accounts from before names were asked for): a single toast with "Add name",
 * never a permanent banner. The account menu keeps "Add your name…" and a dot on the avatar
 * until a name is set.
 */
export function useNamePrompt(onOpen: () => void): boolean {
  const session = useSession();
  const toast = useToast();
  const missing = !session.user.name;
  const done = useRef(false);
  useEffect(() => {
    if (!missing || done.current) return;
    done.current = true;
    let asked = false;
    try {
      asked = localStorage.getItem(ASKED_KEY) === "1";
      localStorage.setItem(ASKED_KEY, "1");
    } catch {
      /* storage unavailable: ask this once per page view */
    }
    if (asked) return;
    setTimeout(
      () => toast.show("Add your name so co-founders see who did what.", { label: "Add name", onClick: onOpen }),
      600,
    );
  }, [missing, onOpen, toast]);
  return missing;
}
