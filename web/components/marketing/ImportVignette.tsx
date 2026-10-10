"use client";

import { Chip, Table, TableScroll, TBody, Td, Th, THead, Tr } from "@/components/ui";
import { num } from "@/lib/format";

import { IMPORT_COUNTS, MAPPING } from "./sample";

/** The import "Columns" step (SYSTEM §4.10) as a static table, plus the review counts strip. */
export function ImportVignette() {
  return (
    <div className="flex min-w-0 flex-col gap-10">
      <p className="t-micro text-muted">
        <span>1 Source</span>
        <span aria-hidden className="px-6">·</span>
        <span className="text-fg">2 Columns</span>
        <span aria-hidden className="px-6">·</span>
        <span>3 Review</span>
      </p>
      <TableScroll>
        <Table minWidth={460}>
          <caption className="sr-only">
            Example column mapping from a spreadsheet to Raisebook fields
          </caption>
          <THead>
            <Tr>
              <Th>Your column</Th>
              <Th>Sample</Th>
              <Th aria-label="maps to" className="w-28 px-0" />
              <Th>Raisebook field</Th>
            </Tr>
          </THead>
          <TBody>
            {MAPPING.map((m) => (
              <Tr key={m.header}>
                <Td className="font-medium">{m.header}</Td>
                <Td className="t-data max-w-[180px] truncate text-muted">{m.sample}</Td>
                <Td className="t-data px-0 text-muted" aria-hidden>
                  →
                </Td>
                <Td>
                  <span className="t-data">{m.field}</span>
                  {m.round ? (
                    <Chip tone="tag" className="ml-6">
                      round
                    </Chip>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </TableScroll>
      <p className="t-micro flex flex-wrap gap-x-10 gap-y-2 text-muted">
        {IMPORT_COUNTS.map((c, i) => (
          <span key={c.label}>
            {i > 0 ? (
              <span aria-hidden className="mr-10">
                ·
              </span>
            ) : null}
            {c.label}{" "}
            <b className={c.label === "Errors" ? "font-medium text-bad" : "font-medium text-fg"}>
              {num(c.n)}
            </b>
          </span>
        ))}
      </p>
    </div>
  );
}
