import { redirect } from "next/navigation";

import { getSession } from "@/lib/api/server";

import { LastWorkspaceRedirect } from "../_shell/LastWorkspaceRedirect";

export const dynamic = "force-dynamic";

/**
 * /app → the last-used workspace (localStorage["rb-last-ws"], else the first), whose index page
 * then opens its first open round. No workspace yet → onboarding.
 */
export default async function AppIndex() {
  const s = await getSession();
  if (s.status !== "ok") redirect("/signin?next=%2Fapp");
  const slugs = s.session.workspaces.map((w) => w.slug);
  if (slugs.length === 0) redirect("/onboarding");
  if (slugs.length === 1) redirect(`/w/${encodeURIComponent(slugs[0]!)}`);
  return <LastWorkspaceRedirect slugs={slugs} />;
}
