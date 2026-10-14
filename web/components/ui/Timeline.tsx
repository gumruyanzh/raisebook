"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { MIN_SIMILAR, SIMILAR_GAP_MS, runKeyOf, similarKeyOf, type ActivityRun, type FeedActivity } from "@/lib/api/activities";
import type { Activity, ActivityKind } from "@/lib/api/types";
import { FIT_WORD, coveredByResearch, fieldList } from "@/lib/activityWords";
import { cn } from "@/lib/cn";
import {
  dayLabel,
  formatDate,
  formatDateTime,
  formatTime,
  isoDate,
  money,
  plural,
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
      const list = fields.length ? fieldList(fields) : "contact details";
      if (d.source === "research") return `accepted research's ${list}${who ? ` for ${who}` : ""}`;
      return `updated ${list}${who ? ` for ${who}` : ""}`;
    }
    case "added_to_round": {
      const st = stageLabel(d.stage);
      return `added ${who || "them"} to the round${st ? ` in ${st}` : ""}`;
    }
    case "removed_from_round":
      return `removed ${who || "them"} from the round`;
    case "participant_updated": {
      const changes = d.changes && typeof d.changes === "object" ? (d.changes as Record<string, unknown>) : {};
      const keys = Object.keys(changes);
      const fit = changes.fit as { from?: unknown; to?: unknown } | undefined;
      if (keys.length === 1 && fit && typeof fit.to === "number") {
        const from = typeof fit.from === "number" && fit.from > 0 ? ` from ${FIT_WORD[fit.from] ?? fit.from}` : "";
        const research = d.source === "research" ? " (research's suggestion)" : "";
        return `changed fit${who ? ` for ${who}` : ""}${from} to ${FIT_WORD[fit.to] ?? fit.to}${research}`;
      }
      const list = keys.length ? fieldList(keys) : "round details";
      return `changed ${list}${who ? ` for ${who}` : ""}`;
    }
    case "research": {
      const filled = Array.isArray(d.filled) ? fieldList(d.filled as unknown[]) : "";
      const suggested = Array.isArray(d.suggested) ? d.suggested.length : 0;
      const tail = [filled ? `filled ${filled}` : "", suggested ? `suggested ${suggested === 1 ? "1 change" : `${suggested} changes`}` : ""]
        .filter(Boolean)
        .join("; ");
      const whose = who ? `${who}'s` : "the";
      if (d.event === "identity") {
        const src = s(d.source);
        const head =
          src === "existing"
            ? `confirmed ${whose} identity from the LinkedIn on file`
            : src === "user"
              ? `picked who ${who || "this"} is`
              : src === "agent"
                ? `confirmed ${whose} identity`
                : `ran research that matched ${whose} identity`;
        return `${head}${tail ? `; ${tail}` : ""}`;
      }
      const verdict = s(d.verdict);
      const word =
        verdict === "strong" ? "Strong fit" : verdict === "possible" ? "Possible fit" : verdict === "poor" ? "Poor fit" : verdict === "unrated" ? "no fit verdict yet" : "";
      return `ran research on ${who || "them"}${word ? `: ${word}` : ""}${tail ? `; ${tail}` : ""}`;
    }
    default:
      return String(a.kind).replaceAll("_", " ");
  }
}

/** One line for a whole import run or bulk change ("imported 420 investors from x.csv"). */
export function runSentence(head: Activity, run: Pick<ActivityRun, "kind" | "investors" | "size" | "filename">): string {
  const d = head.data ?? {};
  const n = plural(run.investors, "investor");
  if (run.kind === "import") {
    const file = run.filename || s(d.filename);
    return `imported ${n}${file ? ` from ${file}` : ""}`;
  }
  switch (head.kind) {
    case "stage_change": {
      const to = stageLabel(d.to);
      return to ? `moved ${n} to ${to}` : `moved ${n}`;
    }
    case "follow_up_set": {
      const to = s(d.to);
      return to ? `set follow-ups for ${n} on ${formatDate(to)}` : `cleared follow-ups for ${n}`;
    }
    case "removed_from_round":
      return `removed ${n} from the round`;
    case "added_to_round":
      return `added ${n} to the round`;
    case "participant_updated": {
      const changes = d.changes && typeof d.changes === "object" ? Object.keys(d.changes) : [];
      return changes.length ? `changed ${fieldList(changes)} for ${n}` : `changed ${n}`;
    }
    case "investor_updated": {
      const fields = Array.isArray(d.fields) ? (d.fields as unknown[]).map(String) : [];
      return fields.length ? `updated ${fieldList(fields)} for ${n}` : `updated ${n}`;
    }
    case "investor_created":
      return `added ${n}`;
    default:
      return `changed ${n}`;
  }
}

