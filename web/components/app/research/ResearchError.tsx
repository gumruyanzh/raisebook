"use client";

import Link from "next/link";

import { ApiError, errorMessage } from "@/lib/api/client";
import { capUsd, formatUsd } from "@/lib/research";

/**
 * What a refused research request means and where to go next (SYSTEM §6: say what went
 * wrong and what to do, with the code in mono).
 */
export function researchErrorText(err: unknown): { text: string; code: string | null; action: "settings" | "pick" | null } {
  if (!(err instanceof ApiError)) return { text: errorMessage(err), code: null, action: null };
  const d = (err.details ?? {}) as Record<string, unknown>;
  switch (err.code) {
    case "no_ai_key":
      return { text: "Research runs on your own OpenRouter key, and this workspace has none yet.", code: err.code, action: "settings" };
    case "spend_cap_reached": {
      const cap = typeof d.cap_usd === "number" ? d.cap_usd : null;
      const spent = typeof d.spent_usd === "number" ? d.spent_usd : null;
      const head = cap !== null ? `This month's ${capUsd(cap)} research limit is used up` : "This month's research limit is used up";
      return { text: `${head}${spent !== null ? ` (${formatUsd(spent)} spent)` : ""}. Raise it, or wait for next month.`, code: err.code, action: "settings" };
    }
    case "identity_required":
      return { text: "Pick who this investor is first; research needs a confirmed identity.", code: err.code, action: "pick" };
    case "research_suppressed":
      return { text: "This person asked not to be researched. Raisebook will not research them.", code: err.code, action: null };
    case "research_unavailable":
      return { text: "Research is not set up on this server (no encryption key). Ask whoever runs it.", code: err.code, action: null };
    default:
      return { text: err.message, code: err.code, action: null };
  }
}

export function ResearchError({ error, wsSlug, className }: { error: unknown; wsSlug: string; className?: string }) {
  const e = researchErrorText(error);
  return (
    <p role="alert" className={`t-body-s text-bad ${className ?? ""}`}>
      {e.text}
      {e.action === "settings" ? (
        <>
          {" "}
          <Link className="link" href={`/w/${encodeURIComponent(wsSlug)}/settings/ai`}>
            Open AI research settings
          </Link>
        </>
      ) : null}
      {e.code ? <span className="ml-6 font-mono text-micro">{e.code}</span> : null}
    </p>
  );
}
