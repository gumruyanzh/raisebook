"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  ActorName,
  Button,
  DefList,
  Ledger,
  ledgerFromSummary,
  SectionLabel,
  StageDot,
  StagePill,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Timeline,
  Tr,
  useToast,
} from "@/components/ui";
import { listActivities } from "@/lib/api/activities";
import { errorMessage } from "@/lib/api/client";
import { getRoundSummary, listFollowUps, setFollowUp, type FollowUpList } from "@/lib/api/rounds";
import type { Activity, FollowUpItem, Round, RoundSummary } from "@/lib/api/types";
import { INSTRUMENT_LABEL, ROUND_STATUS_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, money, moneyCompact, num, pct, plural, relativeTime } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

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
 * Round overview (SYSTEM §4.5): the full ledger, the funnel table and recent activity on the
 * left; follow-ups, round terms, quiet conversations and agent activity on the right.
 */
export function RoundOverview({
  round,
  summary: initialSummary,
  activity,
  followUps: initialFollowUps,
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
  const [followUps, setFollowUps] = useState(initialFollowUps);
  const [feed, setFeed] = useState(activity);
  const [busy, setBusy] = useState<string | null>(null);
  const tz = workspace.timezone;
  const pipeline = `/w/${encodeURIComponent(workspace.slug)}/r/${encodeURIComponent(round.slug)}`;
  const cur = summary.money.currency;

  const reload = useCallback(async () => {
    try {
      const [s, f, a] = await Promise.all([
        getRoundSummary(client, round.id),
        listFollowUps(client, { round: round.id, within_days: 7, include_overdue: true, limit: 100 }),
        listActivities(client, { round: round.id, limit: 30 }),
      ]);
      setSummary(s);
      setFollowUps(f);
      setFeed(a.data);
    } catch (err) {
      toast.show(errorMessage(err));
    }
  }, [client, round.id, toast]);

  const closed = round.status === "closed";
  const followUpAction = async (f: FollowUpItem, action: "done" | "snooze") => {
    setBusy(f.investor.id);
    try {
      await setFollowUp(client, round.id, f.investor.id, action === "done" ? { clear: true } : { in_days: 7 });
      toast.show(
        action === "done"
          ? `Follow-up with ${f.investor.name} marked done.`
          : `Follow-up with ${f.investor.name} moved to a week from today.`,
      );
      await reload();
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // "Reached": the share of active (not passed) investors who got at least this far, so the
  // first stage is 100% and Passed never dilutes the funnel.
  const funnelRows = useMemo(() => {
    const nonLost = summary.funnel.filter((f) => f.kind !== "lost");
    const total = nonLost.reduce((s, x) => s + x.count, 0);
    return summary.funnel.map((f) => {
      const reached =
        f.kind === "lost" || total === 0
          ? null
          : nonLost.filter((x) => x.position >= f.position).reduce((s, x) => s + x.count, 0) / total;
      return { ...f, reached };
    });
  }, [summary]);

  const groups = useMemo(() => {
    const items = followUps.data;
    return [
      { key: "overdue", title: "Overdue", items: items.filter((i) => i.follow_up_state === "overdue") },
      { key: "today", title: "Today", items: items.filter((i) => i.follow_up_state === "today") },
      { key: "soon", title: "Next 7 days", items: items.filter((i) => i.follow_up_state === "soon") },
    ];
  }, [followUps]);

  const agents = useMemo(() => agentRows(agentActivity), [agentActivity]);
  const daysLeft = summary.round.days_to_close;
  const ledger = ledgerFromSummary(summary);
  // Overdue lives in the ledger and Follow-ups, quiet conversations in Going quiet: only the
  // rest (an amount missing in Committed, a passed target date) is said here, once, quietly.
  const notes = summary.warnings.filter((w) => !/overdue|no activity/i.test(w));
  const hasProbabilities = summary.money.weighted_pipeline > 0 || summary.money.soft_circled === 0;

  return (
    <div className="grid grid-cols-1 gap-14 xl:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-14 xl:col-span-8">
        <Ledger
          {...ledger}
          variant="full"
          today={today}
          hasProbabilities={hasProbabilities}
          onStageSelect={(key) => router.push(`${pipeline}?stage=${encodeURIComponent(key)}`)}
          onDueSelect={(id) => router.push(`${pipeline}?investor=${id}`)}
          onDueFilter={() => router.push(`${pipeline}?view=table&follow=due&sort=follow_up`)}
        />

        {notes.length ? <p className="t-body-s -mt-4 text-muted">{notes.join(" ")}</p> : null}

        <section aria-label="Funnel">
          <SectionLabel>Funnel</SectionLabel>
          <TableScroll>
            <Table minWidth={560}>
              <THead>
                <Tr>
                  <Th>Stage</Th>
                  <Th align="right">Investors</Th>
                  <Th align="right">Soft</Th>
                  <Th align="right">Committed</Th>
                  {closed ? null : (
                    <Th align="right">
                      <span title="Share of active investors who got at least this far">Reached</span>
                    </Th>
                  )}
                </Tr>
              </THead>
              <TBody>
                {funnelRows.map((f) => (
                  <Tr key={f.key} onActivate={() => router.push(`${pipeline}?stage=${encodeURIComponent(f.key)}`)}>
                    <Td>
                      <StagePill color={f.color} label={f.label} />
                    </Td>
                    <Td variant="num">{num(f.count)}</Td>
                    <Td variant="num" title={f.amount_soft ? money(f.amount_soft, cur) : undefined}>
                      {f.amount_soft ? moneyCompact(f.amount_soft, cur) : ""}
                    </Td>
                    <Td variant="num" className={f.amount_committed ? "text-good-ink" : undefined} title={f.amount_committed ? money(f.amount_committed, cur) : undefined}>
                      {f.amount_committed ? moneyCompact(f.amount_committed, cur) : ""}
                    </Td>
                    {closed ? null : (
                      <Td variant="num" className="text-muted">
                        {f.reached === null ? "" : pct(Math.round(f.reached * 100))}
                      </Td>
                    )}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        </section>

        <section aria-label="Recent activity" className="rounded-md border border-line bg-surface p-14">
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
      </div>

      <aside className="flex min-w-0 flex-col gap-14 xl:col-span-4" aria-label="Round details">
        {closed ? null : (
        <Panel
          title="Follow-ups"
          aside={
            <span className="t-micro text-muted">
              {num(followUps.counts.overdue)} overdue · {num(followUps.counts.today)} today
            </span>
          }
        >
          {followUps.data.length === 0 ? (
            <p className="t-body-s text-muted">Nothing due in the next 7 days. Set dates on investor files to see them here.</p>
          ) : (
            <div className="flex flex-col gap-12">
              {groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <div key={g.key}>
                    <h3 className={cn("t-label mb-4", g.key !== "soon" && "text-bad")}>
                      {g.title} · {num(g.items.length)}
                    </h3>
                    <ul className="m-0 flex list-none flex-col p-0">
                      {g.items.slice(0, 6).map((f) => (
                        <li key={f.investor.id} className="flex flex-col gap-2 border-b border-line py-7 last:border-b-0">
                          <div className="flex min-w-0 items-baseline gap-6">
                            <StageDot color={f.stage.color} className="self-center" />
                            <Link href={`${pipeline}?investor=${f.investor.id}`} className="min-w-0 truncate font-semibold hover:underline">
                              {f.investor.name}
                            </Link>
                            {f.investor.firm ? <span className="t-body-s min-w-0 truncate text-muted">{f.investor.firm}</span> : null}
                            <span className={cn("t-micro ml-auto whitespace-nowrap", g.key === "soon" ? "text-muted" : "text-bad")}>
                              {g.key === "overdue"
                                ? `${plural(f.days_overdue, "day")} late`
                                : g.key === "today"
                                  ? "Today"
                                  : formatDate(f.follow_up_on, today)}
                            </span>
                          </div>
                          <div className="flex min-w-0 items-center gap-8 pl-15">
                            <p className="t-body-s min-w-0 flex-1 truncate text-muted" title={f.follow_up_note || f.next_step || undefined}>
                              {f.follow_up_note || f.next_step || ""}
                            </p>
                            {canWrite ? (
                              <span className="flex shrink-0 items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy === f.investor.id}
                                  onClick={() => void followUpAction(f, "done")}
                                  title="Clear this follow-up"
                                >
                                  Done
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy === f.investor.id}
                                  onClick={() => void followUpAction(f, "snooze")}
                                  title="Follow up a week from today instead"
                                >
                                  Snooze 7d
                                </Button>
                              </span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                      {g.items.length > 6 ? (
                        <li className="pt-6">
                          <Link href={`${pipeline}?view=table&follow=${g.key === "soon" ? "week" : "due"}&sort=follow_up`} className="link t-body-s">
                            {num(g.items.length - 6)} more →
                          </Link>
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </Panel>
        )}

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
                value: round.valuation_cap
                  ? <span className="tnum">{money(round.valuation_cap, round.currency)}</span>
                  : round.pre_money_valuation
                    ? <span className="tnum">{money(round.pre_money_valuation, round.currency)}</span>
                    : null,
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
            <ul className="m-0 flex list-none flex-col p-0">
              {summary.stale.map((s) => (
                <li key={s.investor.id} className="flex items-baseline gap-6 border-b border-line py-6 last:border-b-0">
                  <Link href={`${pipeline}?investor=${s.investor.id}`} className="min-w-0 truncate font-medium hover:underline">
                    {s.investor.name}
                  </Link>
                  <StagePill color={s.stage.color} label={s.stage.label} className="text-muted" />
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
