// STUB by Foundation-web. Owner: App-UI (docs/OWNERSHIP.md) — replace freely.
import type { Metadata } from "next";

import { Wordmark } from "@/components/ui";

import { Stub } from "@/app/_stub/Stub";

export const metadata: Metadata = { title: "Get started", robots: { index: false } };

export default function OnboardingPage() {
  return (
    <div className="mx-auto w-full max-w-flow pt-24 pb-48">
      <div className="mb-32 flex items-center">
        <Wordmark size={20} href="/" />
        <span className="t-micro ml-auto text-muted">1 / 3</span>
      </div>
      <Stub title="What are you raising for?" owner="App-UI" />
    </div>
  );
}
