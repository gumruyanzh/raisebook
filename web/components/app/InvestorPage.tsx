"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  Button,
  Chip,
  PageHeader,
  ConfirmDialog,
  FitMeter,
  Input,
  Menu,
  MoneyChip,
  Pagination,
  PriorityChip,
  SectionLabel,
  Select,
  StageDot,
  Timeline,
  useToast,
} from "@/components/ui";
import { DateField } from "@/components/ui/DateField";
import { deleteActivity, listActivities } from "@/lib/api/activities";
import { errorMessage } from "@/lib/api/client";
import { deleteInvestor, getInvestor } from "@/lib/api/investors";
import {
  addParticipant,
  getParticipant,
  moveStage,
  recordCommitment,
  removeParticipant,
  sortedStages,
} from "@/lib/api/rounds";
import type { Activity, Investor, Member, Participant, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { formatDate, isoDate, plural, stageFocusLabel } from "@/lib/format";
import { visibleIndustries } from "@/lib/pipeline";
import { useSession, useWorkspace } from "@/lib/session";

import { NotesEditor } from "./InvestorSheet";
import { InvestorProfile } from "./InvestorProfile";
import { LogComposer } from "./LogComposer";
import { CommitmentDialog, useParticipantSave } from "./ParticipantFields";
import { ReachOut } from "./ReachOut";
import { DossierPanel } from "./research/DossierPanel";
import { moneyInput, parseMoney, personName } from "./util";

/** One ruled row per participation (SYSTEM §4.8 "Rounds"). */
function RoundRow({
  round,
  participant,
  investorName,
  members,
  canWrite,
  onChange,
  onRemoved,
  wsSlug,
}: {
  round: Round;
  participant: Participant;
  investorName: string;
  members: Member[];
  canWrite: boolean;
  onChange: (p: Participant) => void;
  onRemoved: () => void;
  wsSlug: string;
}) {
  const { client, workspace } = useWorkspace();
  const timeZone = workspace.timezone;
  const toast = useToast();
  const p = participant;
  const { state, error, save, run } = useParticipantSave(client, round.id, p.investor.id, onChange);
  const [soft, setSoft] = useState(moneyInput(p.amount_soft));
  const [committed, setCommitted] = useState(moneyInput(p.amount_committed));
  const [commit, setCommit] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const stages = sortedStages(round.stages);
  const won = stages.find((s) => s.kind === "won");
  const ro = !canWrite;
  const href = `/w/${encodeURIComponent(wsSlug)}/r/${encodeURIComponent(round.slug)}?investor=${p.investor.id}`;

  if (round.status === "closed") {
    // A closed round is history: one read-only line, not an editable form.
    return (
      <li className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-line py-10 first:pt-4 last:border-b-0">
        <Link href={href} className="font-semibold hover:underline">
          {round.name}
        </Link>
        <span className="inline-flex items-center gap-6 text-muted">
          <StageDot color={p.stage.color} />
          {p.stage.label}
        </span>
        <span className="t-data text-muted">fit {p.fit}/5</span>
        <PriorityChip fit={p.fit} />
        {p.amount_committed ? <MoneyChip amount={p.amount_committed} currency={round.currency} /> : null}
        <Chip tone="mode" className="ml-auto">
          Closed
        </Chip>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-10 border-b border-line py-14 first:pt-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-4">
        <Link href={href} className="font-semibold hover:underline">
          {round.name}
        </Link>
        <PriorityChip fit={p.fit} />
        {p.amount_committed ? <MoneyChip amount={p.amount_committed} currency={round.currency} /> : null}
        <span className="t-micro ml-auto text-muted" aria-live="polite">
          {state === "saving" ? "Saving…" : state === "saved" ? <span className="text-good-ink">Saved</span> : state === "error" ? <span className="text-bad">Not saved</span> : null}
        </span>
        {canWrite ? (
          <Menu
            label={`${round.name} actions`}
            align="end"
            trigger="⋯"
            triggerClassName="inline-flex size-28 items-center justify-center rounded-sm border border-transparent bg-transparent text-muted hover:border-line hover:text-fg"
            items={[
              { label: "Open in pipeline", href },
              { type: "separator" },
              {
                label: `Remove from ${round.name}`,
                danger: true,
                onSelect: async () => {
                  try {
                    await removeParticipant(client, round.id, p.investor.id);
                    toast.show(`${investorName} removed from ${round.name}.`);
                    onRemoved();
                  } catch (err) {
                    toast.show(errorMessage(err));
                  }
                },
              },
            ]}
          />
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
        <label className="flex min-w-0 flex-col gap-4">
          <span className="text-[12px] text-muted">Stage</span>
          <span className="flex items-center gap-6">
            <StageDot color={p.stage.color} />
            <Select
              aria-label={`Stage in ${round.name}`}
              value={p.stage.key}
              disabled={ro}
              onChange={(e) => {
                const key = e.target.value;
                void run(async () => (await moveStage(client, round.id, p.investor.id, key)).participant);
              }}
            >
              {stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </span>
        </label>
        <div className="flex min-w-0 flex-col gap-4">
          <span className="text-[12px] text-muted">Fit</span>
          <span className="flex h-32 items-center">
            <FitMeter editable value={p.fit} disabled={ro} label={`Fit for ${round.name}`} onChange={(fit) => void save({ fit })} />
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <span className="text-[12px] text-muted" aria-hidden>
            Follow up on
          </span>
          <DateField
            value={p.follow_up_on ?? null}
            timeZone={timeZone}
            quickPicks="followup"
            placeholder="Set follow-up"
            clearable
            disabled={ro}
            aria-label={`Follow up on, ${round.name}`}
            aria-invalid={p.follow_up_state === "overdue" ? true : undefined}
            onChange={(iso) => void save({ follow_up_on: iso })}
          />
        </div>
        <label className="flex min-w-0 flex-col gap-4">
          <span className="text-[12px] text-muted">Soft ({round.currency})</span>
          <Input
            mono
            inputMode="decimal"
            value={soft}
            disabled={ro}
            
            onChange={(e) => setSoft(e.target.value)}
            onBlur={() => {
              const v = parseMoney(soft);
              if (Number.isNaN(v)) return setSoft(moneyInput(p.amount_soft));
              if ((v ?? null) !== (p.amount_soft ?? null)) void save({ amount_soft: v });
              setSoft(moneyInput(v));
            }}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-4">
          <span className="text-[12px] text-muted">Committed ({round.currency})</span>
          <Input
            mono
            inputMode="decimal"
            value={committed}
            disabled={ro}
            onChange={(e) => setCommitted(e.target.value)}
            onBlur={() => {
              const v = parseMoney(committed);
              if (Number.isNaN(v)) return setCommitted(moneyInput(p.amount_committed));
              if ((v ?? 0) !== (p.amount_committed ?? 0)) setCommit(v ?? 0);
            }}
          />
        </label>
        {/* Solo workspaces get no owner UI (same guard as ParticipantFields). */}
        {members.length > 1 || p.owner ? (
          <label className="flex min-w-0 flex-col gap-4">
            <span className="text-[12px] text-muted">Owner</span>
            <Select value={p.owner?.user_id ?? ""} disabled={ro} onChange={(e) => void save({ owner_user_id: e.target.value || null })}>
              <option value="">No owner</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {personName(m)}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      {p.next_step || p.follow_up_note ? (
        <p className="t-body-s text-muted">
          {p.next_step ? <>Next: {p.next_step}</> : null}
          {p.next_step && p.follow_up_note ? " · " : null}
          {p.follow_up_note ? <>Follow up: {p.follow_up_note}</> : null}
        </p>
      ) : null}
      {error ? <p className="t-body-s text-bad">{error}</p> : null}
      <CommitmentDialog
        open={commit !== null}
        amount={commit ?? 0}
        currency={round.currency}
        wonLabel={won?.label ?? "Committed"}
        inWon={p.stage.kind === "won"}
        investorName={investorName}
        busy={busy}
        onCancel={() => {
          setCommit(null);
          setCommitted(moneyInput(p.amount_committed));
        }}
        onConfirm={async (move) => {
          setBusy(true);
          const r = await run(async () => (await recordCommitment(client, round.id, p.investor.id, { amount: commit ?? 0, move_to_won: move })).participant);
          setBusy(false);
          if (r) setCommit(null);
        }}
      />
    </li>
  );
}

/**
 * The investor page (SYSTEM §4.8): header, profile and notes on the left; rounds, the log
 * composer and the full timeline on the right; delete at the bottom.
 */
export function InvestorPage({
  investor: initial,
  participations: initialParts,
  rounds,
  members,
  timeline: initialTimeline,
  nextCursor: initialCursor,
  today,
}: {
  investor: Investor;
  participations: Participant[];
  rounds: Round[];
  members: Member[];
  timeline: Activity[];
  nextCursor: string | null;
  today: string;
}) {
  const { workspace, client, canWrite, isOwner } = useWorkspace();
  const session = useSession();
  const router = useRouter();
  const toast = useToast();
  const [inv, setInv] = useState(initial);
  const [parts, setParts] = useState(initialParts);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [del, setDel] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const tz = workspace.timezone;
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const roundsById = useMemo(() => Object.fromEntries(rounds.map((r) => [r.id, r])), [rounds]);
  const notIn = rounds.filter((r) => !parts.some((p) => p.round_id === r.id));
  const firstRound = parts[0] ? roundsById[parts[0].round_id] : rounds[0];
  const currency = firstRound?.currency ?? workspace.default_currency;

  const reloadTimeline = useCallback(async () => {
    try {
      const page = await listActivities(client, { investor_id: inv.id, limit: 50 });
      setTimeline(page.data);
      setCursor(page.next_cursor);
    } catch {
      /* keep the current list */
    }
  }, [client, inv.id]);

  const reloadInvestor = useCallback(async () => {
    try {
      setInv(await getInvestor(client, inv.id));
    } catch {
      /* keep */
    }
  }, [client, inv.id]);

  const onPartChange = (p: Participant) => {
    setParts((list) => list.map((x) => (x.round_id === p.round_id ? p : x)));
    void reloadTimeline();
  };

  const addTo = async (r: Round) => {
    try {
      await addParticipant(client, r.id, { investor_id: inv.id });
      const p = await getParticipant(client, r.id, inv.id);
      setParts((list) => [...list, p]);
      toast.show(`${inv.name} added to ${r.name}.`);
      void reloadTimeline();
      void reloadInvestor();
    } catch (err) {
      toast.show(errorMessage(err));
    }
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await listActivities(client, { investor_id: inv.id, limit: 50, cursor });
      setTimeline((t) => [...t, ...page.data]);
      setCursor(page.next_cursor);
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const canDeleteActivity = (a: Activity) =>
    a.deletable && canWrite && (isOwner || (a.actor.type === "user" && a.actor.user_id === session.user.id));

  const who = [inv.title, inv.firm].filter(Boolean).join(" · ");
  const entries = `${timeline.length}${cursor ? "+" : ""}`;

  return (
    <div className="flex flex-col gap-14">
      <PageHeader
        className="mb-0"
        crumbs={[{ label: "Investors", href: `${base}/investors` }]}
        title={inv.name}
        aside={who || undefined}
      />
      <div className="grid grid-cols-1 gap-24 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-24 xl:col-span-5">
          <header className="flex flex-col gap-8">
            <div className="flex flex-wrap gap-4">
              <Chip tone="type">{INVESTOR_TYPE_LABEL[inv.type]}</Chip>
              {inv.stage_focus.map((st) => (
                <Chip key={`sf-${st}`} tone="tag">
                  {stageFocusLabel(st)}
                </Chip>
              ))}
              {visibleIndustries(inv.industries).map((i) => (
                <Chip key={i} tone="industry">
                  {i}
                </Chip>
              ))}
              {inv.tags.map((t) => (
                <Chip key={t} tone="tag">
                  {t}
                </Chip>
              ))}
            </div>
            {/* The same reach-out row as Triage and the sheet (critique 4). */}
            <ReachOut
              className="mt-4"
              draft={null}
              person={{ name: inv.name, firm: inv.firm, fit: 0, email: inv.email, linkedin_url: inv.linkedin_url, website_url: inv.website_url, x_url: inv.x_url }}
            />
          </header>
          <div className="rounded-md border border-line bg-surface px-16 pt-16 pb-8">
            <InvestorProfile client={client} investor={inv} currency={currency} canWrite={canWrite} onSaved={setInv} />
          </div>
          <div className="rounded-md border border-line bg-surface p-16">
            <NotesEditor client={client} investor={inv} canWrite={canWrite} onSaved={setInv} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-24 xl:col-span-7">
          <section aria-label="Rounds" className="rounded-md border border-line bg-surface p-16">
            <SectionLabel
              aside={
                canWrite && notIn.length ? (
                  <Menu
                    label="Add to round"
                    align="end"
                    trigger={<>Add to round ▾</>}
                    triggerClassName="link t-body-s border-0 bg-transparent p-0"
                    items={notIn.map((r) => ({ label: r.name, hint: r.status === "closed" ? "Closed" : undefined, onSelect: () => void addTo(r) }))}
                  />
                ) : null
              }
            >
              Rounds
            </SectionLabel>
            {parts.length === 0 ? (
              <p className="t-body-s mt-6 text-muted">
                {inv.name} is not in any round yet. {canWrite && notIn.length ? "Add them to a round to track stage, fit and follow-ups." : null}
              </p>
            ) : (
              <ul className="m-0 mt-4 list-none p-0">
                {parts.map((p) => {
                  const r = roundsById[p.round_id];
                  if (!r) return null;
                  return (
                    <RoundRow
                      key={p.round_id}
                      round={r}
                      participant={p}
                      investorName={inv.name}
                      members={members}
                      canWrite={canWrite}
                      wsSlug={workspace.slug}
                      onChange={onPartChange}
                      onRemoved={() => {
                        setParts((list) => list.filter((x) => x.round_id !== p.round_id));
                        void reloadTimeline();
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </section>

          <section id="dossier" aria-label="Dossier" className="scroll-mt-80 rounded-md border border-line bg-surface p-16">
            <SectionLabel>Dossier</SectionLabel>
            <DossierPanel
              investorId={inv.id}
              investorName={inv.name}
              round={parts[0]?.round_id ?? null}
              client={client}
              wsSlug={workspace.slug}
              canWrite={canWrite}
              today={today}
              currency={currency}
              nested
              onChanged={() => {
                void getInvestor(client, inv.id)
                  .then(setInv)
                  .catch(() => {});
                void reloadTimeline();
                router.refresh();
              }}
            />
          </section>

          <section id="timeline" aria-label="Timeline" className="scroll-mt-80 rounded-md border border-line bg-surface p-16">
            <SectionLabel>Log</SectionLabel>
            <LogComposer
              client={client}
              investorId={inv.id}
              investorName={inv.name}
              round={parts.length === 1 ? parts[0]!.round_id : undefined}
              today={today}
              timeZone={tz}
              disabled={!canWrite}
              onLogged={(a) => setTimeline((t) => [a, ...t])}
            />
            <SectionLabel className="mt-20">Timeline</SectionLabel>
            <Timeline
              items={timeline}
              timeZone={tz}
              currency={currency}
              roundLabel={
                parts.length > 1
                  ? (a) => (a.round_id ? (roundsById[a.round_id]?.name ?? null) : null)
                  : undefined
              }
              filterable
              empty="Nothing logged yet."
              renderExtra={(a) =>
                canDeleteActivity(a) ? (
                  <button
                    type="button"
                    className="t-micro border-0 bg-transparent p-0 text-muted hover:text-bad"
                    onClick={async () => {
                      try {
                        await deleteActivity(client, a.id);
                        setTimeline((t) => t.filter((x) => x.id !== a.id));
                        toast.show("Entry deleted.");
                      } catch (err) {
                        toast.show(errorMessage(err));
                      }
                    }}
                  >
                    Delete
                  </button>
                ) : null
              }
              footer={
                cursor || timeline.length > 50 ? (
                  <Pagination shown={timeline.length} hasMore={Boolean(cursor)} onLoadMore={() => void loadMore()} loading={loadingMore} noun="entries" />
                ) : null
              }
            />
          </section>
        </div>
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-12 border-t border-line pt-16">
          <p className="t-body-s min-w-0 flex-1 text-muted">
            Added {formatDate(isoDate(inv.created_at, tz), today)} · updated {formatDate(isoDate(inv.updated_at, tz), today)}
          </p>
          <Button variant="danger-quiet" onClick={() => setDel(true)}>
            Delete investor…
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        busy={delBusy}
        error={delErr}
        title={`Delete ${inv.name}?`}
        confirmLabel="Delete investor"
        onConfirm={async () => {
          setDelBusy(true);
          setDelErr(null);
          try {
            await deleteInvestor(client, inv.id);
            toast.show(`${inv.name} was deleted.`);
            router.replace(`${base}/investors`);
            router.refresh();
          } catch (err) {
            setDelErr(errorMessage(err));
            setDelBusy(false);
          }
        }}
      >
        <p>
          This removes them from {plural(parts.length, "round")} and deletes {entries} timeline{" "}
          {timeline.length === 1 && !cursor ? "entry" : "entries"}. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}
