"use client";

import Link from "next/link";

import { ApiError, errorMessage } from "@/lib/api/client";
import type { AiSettings } from "@/lib/api/research";
import { capUsd, formatUsd, limitUsedLine } from "@/lib/research";

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
      const left = typeof d.remaining_usd === "number" ? d.remaining_usd : null;
      const needed = typeof d.needed_usd === "number" ? d.needed_usd : null;
      if (cap !== null && left !== null && left > 0 && needed !== null) {
        return {
          text: `This can cost up to ${formatUsd(needed)}, and ${formatUsd(left)} of this month's ${capUsd(cap)} AI research limit is left.`,
          code: err.code,
          action: "settings",
        };
      }
      return { text: cap !== null ? limitUsedLine(cap, spent) : "This month's AI research limit is used up.", code: err.code, action: "settings" };
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

/** The monthly limit is used up: one sentence, and where to raise it (owners and admins). */
export function SpendLimitNote({ settings, wsSlug }: { settings: AiSettings | null | undefined; wsSlug: string }) {
  if (!settings) return null;
  return (
    <p className="t-body-s text-warm-ink" role="status">
      {limitUsedLine(settings.monthly_cap_usd, settings.usage.spent_usd)}{" "}
      {settings.can_edit ? (
        <Link className="link" href={`/w/${encodeURIComponent(wsSlug)}/settings/ai`}>
          Raise it in Settings
        </Link>
      ) : (
        "An owner can raise it in Settings."
      )}
    </p>
  );
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
