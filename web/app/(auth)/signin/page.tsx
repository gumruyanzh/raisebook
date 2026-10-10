import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/api/server";

import { AuthColumn, safeNext } from "../_auth";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const invite = typeof sp.invite === "string" ? sp.invite : undefined;

  // Already signed in: go where they were headed.
  const session = await getSession();
  if (session.status === "ok") redirect(next ?? "/app");

  return (
    <AuthColumn>
      <h1 className="t-display-s mb-18">Sign in or create an account</h1>
      <SignInForm next={next} inviteToken={invite} />
    </AuthColumn>
  );
}
