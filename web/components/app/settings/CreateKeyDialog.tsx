"use client";

import { useEffect, useState } from "react";

import { Button, Checkbox, Dialog, Field, Input, Radio, SecretReveal } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { createApiKey } from "@/lib/api/settings";
import type { ApiKey, Scope } from "@/lib/api/types";

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

export interface KeyDraft {
  name: string;
  agentName: string;
  write: boolean;
  admin: boolean;
  expires: "never" | "30" | "90";
}

export function scopesOf(d: Pick<KeyDraft, "write" | "admin">): Scope[] {
  const s: Scope[] = ["raisebook:read"];
  if (d.write || d.admin) s.push("raisebook:write");
  if (d.admin) s.push("raisebook:admin");
  return s;
}

export function expiresAt(d: Pick<KeyDraft, "expires">): string | null {
  if (d.expires === "never") return null;
  return new Date(Date.now() + Number(d.expires) * 86400_000).toISOString();
}

/** Validate and create; returns the API error message on failure. */
export async function submitKey(client: ApiClient, d: KeyDraft): Promise<{ key?: ApiKey; secret?: string; error?: string }> {
  if (!d.name.trim()) return { error: "Name the key after where it lives, like “Claude Code on my laptop”." };
  if (d.agentName.trim() && !AGENT_RE.test(d.agentName.trim()))
    return { error: "Agent name: letters, numbers, spaces, dots, dashes and underscores, up to 60 characters." };
  try {
    const res = await createApiKey(client, {
      name: d.name.trim(),
      agent_name: d.agentName.trim() || null,
      scopes: scopesOf(d),
      expires_at: expiresAt(d),
    });
    return { key: res.api_key, secret: res.secret };
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : errorMessage(err) };
  }
}

/** The scope and expiry fields shared by the dialog and the Connect page. */
export function KeyFields({ d, set, compact }: { d: KeyDraft; set: (d: KeyDraft) => void; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-12">
      <div className={compact ? "grid grid-cols-1 gap-12 sm:grid-cols-2" : "flex flex-col gap-12"}>
        <Field label="Name" hint="Where this key lives. Only you see it.">
          <Input value={d.name} maxLength={80} onChange={(e) => set({ ...d, name: e.target.value })} placeholder="Claude Code on my laptop" />
        </Field>
        <Field label="Agent name" optional hint="Shown on the timeline for everything this key does.">
          <Input value={d.agentName} maxLength={60} mono onChange={(e) => set({ ...d, agentName: e.target.value })} placeholder="claude-code" />
        </Field>
      </div>
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-6 text-[12px] text-muted">Scopes</legend>
        <Checkbox
          checked
          disabled
          label="Read"
          badge="Always on"
          hint="Rounds, investors, timelines, follow-ups and exports."
        />
        <Checkbox
          checked={d.write || d.admin}
          disabled={d.admin}
          onChange={(e) => set({ ...d, write: e.target.checked })}
          label="Write"
          hint="Add investors, move stages, log activity, set follow-ups, record commitments, import."
        />
        <Checkbox
          checked={d.admin}
          onChange={(e) => set({ ...d, admin: e.target.checked, write: e.target.checked ? true : d.write })}
          label="Admin"
          hint="Also change workspace settings and delete rounds. Agents rarely need this."
        />
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-6 border-0 p-0">
        <legend className="mb-6 text-[12px] text-muted">Expires</legend>
        <div className="flex flex-wrap gap-16">
          {(["never", "30", "90"] as const).map((e) => (
            <Radio key={e} name="expires" checked={d.expires === e} onChange={() => set({ ...d, expires: e })} label={e === "never" ? "Never" : `In ${e} days`} />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** "Create key" (SYSTEM §4.9): the form, then the copy-once SecretReveal. */
export function CreateKeyDialog({
  open,
  onClose,
  client,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  onCreated: (k: ApiKey) => void;
}) {
  const blank: KeyDraft = { name: "", agentName: "", write: true, admin: false, expires: "never" };
  const [d, setD] = useState<KeyDraft>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setD(blank);
      setError(null);
      setSecret(null);
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    setSecret(null); // never rendered again
    onClose();
  };

  if (secret) {
    return (
      <Dialog
        open={open}
        onClose={close}
        dismissible={false}
        title="Your new key"
        actions={
          <Button variant="primary" onClick={close}>
            {copied ? "Done" : "I've stored it"}
          </Button>
        }
      >
        <SecretReveal secret={secret} label={d.name} onCopied={() => setCopied(true)} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Create key"
      description="For an agent or a script. It can only reach this workspace."
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        const res = await submitKey(client, d);
        setBusy(false);
        if (res.error) return setError(res.error);
        if (res.key && res.secret) {
          setSecret(res.secret);
          onCreated(res.key);
        }
      }}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy ? "Creating…" : false}>
            Create key
          </Button>
        </>
      }
    >
      <KeyFields d={d} set={setD} />
      {error ? <p className="t-body-s mt-10 text-bad">{error}</p> : null}
    </Dialog>
  );
}
