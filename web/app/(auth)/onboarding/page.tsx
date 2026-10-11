import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Onboarding } from "@/components/app/onboarding/Onboarding";
import { ApiErrorState } from "@/components/app/ApiErrorState";
import { getSession } from "@/lib/api/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Get started", robots: { index: false } };

/** Onboarding (SYSTEM §4.11): company → first round → bring investors. */
export default async function OnboardingPage() {
  const s = await getSession();
  if (s.status === "signed_out") redirect("/signin?next=%2Fonboarding");
  if (s.status === "error") {
    return (
      <div className="mx-auto w-full max-w-flow pt-48">
        <ApiErrorState error={s.error} title="Raisebook can't reach its API right now" retryHref="/onboarding" />
      </div>
    );
  }
  return (
    <Suspense>
      <Onboarding csrf={s.session.csrf_token} workspaces={s.session.workspaces} />
    </Suspense>
  );
}
