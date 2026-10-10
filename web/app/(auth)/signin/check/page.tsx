import type { Metadata } from "next";

import { AuthColumn } from "../../_auth";
import { CheckInbox } from "./CheckInbox";

export const metadata: Metadata = { title: "Check your inbox", robots: { index: false } };

export default async function CheckPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const email = typeof sp.email === "string" ? sp.email.slice(0, 254) : undefined;
  return (
    <AuthColumn>
      <h1 className="t-display-s mb-14">Check your inbox</h1>
      <CheckInbox email={email} />
    </AuthColumn>
  );
}