/** A row of the feed: one activity, or a run of them shown as one expandable entry. */
type Entry =
  | { type: "one"; a: Activity }
  | { type: "run"; head: Activity; run: ActivityRun; items: Activity[] | null };

/** Client-side runs of at least this many consecutive activities collapse. */
const MIN_RUN = 3;
function toEntries(items: Activity[], groupRuns: boolean): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const server = (a as FeedActivity).run;
    if (server && server.size > 1) {
      out.push({ type: "run", head: a, run: server, items: null });
      continue;
    }
    const sim = groupRuns ? similarKeyOf(a) : null;
    if (sim) {
      let j = i;
      while (
        j + 1 < items.length &&
        !(items[j + 1] as FeedActivity).run &&
        similarKeyOf(items[j + 1]!) === sim &&
        Math.abs(Date.parse(items[j]!.occurred_at) - Date.parse(items[j + 1]!.occurred_at)) <= SIMILAR_GAP_MS
      )
        j++;
      if (j - i + 1 >= MIN_SIMILAR) {
        const its = items.slice(i, j + 1);
        out.push({
          type: "run",
          head: a,
          run: { key: `similar-${a.id}`, kind: "bulk", size: its.length, investors: new Set(its.map((x) => x.investor_id)).size },
          items: its,
        });
        i = j;
        continue;
      }
    }
    const key = groupRuns ? runKeyOf(a) : null;
    if (key) {
      let j = i;
      while (j + 1 < items.length && runKeyOf(items[j + 1]!) === key && !(items[j + 1] as FeedActivity).run) j++;
      if (j - i + 1 >= MIN_RUN) {
        const its = items.slice(i, j + 1);
        out.push({
          type: "run",
          head: a,
          run: {
            key,
            kind: (a as FeedActivity).import_run_id ? "import" : "bulk",
            size: its.length,
            investors: new Set(its.map((x) => x.investor_id)).size,
          },
          items: its,
        });
        i = j;
        continue;
      }
    }
    out.push({ type: "one", a });
  }
  return out;
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
 * Agents control (it scrolls sideways on a phone rather than clip).
 *
 * Runs (UX-PASS-1 P1-11): an import or a bulk change is one expandable entry ("Sam imported
 * 420 investors from investors.csv"). The API collapses them with `collapse_runs` (pass
 * `loadRun` to expand those); with `groupRuns`, consecutive entries of one run collapse here.
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
  groupRuns,
  loadRun,
  sentenceFor,
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
  /** Collapse 3+ consecutive entries of one import or bulk change (default: on in feeds). */
  groupRuns?: boolean;
  /** Loads the entries of a run the API collapsed (`listActivities({run})`). */
  loadRun?: (key: string) => Promise<Activity[]>;
  /** Words an activity differently (an import on one investor's timeline); null keeps the default. */
  sentenceFor?: (a: Activity) => string | null;
  className?: string;
}) {
  const [filter, setFilter] = useState<TimelineFilter>(defaultFilter);
  const today = todayIn(timeZone, now);
  const groups = useMemo(() => {
    const out: { day: string; items: Activity[] }[] = [];
    for (const a of items.filter((x) => matchesTimelineFilter(x, filter) && !coveredByResearch(x))) {
      const day = isoDate(a.occurred_at, timeZone);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(a);
      else out.push({ day, items: [a] });
    }
    const group = groupRuns ?? Boolean(withInvestor);
    return out.map((g) => ({ day: g.day, entries: toEntries(g.items, group) }));
  }, [items, filter, timeZone, groupRuns, withInvestor]);

  const row = (a: Activity, nested = false) => {
    const agent = a.actor.type === "agent";
    return (
      <li
        key={a.id}
        className={cn(
          "t-body-s grid grid-cols-[64px_minmax(0,1fr)] gap-x-8 rounded-xs py-5 pr-6",
          agent
            ? "bg-[color-mix(in_srgb,var(--agent-soft)_50%,transparent)] pl-6 shadow-[inset_2px_0_0_var(--agent)]"
            : "pl-8",
          nested && "py-3",
        )}
      >
        <time dateTime={a.occurred_at} title={formatDateTime(a.occurred_at, timeZone)} className="t-micro pt-1 text-muted">
          {formatTime(a.occurred_at, timeZone)}
        </time>
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-6">
            {nested ? null : <ActorName actor={a.actor} />}
            <span className="text-fg">
              {linkName(
                (!nested && sentenceFor?.(a)) || activitySentence(a, { withInvestor: withInvestor || nested, currency }),
                a,
                withInvestor || nested ? investorHref : undefined,
              )}
              {roundLabel?.(a) ? <span className="text-muted"> · in {roundLabel(a)}</span> : null}
            </span>
            {renderExtra ? <span className="ml-auto">{renderExtra(a)}</span> : null}
          </p>
          {a.body && a.kind !== "research" ? <p className="mt-3 max-w-[65ch] whitespace-pre-wrap text-muted">{a.body}</p> : null}
        </div>
      </li>
    );
  };

  return (
    <div className={cn("flex flex-col gap-10", className)}>
      {filterable ? (
        <Segmented
          size="sm"
          label="Filter timeline"
          value={filter}
          onChange={setFilter}
          className="max-w-full self-start overflow-x-auto"
          options={[
            { value: "all", label: "All" },
            { value: "conversations", label: "Conversations" },
            { value: "stage_money", label: "Stage & money" },
            { value: "agent", label: "Agents" },
          ]}
        />
      ) : null}
      {groups.length === 0 ? <p className="t-body-s text-muted">{empty}</p> : null}
      {groups.map((g) => (
        <section key={g.day} aria-label={dayLabel(g.day, today)}>
          <h4 className="t-label mb-6">{dayLabel(g.day, today)}</h4>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {g.entries.map((e) =>
              e.type === "one" ? (
                row(e.a)
              ) : (
                <RunItem
                  key={`run-${e.run.key}-${e.head.id}`}
                  head={e.head}
                  run={e.run}
                  items={e.items}
                  loadRun={loadRun}
                  timeZone={timeZone}
                  renderRow={(a) => row(a, true)}
                />
              ),
            )}
          </ol>
        </section>
      ))}
      {footer}
    </div>
  );
}

