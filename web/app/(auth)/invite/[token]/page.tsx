import type { Metadata } from "next";

import { googleEnabled } from "@/lib/api/auth-providers";
import { getSession, serverApi } from "@/lib/api/server";

import { AuthColumn } from "../../_auth";
import { InviteLanding } from "./InviteLanding";

export const metadata: Metadata = {
  title: "Invitation",
  robots: { index: false },
  referrer: "no-referrer",
};

/**
 * The invite is looked up from the browser (not from this server), so the API's per-IP limit
 * counts each visitor's own address rather than the web server's.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();
  const user = session.status === "ok" ? session.session.user : null;
  // A new user who continues with Google comes back to this page to accept (the API keeps `next`).
  const google = user ? false : await googleEnabled(await serverApi());
  return (
    <AuthColumn>
      <InviteLanding
        token={token}
        signedIn={user ? { email: user.email, name: user.name ?? null } : null}
        google={google}
      />
    </AuthColumn>
  );
}
