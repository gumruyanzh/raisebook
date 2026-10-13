"use client";

import { useEffect, useState } from "react";

import { GoogleSignIn } from "@/components/app/auth/GoogleButton";
import { ButtonLink, Skeleton } from "@/components/ui";
import { ApiError, api } from "@/lib/api/client";
import { lookupInvite, ROLE_LABEL, type InviteLookup } from "@/lib/api/core";

import { SignInForm } from "../../signin/SignInForm";
import { AcceptInvite } from "./AcceptInvite";

function article(word: string) {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

type Load =
  | { kind: "loading" }
  | { kind: "ok"; invite: InviteLookup }
  | { kind: "error"; message: string; code?: string };

export function InviteLanding({
  token,
  signedIn,
  google = false,
}: {
  token: string;
  signedIn: { email: string; name: string | null } | null;
  /** Offer "Continue with Google" (the server has it configured). */
  google?: boolean;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    lookupInvite(api, token)
      .then((invite) => live && setLoad({ kind: "ok", invite }))
      .catch((err) => {
        if (!live) return;
        setLoad(
          err instanceof ApiError && err.isNotFound
            ? {
                kind: "error",
                message:
                  "This invite link is not valid. Ask the person who invited you to send a new one.",
                code: err.code,
              }
            : {
                kind: "error",
                message:
                  err instanceof ApiError ? err.message : "Could not load this invite. Try again in a moment.",
                code: err instanceof ApiError ? err.code : undefined,
              },
        );
      });
    return () => {
      live = false;
    };
  }, [token]);

  if (load.kind === "loading") {
    return (
      <div className="flex flex-col gap-10" aria-busy="true">
        <Skeleton className="h-28 w-4/5" />
        <Skeleton className="h-16 w-3/5" />
      </div>
    );
  }

  if (load.kind === "error") {
    return (
      <>
        <h1 className="t-display-s mb-14">Invite not found</h1>
        <p role="alert">
          {load.message}
          {load.code ? <span className="ml-6 font-mono text-micro text-muted">{load.code}</span> : null}
        </p>
        <ButtonLink href="/signin" className="mt-18 self-start">
          Sign in
        </ButtonLink>
      </>
    );
  }

  const invite = load.invite;
  const role = ROLE_LABEL[invite.role].toLowerCase();
  const headline = invite.inviter_name
    ? `${invite.inviter_name} invited you to ${invite.workspace_name} as ${article(role)} ${role}`
    : `You're invited to ${invite.workspace_name} as ${article(role)} ${role}`;

  if (invite.expired) {
    return (
      <>
        <h1 className="t-display-s mb-14">This invite has expired</h1>
        <p>
          Invites last 7 days. Ask {invite.inviter_name ?? "the workspace owner"} to send a new one
          to <span className="font-mono text-sm">{invite.email_hint}</span>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="t-display-s mb-8">{headline}</h1>
      <p className="mb-18 text-muted">
        The invite is for <span className="font-mono text-sm text-fg">{invite.email_hint}</span>.
      </p>
      {signedIn ? (
        <AcceptInvite
          token={token}
          signedInAs={signedIn.email}
          currentName={signedIn.name}
          emailHint={invite.email_hint}
        />
      ) : (
        <>
          <GoogleSignIn enabled={google} next={`/invite/${encodeURIComponent(token)}`} />
          <SignInForm inviteToken={token} emailHint={invite.email_hint} submitLabel="Email me a link to join" />
        </>
      )}
    </>
  );
}
