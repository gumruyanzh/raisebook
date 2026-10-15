"use client";

import { useState } from "react";

import {
  BoardCard,
  Chip,
  FitMeter,
  FollowUpChip,
  MoneyChip,
  PriorityChip,
  StagePill,
  StageSelector,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Timeline,
  Tr,
} from "@/components/ui";
import { formatDate } from "@/lib/format";

import {
  AGENT_TIMELINE,
  CURRENCY,
  HERO_COLUMNS,
  NOW_ISO,
  STAGES,
  TABLE_ROWS,
  TODAY,
  TZ,
} from "./sample";

const NOW = new Date(NOW_ISO);

/** The three agent actions from the transcript, as the founder sees them on Dana's timeline. */
export function AgentTimeline() {
  return (
    <div className="rounded-md border border-line bg-surface p-14">
      <p className="t-label mb-10">Timeline · Dana Whitfield</p>
      <Timeline items={AGENT_TIMELINE} timeZone={TZ} now={NOW} currency={CURRENCY} dayHeading="h3" />
    </div>
  );
}

const dana = HERO_COLUMNS.find((c) => c.key === "dd")!.cards[0]!;

/** One real board card, live: hover it, focus it. */
export function CardVignette() {
  return (
    <div className="rounded-md bg-sunk p-10" style={{ borderTop: "3px solid var(--stage-orange)" }}>
      <p className="mb-8 flex items-center gap-8 px-2 text-13 font-semibold">
        <span aria-hidden className="inline-block size-9 rounded-pill bg-stage-orange" />
        Diligence
        <span className="ml-auto font-mono text-[12px] font-normal text-muted">2</span>
      </p>
      <BoardCard
        name={dana.name}
        title={dana.title}
        firm={dana.firm}
        fit={dana.fit}
        typeLabel={dana.type}
        industry={dana.industry}
        extraTagCount={dana.extraTags}
        followUpOn={dana.followUpOn}
        followUpState={dana.followUpState}
        today={TODAY}
        nextStep={dana.nextStep}
        agentMark={dana.agentTip ? { tip: dana.agentTip } : null}
      />
    </div>
  );
}

/** Three rows of the pipeline table. */
export function TableVignette() {
  return (
    <TableScroll>
      <Table>
        <THead>
          <Tr>
            <Th>Investor</Th>
            <Th>Stage · fit</Th>
          </Tr>
        </THead>
        <TBody>
          {TABLE_ROWS.map((r) => (
            <Tr key={r.name}>
              <Td className="w-[56%] max-w-0">
                <span className="block truncate font-semibold">{r.name}</span>
                <span className="t-body-s block truncate text-muted">{r.firm}</span>
                {r.followUp?.state === "overdue" ? (
                  <FollowUpChip on={r.followUp.on} state="overdue" today={TODAY} className="mt-4" />
                ) : null}
              </Td>
              <Td>
                <StagePill color={r.stage.color} label={r.stage.label} />
                <span className="mt-4 flex flex-wrap items-center gap-6">
                  <FitMeter value={r.fit} />
                  {r.committed ? <MoneyChip amount={r.committed} currency={CURRENCY} /> : null}
                </span>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </TableScroll>
  );
}

/** The investor sheet's header and stage selector. The stage buttons work, locally. */
export function SheetVignette() {
  const [stage, setStage] = useState("dd");
  const stages = STAGES.map(({ key, label, color }) => ({ key, label, color }));
  return (
    <div className="rounded-md border border-line bg-surface p-14">
      <p className="t-display-s">{dana.name}</p>
      <p className="mt-2 text-muted">
        {dana.title} · {dana.firm}
      </p>
      <div className="mt-8 flex flex-wrap gap-4">
        <PriorityChip fit={dana.fit} showFit />
        <Chip tone="type">{dana.type}</Chip>
        <Chip tone="industry">{dana.industry}</Chip>
        <FollowUpChip on={dana.followUpOn} state={dana.followUpState} today={TODAY} />
      </div>
      <p className="t-label mt-16 mb-8">Stage for Seed</p>
      <StageSelector stages={stages} value={stage} onSelect={setStage} label="Stage for Seed" />
      <p className="t-micro mt-10 text-muted" aria-live="polite">
        {stage === "dd"
          ? `Follow up ${formatDate(dana.followUpOn, TODAY)}: send the data room link.`
          : `Dana Whitfield moved to ${stages.find((s) => s.key === stage)?.label}. (Example only, nothing is saved.)`}
      </p>
    </div>
  );
}
