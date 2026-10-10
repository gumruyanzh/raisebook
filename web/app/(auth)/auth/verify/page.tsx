import type { Metadata } from "next";

import { AuthColumn } from "../../_auth";
import { Verify } from "./Verify";

export const metadata: Metadata = {
  title: "Signing in",
  robots: { index: false },
  // Keep the token out of Referer headers.
  referrer: "no-referrer",
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" && sp.token.length <= 200 ? sp.token : null;
  return (
    <AuthColumn>
      <Verify token={token} />
    </AuthColumn>
  );
}
