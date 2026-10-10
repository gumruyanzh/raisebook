import type { ReactNode } from "react";

import { Wordmark } from "@/components/ui";
import { cn } from "@/lib/cn";

/** The 400px centered auth column with the 28px wordmark (SYSTEM §4.12). */
export function AuthColumn({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-auth flex-col pt-[12vh] pb-48", className)}>
      <Wordmark size={28} href="/" className="mb-28 self-start" />
      {children}
    </div>
  );
}

/**
 * Only same-site paths are allowed as a post-sign-in destination: "/x", never "//host" or
 * "/\host" (open-redirect guard, mirrors the API's `redirect_path` CHECK).
 */
export function safeNext(next: string | string[] | null | undefined): string | undefined {
  const v = Array.isArray(next) ? next[0] : next;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return undefined;
  if (v.startsWith("/signin") || v.startsWith("/auth/")) return undefined;
  return v.slice(0, 1000);
}
