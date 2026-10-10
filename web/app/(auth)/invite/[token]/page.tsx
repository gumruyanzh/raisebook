import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui";
import { ApiError, createApiClient } from "@/lib/api/client";
import { lookupInvite, ROLE_LABEL, type InviteLookup } from "@/lib/api/core";
import { getSession } from "@/lib/api/server";

import { AuthColumn } from "../../_auth";
import { SignInForm } from "../../signin/SignInForm";
import { AcceptInvite } from "./AcceptInvite";

export const metadata: Metadata = {
  title: "Invitation",
  robots: { index: false },
  referrer: "no-referrer",
};

function article(word: string) {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const anon = createApiClient({
    baseUrl: process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL,
    defaults: { cache: "no-store" },
  });

  let invite: InviteLookup | null = null;
  let problem: { message: string; code?: string } | null = null;
  try {
    invite = await lookupInvite(anon, token);
  } catch (err) {
    problem =
      err instanceof ApiError && err.isNotFound
        ? { message: "This invite link is not valid. Ask the person who invited you to send a new one.", code: err.code }
        : { message: err instanceof ApiError ? err.message : "Could not load this invite. Try again in a moment.", code: err instanceof ApiError ? err.code : undefined };
  }

  if (!invite || problem) {
    return (
      <AuthColumn>
        <h1 className="t-display-s mb-14">Invite not found</h1>
        <p role="alert">
          {problem?.message}
          {problem?.code ? <span className="ml-6 font-mono text-micro text-muted">{problem.code}</span> : null}
        </p>
        <ButtonLink href="/signin" className="mt-18 self-start">
          Sign in
        </ButtonLink>
      </AuthColumn>
    );
  }

  const role = ROLE_LABEL[invite.role].toLowerCase();
  const headline = invite.inviter_name
    ? `${invite.inviter_name} invited you to ${invite.workspace_name} as ${article(role)} ${role}`
    : `You're invited to ${invite.workspace_name} as ${article(role)} ${role}`;

  if (invite.expired) {
    return (
      <AuthColumn>
        <h1 className="t-display-s mb-14">This invite has expired</h1>
        <p>
          Invites last 7 days. Ask {invite.inviter_name ?? "the workspace owner"} to send a new one
          to <span className="font-mono text-sm">{invite.email_hint}</span>.
        </p>
      </AuthColumn>
    );
  }

  const session = await getSession();
  return (
    <AuthColumn>
      <h1 className="t-display-s mb-8">{headline}</h1>
      <p className="mb-18 text-muted">
        The invite is for <span className="font-mono text-sm text-fg">{invite.email_hint}</span>.
      </p>
      {session.status === "ok" ? (
        <AcceptInvite token={token} signedInAs={session.session.user.email} emailHint={invite.email_hint} />
      ) : (
        <SignInForm inviteToken={token} emailHint={invite.email_hint} submitLabel="Email me a link to join" />
      )}
    </AuthColumn>
  );
}
