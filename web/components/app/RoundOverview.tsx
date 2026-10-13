"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  ActorName,
  DefList,
  Ledger,
  ledgerFromSummary,
  SectionLabel,
  StagePill,
  Timeline,
  useToast,
} from "@/components/ui";
import { listActivities } from "@/lib/api/activities";
import { errorMessage } from "@/lib/api/client";
import { getRoundSummary, type FollowUpList } from "@/lib/api/rounds";
import type { Activity, Round, RoundSummary } from "@/lib/api/types";
import { INSTRUMENT_LABEL, ROUND_STATUS_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, money, num, plural, relativeTime } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { TodayQueue } from "./TodayQueue";

function Panel({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-md border border-line bg-surface p-14", className)} aria-label={title}>
      <SectionLabel aside={aside}>{title}</SectionLabel>
      <div className="mt-8">{children}</div>
    </section>
  );
}

interface AgentRow {
  label: string;
  model?: string | null;
  count: number;
  last: string;
}

function agentRows(acts: Activity[]): AgentRow[] {
  const m = new Map<string, AgentRow>();
  for (const a of acts) {
    if (a.actor.type !== "agent") continue;
    const r = m.get(a.actor.label);
    if (r) {
      r.count += 1;
      if (a.occurred_at > r.last) r.last = a.occurred_at;
    } else m.set(a.actor.label, { label: a.actor.label, model: a.actor.agent_model, count: 1, last: a.occurred_at });
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/**
 * Round overview (SYSTEM §4.5, UX-PASS-1 P1-8 / P2-10): the ledger, then the work. The Today
 * queue (every due follow-up, worked from the keyboard) and the activity feed on the left;
 * round terms, going quiet and agents on the right. On phones the queue comes first. Data
 * warnings are links to the investors they are about.
 */
export function RoundOverview({
  round,
  summary: initialSummary,
  activity,
  followUps,
  agentActivity,
  today,
}: {
  round: Round;
  summary: RoundSummary;
  activity: Activity[];
  followUps: FollowUpList;
  agentActivity: Activity[];
  today: string;
}) {
  const { workspace, client, canWrite } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [summary, setSummary] = useState(initialSummary);
  const [feed, setFeed] = useState(activity);
  const tz = workspace.timezone;
  const pipeline = `/w/${encodeURIComponent(workspace.slug)}/r/${encodeURIComponent(round.slug)}`;
  const cur = summary.money.currency;

  // After a queue write: refresh the ledger numbers and the feed quietly.
  const reload = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([getRoundSummary(client, round.id), listActivities(client, { round: round.id, limit: 30 })]);
      setSummary(s);
      setFeed(a.data);
    } catch (err) {
      toast.show(errorMessage(err));
    }
  }, [client, round.id, toast]);

  const closed = round.status === "closed";
  const agents = useMemo(() => agentRows(agentActivity), [agentActivity]);
  const daysLeft = summary.round.days_to_close;
  const ledger = ledgerFromSummary(summary);
  const won = round.stages.find((s) => s.kind === "won");

  // Overdue lives in the queue and quiet conversations in Going quiet; the rest are links.
  const notes = summary.warnings
    .filter((w) => !/overdue|no activity/i.test(w))
    .map((w) => {
      if (/without an amount/i.test(w) && won) return { text: w, href: `${pipeline}?view=table&stage=${encodeURIComponent(won.key)}` };
      if (/target close date/i.test(w) && canWrite) return { text: w, href: `${pipeline}/settings` };
      return { text: w, href: null };
    });
  const hasProbabilities = summary.money.weighted_pipeline > 0 || summary.money.soft_circled === 0;
  const workRow = notes.length ? 3 : 2;

  return (
    // Phones: the queue first, then the ledger. From 1024px: the ledger across the top, the
    // queue and feed in 8 columns, the details in 4 (explicit grid rows, so no gaps).
    <div className="flex flex-col gap-14 xl:grid xl:grid-cols-12 xl:items-start">
      <Ledger
        {...ledger}
        variant="full"
        today={today}
        hasProbabilities={hasProbabilities}
        className="order-2 xl:order-none xl:col-span-12"
        onStageSelect={(key) => router.push(`${pipeline}?stage=${encodeURIComponent(key)}`)}
        onDueSelect={(id) => router.push(`${pipeline}?investor=${id}`)}
        onDueFilter={() => router.push(`${pipeline}?view=table&follow=due&sort=follow_up`)}
      />

      {notes.length ? (
        <ul className="order-3 m-0 -mt-4 flex list-none flex-wrap gap-x-14 gap-y-2 p-0 xl:order-none xl:col-span-12" aria-label="Data to check">
          {notes.map((n) => (
            <li key={n.text} className="t-body-s text-muted">
              {n.href ? (
                <Link href={n.href} className="link">
                  {n.text.replace(/\.$/, "")} →
                </Link>
              ) : (
                n.text
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {closed ? null : (
        <TodayQueue
              round={round}
              initial={followUps}
              today={today}
              client={client}
              canWrite={canWrite}
              pipelineHref={pipeline}
          timeZone={tz}
          onChanged={() => void reload()}
          className="order-1 min-w-0 xl:order-none xl:col-span-8"
          style={{ gridRow: workRow }}
        />
      )}

      <section
        aria-label="Recent activity"
        className="order-4 min-w-0 rounded-md border border-line bg-surface p-14 xl:order-none xl:col-span-8"
        style={{ gridRow: closed ? workRow : workRow + 1 }}
      >
            <SectionLabel aside={<span className="t-micro text-muted">Last {num(feed.length)}</span>}>Recent activity</SectionLabel>
            <Timeline
              className="mt-8"
              items={feed}
              timeZone={tz}
              currency={cur}
              withInvestor
              investorHref={(a) => `${pipeline}?investor=${a.investor_id}`}
              filterable
              empty="Nothing has happened in this round yet."
            />
      </section>

      <aside
        className="order-5 flex min-w-0 flex-col gap-14 xl:order-none xl:col-span-4 xl:col-start-9"
        style={{ gridRow: `${workRow} / span ${closed ? 1 : 2}` }}
        aria-label="Round details"
      >
          <Panel
            title="Round terms"
            aside={
              canWrite ? (
                <Link href={`${pipeline}/settings`} className="link t-body-s">
                  Edit round
                </Link>
              ) : null
            }
          >
            <DefList
              items={[
                { term: "Instrument", value: INSTRUMENT_LABEL[round.instrument] },
                { term: "Target", value: <span className="tnum">{money(round.target_amount, round.currency)}</span> },
                {
                  term: round.valuation_cap ? "Valuation cap" : "Pre-money",
                  value: round.valuation_cap ? (
                    <span className="tnum">{money(round.valuation_cap, round.currency)}</span>
                  ) : round.pre_money_valuation ? (
                    <span className="tnum">{money(round.pre_money_valuation, round.currency)}</span>
                  ) : null,
                },
                {
                  term: "Target close",
                  value: round.target_close_on ? (
                    <span>
                      {formatDate(round.target_close_on, today)}
                      {daysLeft !== undefined && daysLeft !== null ? (
                        <span className="t-micro ml-6 text-muted">
                          {daysLeft >= 0 ? `${plural(daysLeft, "day")} left` : `${plural(-daysLeft, "day")} past`}
                        </span>
                      ) : null}
                    </span>
                  ) : null,
                },
                { term: "Status", value: ROUND_STATUS_LABEL[round.status] },
                { term: "Currency", value: <span className="font-mono text-sm">{round.currency}</span> },
              ]}
            />
          </Panel>

          {closed ? null : (
            <Panel
              title="Going quiet"
              aside={
                <span className="t-micro text-muted">
                  {summary.stale.length ? `${num(summary.stale.length)} · ` : ""}no activity in 14+ days
                </span>
              }
            >
              {summary.stale.length === 0 ? (
                <p className="t-body-s text-muted">Every active conversation has moved in the last two weeks.</p>
              ) : (
                <ul className="m-0 flex max-h-[360px] list-none flex-col overflow-y-auto p-0">
                  {summary.stale.map((s) => (
                    <li key={s.investor.id} className="flex items-baseline gap-6 border-b border-line py-6 last:border-b-0">
                      <Link href={`${pipeline}?investor=${s.investor.id}`} className="min-w-0 truncate font-medium hover:underline">
                        {s.investor.name}
                      </Link>
                      <StagePill color={s.stage.color} label={s.stage.label} className="shrink-0 text-muted" />
                      <span className="t-micro ml-auto whitespace-nowrap text-muted">{num(s.days_since_activity)}d</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          <Panel title="Agents" aside={<span className="t-micro text-muted">Last 7 days</span>}>
            {agents.length === 0 ? (
              <div className="flex flex-col gap-8">
                <p className="t-body-s text-muted">No agent has worked this round this week.</p>
                <Link href={`/w/${encodeURIComponent(workspace.slug)}/settings/mcp`} className="link t-body-s">
                  Connect an agent →
                </Link>
              </div>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {agents.map((a) => (
                  <li key={a.label} className="flex flex-col gap-2 border-b border-line py-8 last:border-b-0">
                    <ActorName actor={{ type: "agent", label: a.label, agent_model: a.model }} />
                    <span className="t-micro text-muted">
                      {plural(a.count, "action")} this week · last {relativeTime(a.last, new Date(), tz)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
      </aside>
    </div>
  );
}
