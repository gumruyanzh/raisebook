"use client";

import { useMemo } from "react";

import {
  AgentMarker,
  FitMeter,
  FollowUpChip,
  PriorityChip,
  StagePill,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@/components/ui";
import type { Investor, Participant, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import {
  firmText,
  followUpCellText,
  formatDate,
  isoDate,
  money,
  moneyCompact,
  relativeTime,
} from "@/lib/format";

import type { AgentMark } from "./PipelineBoard";
import { personName } from "./util";

export type TableCol =
  | "investor"
  | "firm"
  | "stage"
  | "fit"
  | "type"
  | "follow_up"
  | "soft"
  | "committed"
  | "owner"
  | "last_activity"
  | "next_step";

export const TABLE_COLS: { key: TableCol; label: string; required?: boolean; num?: boolean }[] = [
  { key: "investor", label: "Investor", required: true },
  { key: "firm", label: "Firm" },
  { key: "stage", label: "Stage" },
  { key: "fit", label: "Fit" },
  { key: "type", label: "Type" },
  { key: "follow_up", label: "Follow-up" },
  { key: "soft", label: "Soft", num: true },
  { key: "committed", label: "Committed", num: true },
  { key: "owner", label: "Owner" },
  { key: "last_activity", label: "Last activity" },
  { key: "next_step", label: "Next step" },
];

export type SortDir = "asc" | "desc";

/** Default direction when a column is first clicked: numbers and fit high-first. */
export const DEFAULT_DIR: Record<TableCol, SortDir> = {
  investor: "asc",
  firm: "asc",
  stage: "asc",
  fit: "desc",
  type: "asc",
  follow_up: "asc",
  soft: "desc",
  committed: "desc",
  owner: "asc",
  last_activity: "desc",
  next_step: "asc",
};

function sortValue(p: Participant, col: TableCol): string | number | null {
  switch (col) {
    case "investor":
      return p.investor.name.toLowerCase();
    case "firm":
      return p.investor.firm?.toLowerCase() ?? null;
    case "stage":
      return p.stage.position;
    case "fit":
      return p.fit;
    case "type":
      return INVESTOR_TYPE_LABEL[p.investor.type];
    case "follow_up":
      return p.follow_up_on ?? null;
    case "soft":
      return p.amount_soft ?? null;
    case "committed":
      return p.amount_committed ?? null;
    case "owner":
      return p.owner ? personName(p.owner).toLowerCase() : null;
    case "last_activity":
      return p.last_activity_at ?? null;
    case "next_step":
      return p.next_step?.toLowerCase() ?? null;
  }
}

export function sortParticipants(rows: Participant[], col: TableCol, dir: SortDir): Participant[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, col);
    const vb = sortValue(b, col);
    // Empty values always last.
    if (va === null && vb === null) return a.investor.name.localeCompare(b.investor.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return b.fit - a.fit || a.investor.name.localeCompare(b.investor.name);
  });
}

/**
 * The pipeline table (SYSTEM §4.2): every column sortable, rows open the sheet, numbers in
 * mono and right-aligned, compact money with the exact value in the title. Rows an agent
 * touched in the last 24 hours carry the orchid rule.
 */