const RUN_PAGE = 100;

/** One import run or bulk change: a single line that expands to its entries. */
function RunItem({
  head,
  run,
  items,
  loadRun,
  timeZone,
  renderRow,
}: {
  head: Activity;
  run: ActivityRun;
  items: Activity[] | null;
  loadRun?: (key: string) => Promise<Activity[]>;
  timeZone?: string;
  renderRow: (a: Activity) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Activity[] | null>(items);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [limit, setLimit] = useState(RUN_PAGE);
  const agent = head.actor.type === "agent";
  const canExpand = Boolean(items || loadRun);
  const listId = `run-${run.key}-${head.id}`;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded && loadRun) {
      setState("loading");
      try {
        setLoaded(await loadRun(run.key));
        setState("idle");
      } catch {
        setState("error");
      }
    }
  };

  return (
    <li
      className={cn(
        "t-body-s grid grid-cols-[64px_minmax(0,1fr)] gap-x-8 rounded-xs py-5 pr-6",
        agent ? "bg-[color-mix(in_srgb,var(--agent-soft)_50%,transparent)] pl-6 shadow-[inset_2px_0_0_var(--agent)]" : "pl-8",
      )}
    >
      <time dateTime={head.occurred_at} title={formatDateTime(head.occurred_at, timeZone)} className="t-micro pt-1 text-muted">
        {formatTime(head.occurred_at, timeZone)}
      </time>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-6">
          <ActorName actor={head.actor} />
          <span className="text-fg">{runSentence(head, run)}</span>
          {canExpand ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => void toggle()}
              className="link t-micro ml-auto border-0 bg-transparent p-0"
            >
              {open ? "Hide" : `Show ${plural(run.size, "entry", "entries")}`}
            </button>
          ) : null}
        </p>
        {open ? (
          <div id={listId} className="mt-4 border-l border-line pl-8">
            {state === "loading" ? <p className="t-body-s text-muted">Loading…</p> : null}
            {state === "error" ? <p className="t-body-s text-bad">These entries could not load. Try again.</p> : null}
            {loaded ? (
              <ol className="m-0 flex list-none flex-col p-0">
                {loaded.slice(0, limit).map((a) => renderRow(a))}
                {loaded.length > limit ? (
                  <li>
                    <button type="button" className="link t-body-s border-0 bg-transparent p-0 py-4" onClick={() => setLimit((l) => l + RUN_PAGE * 4)}>
                      Show {plural(Math.min(loaded.length - limit, RUN_PAGE * 4), "more entry", "more entries")}
                    </button>
                  </li>
                ) : null}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
