"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { acceptInvite, signOut } from "@/lib/api/core";

/** Signed-in path: accept the invite and open the workspace. */
export function AcceptInvite({
  token,
  signedInAs,
  emailHint,
}: {
  token: string;
  signedInAs: string;
  emailHint: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
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
    <div className="flex flex-col gap-14">
      <p className="text-muted">
        Signed in as <span className="font-mono text-sm text-fg">{signedInAs}</span>.
      </p>
      <div className="flex flex-wrap items-center gap-10">
        <Button variant="primary" size="lg" onClick={accept} busy={busy ? "Joining…" : false}>
          Accept invite
        </Button>
        <Button variant="ghost" onClick={switchAccount}>
          Use another account
        </Button>
      </div>
      {error ? (
        <p role="alert" className="t-body-s text-bad">
          {error.message}
          {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