export function PipelineTable({
  round,
  rows,
  investors: _investors,
  agentMarks,
  visible,
  sort,
  dir,
  onSort,
  onOpen,
  selectedId,
  today,
  timeZone,
}: {
  round: Round;
  rows: Participant[];
  investors: Record<string, Investor>;
  agentMarks: Record<string, AgentMark>;
  visible: Set<TableCol>;
  sort: TableCol;
  dir: SortDir;
  onSort: (col: TableCol) => void;
  onOpen: (investorId: string) => void;
  selectedId?: string | null;
  today: string;
  timeZone: string;
}) {
  const sorted = useMemo(() => sortParticipants(rows, sort, dir), [rows, sort, dir]);
  const cols = TABLE_COLS.filter((c) => c.required || visible.has(c.key));
  const cur = round.currency;
  const now = new Date();
  const minWidth = Math.max(640, cols.length * 108);

  return (
    <>
    {/* Phones: a stacked list (who on the left; stage and follow-up on the right), never a
        sideways-scrolling grid. */}
    <ul className="m-0 flex list-none flex-col rounded-md border border-line bg-surface p-0 sm:hidden">
      {sorted.map((p) => {
        const id = p.investor.id;
        const mark = agentMarks[id];
        const who = [p.investor.title, firmText(p.investor.firm, p.investor.type)].filter((x) => x && x !== "—").join(" · ");
        return (
          <li key={id} className={cn("border-b border-line last:border-b-0", mark && "border-l-2 border-l-agent")}>
            <button
              type="button"
              onClick={() => onOpen(id)}
              aria-current={selectedId === id || undefined}
              className="flex w-full items-start gap-10 border-0 bg-transparent px-12 py-10 text-left hover:bg-sunk"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="flex items-center gap-6 font-semibold">
                  <span className="truncate">{p.investor.name}</span>
                  {mark ? <AgentMarker label={mark.tip} /> : null}
                </span>
                {who ? <span className="t-body-s truncate text-muted">{who}</span> : null}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-4">
                <StagePill color={p.stage.color} label={p.stage.label} />
                <FollowUpChip on={p.follow_up_on} state={p.follow_up_state} today={today} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
    <TableScroll maxHeight="78vh" className="max-sm:hidden">
      <Table minWidth={minWidth}>
        <THead>
          <Tr>
            {cols.map((c) => (
              <Th
                key={c.key}
                align={c.num ? "right" : "left"}
                sort={sort === c.key ? dir : null}
                onSort={() => onSort(c.key)}
              >
                {c.label}
              </Th>
            ))}
          </Tr>
        </THead>
        <TBody>
          {sorted.map((p) => {
            const id = p.investor.id;
            const mark = agentMarks[id];
            return (
              <Tr
                key={id}
                onActivate={() => onOpen(id)}
                selected={selectedId === id}
                agent={Boolean(mark)}
                aria-label={p.investor.name}
              >
                {cols.map((c) => {
                  switch (c.key) {
                    case "investor":
                      return (
                        <Td key={c.key} className="min-w-[180px]">
                          <span className="flex items-center gap-6 font-semibold">
                            {p.investor.name}
                            {mark ? <AgentMarker label={mark.tip} /> : null}
                          </span>
                          {p.investor.title ? (
                            <span className="t-body-s block text-muted">{p.investor.title}</span>
                          ) : null}
                        </Td>
                      );
                    case "firm":
                      return (
                        <Td key={c.key} className={p.investor.firm ? undefined : "text-muted"}>
                          {firmText(p.investor.firm, p.investor.type)}
                        </Td>
                      );
                    case "stage":
                      return (
                        <Td key={c.key}>
                          <StagePill color={p.stage.color} label={p.stage.label} />
                        </Td>
                      );
                    case "fit":
                      return (
                        <Td key={c.key} className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-6">
                            <PriorityChip fit={p.fit} />
                            <FitMeter value={p.fit} />
                          </span>
                        </Td>
                      );
                    case "type":
                      return (
                        <Td key={c.key} variant="muted" className="whitespace-nowrap">
                          {INVESTOR_TYPE_LABEL[p.investor.type]}
                        </Td>
                      );
                    case "follow_up": {
                      const st = p.follow_up_state;
                      return (
                        <Td
                          key={c.key}
                          className={cn(
                            "t-data whitespace-nowrap",
                            st === "overdue" || st === "today" ? "text-bad" : st === "soon" ? "text-warm-ink" : "text-muted",
                          )}
                          title={p.follow_up_note ?? undefined}
                        >
                          {p.follow_up_on ? followUpCellText(p.follow_up_on, today) : ""}
                        </Td>
                      );
                    }
                    case "soft":
                      return (
                        <Td key={c.key} variant="num" title={p.amount_soft ? money(p.amount_soft, cur) : undefined}>
                          {p.amount_soft ? moneyCompact(p.amount_soft, cur) : ""}
                        </Td>
                      );
                    case "committed":
                      return (
                        <Td
                          key={c.key}
                          variant="num"
                          className={p.amount_committed ? "text-good-ink" : undefined}
                          title={p.amount_committed ? money(p.amount_committed, cur) : undefined}
                        >
                          {p.amount_committed ? moneyCompact(p.amount_committed, cur) : ""}
                        </Td>
                      );
                    case "owner":
                      return (
                        <Td key={c.key} className="whitespace-nowrap">
                          {p.owner ? personName(p.owner) : ""}
                        </Td>
                      );
                    case "last_activity":
                      return (
                        <Td
                          key={c.key}
                          className="t-data whitespace-nowrap text-muted"
                          title={p.last_activity_at ? relativeTime(p.last_activity_at, now, timeZone) : undefined}
                        >
                          {p.last_activity_at ? formatDate(isoDate(p.last_activity_at, timeZone), today) : ""}
                        </Td>
                      );
                    case "next_step":
                      return (
                        <Td key={c.key} variant="muted" className="max-w-[280px] min-w-[160px]">
                          <span className="line-clamp-2">{p.next_step ?? ""}</span>
                        </Td>
                      );
                  }
                })}
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </TableScroll>
    </>
  );
}
