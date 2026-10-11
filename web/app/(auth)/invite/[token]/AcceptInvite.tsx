"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Field, Input } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { acceptInvite, signOut, updateMe } from "@/lib/api/core";

/** Signed-in path: (name, if we don't have one yet) accept the invite and open the workspace. */
export function AcceptInvite({
  token,
  signedInAs,
  currentName,
  emailHint,
}: {
  token: string;
  signedInAs: string;
  currentName: string | null;
  emailHint: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const needsName = !currentName;

  const accept = async (e?: FormEvent) => {
    e?.preventDefault();
    if (needsName && !name.trim()) {
      setError({ message: "Enter your name so your teammates know who did what." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (needsName) await updateMe(api, { name: name.trim() });
      const ws = await acceptInvite(api, token);
      router.replace(`/w/${encodeURIComponent(ws.slug)}`);
      router.refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setError({
        message:
          code === "invite_mismatch"
            ? `This invite is for ${emailHint}, and you are signed in as ${signedInAs}. Sign out and sign in with the invited address.`
            : errorMessage(err),
        code,
      });
      setBusy(false);
    }
  };

  const switchAccount = async () => {
    try {
      await signOut(api);
    } finally {
      router.replace(`/invite/${encodeURIComponent(token)}`);
      router.refresh();
    }
  };

  return (
    <form className="flex flex-col gap-14" onSubmit={accept} noValidate>
      <p className="text-muted">
        Signed in as <span className="font-mono text-sm text-fg">{signedInAs}</span>.
      </p>
      {needsName ? (
        <Field label="Your name" hint="Shown to your teammates on the timeline.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={120}
            required
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-10">
        <Button type="submit" variant="primary" size="lg" busy={busy ? "Joining…" : false}>
          Accept invite
        </Button>
        <Button type="button" variant="ghost" onClick={switchAccount}>
          Use another account
        </Button>
      </div>
      {error ? (
        <p role="alert" className="t-body-s text-bad">
          {error.message}
          {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
        </p>
      ) : null}
    </form>
  );
}
