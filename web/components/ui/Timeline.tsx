"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import type { Activity, ActivityKind } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import {
  dayLabel,
  formatDate,
  formatDateTime,
  formatTime,
  isoDate,
  money,
  todayIn,
} from "@/lib/format";

import { ActorName } from "./ActorName";
import { Segmented } from "./Segmented";

export type TimelineFilter = "all" | "conversations" | "stage_money" | "agent";

const CONVERSATION: ActivityKind[] = ["note", "email", "call", "meeting"];
const STAGE_MONEY: ActivityKind[] = ["stage_change", "commitment", "follow_up_set"];

export function matchesTimelineFilter(a: Activity, f: TimelineFilter): boolean {
  if (f === "conversations") return CONVERSATION.includes(a.kind);
  if (f === "stage_money") return STAGE_MONEY.includes(a.kind);
  if (f === "agent") return a.actor.type === "agent";
  return true;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const stageLabel = (v: unknown): string =>
  v && typeof v === "object" && "label" in v ? s((v as { label: unknown }).label) : "";

/**
 * The action sentence for an activity (SYSTEM §6: say what happened). `withInvestor` names the
 * investor (round feeds); omit it on an investor's own timeline.
 */
export function activitySentence(
  a: Activity,
  { withInvestor = false, currency = "USD" }: { withInvestor?: boolean; currency?: string } = {},
): string {
  const who = withInvestor ? a.investor_name : "";
  const with_ = who ? ` with ${who}` : "";
  const d = a.data ?? {};
  const dir = s(d.direction);
  switch (a.kind) {
    case "note":
      return who ? `added a note on ${who}` : "added a note";
    case "email":
      return dir === "inbound"
        ? `logged an email from ${who || "them"}`
        : `logged an email${who ? ` to ${who}` : ""}`;
    case "call":
      return `logged a call${with_}`;
    case "meeting":
      return `logged a meeting${with_}`;
    case "stage_change": {
      const to = stageLabel(d.to);
      const from = stageLabel(d.from);
      const target = who ? `${who} ` : "";
      if (d.reason === "stage_removed") return `moved ${target}to ${to} (stage removed)`;
      return `moved ${target}${from ? `from ${from} ` : ""}to ${to}`;
    }
    case "follow_up_set": {
      const to = s(d.to);
      const note = s(d.note);
      if (!to) return `cleared the follow-up${who ? ` for ${who}` : ""}`;
      const onlyNote = s(d.from) === to && note;
      const head = onlyNote
        ? `changed the follow-up note${who ? ` for ${who}` : ""} (${formatDate(to)})`
        : `set a follow-up${who ? ` for ${who}` : ""} on ${formatDate(to)}`;
      return note ? `${head}: ${note}` : head;
    }
    case "commitment": {
      const amount = typeof d.amount === "number" ? d.amount : 0;
      const cur = s(d.currency) || currency;
      if (amount === 0) return `cleared the commitment${who ? ` from ${who}` : ""}`;
      return `recorded a ${money(amount, cur)} commitment${who ? ` from ${who}` : ""}`;
    }
    case "investor_created":
      return `added ${who || "this investor"}`;
    case "investor_updated": {
      const fields = Array.isArray(d.fields) ? (d.fields as unknown[]).map(String) : [];
      const list = fields.length ? fields.join(", ").replaceAll("_", " ") : "contact details";
      return `updated ${list}${who ? ` for ${who}` : ""}`;
    }
    case "added_to_round": {
      const st = stageLabel(d.stage);
      return `added ${who || "them"} to the round${st ? ` in ${st}` : ""}`;
    }
    case "removed_from_round":
      return `removed ${who || "them"} from the round`;
    case "participant_updated": {
      const changes = d.changes && typeof d.changes === "object" ? Object.keys(d.changes) : [];
      const list = changes.length ? changes.join(", ").replaceAll("_", " ") : "round details";
      return `changed ${list}${who ? ` for ${who}` : ""}`;
    }
    default:
      return String(a.kind).replaceAll("_", " ");
  }
}

function linkName(sentence: string, a: Activity, href?: (a: Activity) => string): ReactNode {
  const name = a.investor_name;
  const at = href && name ? sentence.indexOf(name) : -1;
  if (!href || at < 0) return sentence;
  return (
    <>
      {sentence.slice(0, at)}
      <Link href={href(a)} className="font-medium hover:underline">
        {name}
      </Link>
      {sentence.slice(at + name.length)}
    </>
  );
}

/**
 * Vertical activity list (SYSTEM 3.18): mono time column (64px), actor, action sentence and an
 * optional body (pre-wrap, 65ch), grouped under day separators. Agent items get the orchid
 * rule and a 50% agent-soft tint. `filterable` adds the All / Conversations / Stage & money /
 * Agent actions control.
 */
export function Timeline({
  items,
  timeZone,
  withInvestor,
  currency,
  filterable,
  defaultFilter = "all",
  empty = "Nothing has happened here yet.",
  renderExtra,
  investorHref,
  roundLabel,
  footer,
  now,
  className,
}: {
  items: Activity[];
  /** Workspace timezone for day groups and times. */
  timeZone?: string;
  withInvestor?: boolean;
  currency?: string;
  filterable?: boolean;
  defaultFilter?: TimelineFilter;
  empty?: ReactNode;
  /** Trailing slot per item (e.g. a "Delete" link for deletable notes). */
  renderExtra?: (a: Activity) => ReactNode;
  /** With `withInvestor`: the investor's name in the sentence links here. */
  investorHref?: (a: Activity) => string;
  /** A muted "in Pre-seed" after the sentence (investor pages with several rounds). */
  roundLabel?: (a: Activity) => string | null;
  footer?: ReactNode;
  /** Fixed "now" for stable rendering in tests and vignettes. */
  now?: Date;
  className?: string;
}) {
  const [filter, setFilter] = useState<TimelineFilter>(defaultFilter);
  const today = todayIn(timeZone, now);
  const groups = useMemo(() => {
    const out: { day: string; items: Activity[] }[] = [];
    for (const a of items.filter((x) => matchesTimelineFilter(x, filter))) {
      const day = isoDate(a.occurred_at, timeZone);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(a);
      else out.push({ day, items: [a] });
    }
    return out;
  }, [items, filter, timeZone]);

  return (
    <div className={cn("flex flex-col gap-10", className)}>
      {filterable ? (
        <Segmented
          size="sm"
          label="Filter timeline"
          value={filter}
          onChange={setFilter}
          className="self-start"
          options={[
            { value: "all", label: "All" },
            { value: "conversations", label: "Conversations" },
            { value: "stage_money", label: "Stage & money" },
            { value: "agent", label: "Agent actions" },
          ]}
        />
      ) : null}
      {groups.length === 0 ? <p className="t-body-s text-muted">{empty}</p> : null}
      {groups.map((g) => (
        <section key={g.day} aria-label={dayLabel(g.day, today)}>
          <h4 className="t-label mb-6">{dayLabel(g.day, today)}</h4>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {g.items.map((a) => {
              const agent = a.actor.type === "agent";
              return (
                <li
                  key={a.id}
                  className={cn(
                    "t-body-s grid grid-cols-[64px_minmax(0,1fr)] gap-x-8 rounded-xs py-5 pr-6",
                    agent
                      ? "bg-[color-mix(in_srgb,var(--agent-soft)_50%,transparent)] pl-6 shadow-[inset_2px_0_0_var(--agent)]"
                      : "pl-8",
                  )}
                >
                  <time
                    dateTime={a.occurred_at}
                    title={formatDateTime(a.occurred_at, timeZone)}
                    className="t-micro pt-1 text-muted"
                  >
                    {formatTime(a.occurred_at, timeZone)}
                  </time>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-6">
                      <ActorName actor={a.actor} />
                      <span className="text-fg">
                        {linkName(activitySentence(a, { withInvestor, currency }), a, withInvestor ? investorHref : undefined)}
                        {roundLabel?.(a) ? <span className="text-muted"> · in {roundLabel(a)}</span> : null}
                      </span>
                      {renderExtra ? <span className="ml-auto">{renderExtra(a)}</span> : null}
                    </p>
                    {a.body ? (
                      <p className="mt-3 max-w-[65ch] whitespace-pre-wrap text-muted">{a.body}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {footer}
    </div>
  );
}
