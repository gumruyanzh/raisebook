"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Loading } from "@/components/ui";
import { readLastWorkspace } from "@/lib/session";

/** Client half of /app: picks the remembered workspace if it is still one of the user's. */
export function LastWorkspaceRedirect({ slugs }: { slugs: string[] }) {
  const router = useRouter();
  useEffect(() => {
    const last = readLastWorkspace();
    const slug = last && slugs.includes(last) ? last : slugs[0];
    if (slug) router.replace(`/w/${encodeURIComponent(slug)}`);
  }, [router, slugs]);
  return <Loading className="gutter py-48">Opening your workspace…</Loading>;
}
