import { num } from "@/lib/format";

import { Button } from "./Button";

/** Cursor pagination: "Load more" at the end of a table plus a mono "200 of 1,240" (SYSTEM 3.26). */
export function Pagination({
  shown,
  total,
  hasMore,
  onLoadMore,
  loading,
  noun = "",
}: {
  shown: number;
  total?: number;
  hasMore: boolean;
  onLoadMore?: () => void;
  loading?: boolean;
  noun?: string;
}) {
  return (
    <div className="mt-10 flex flex-wrap items-center gap-12">
      <span className="t-micro text-muted">
        {num(shown)}
        {total !== undefined ? ` of ${num(total)}` : ""}
        {noun ? ` ${noun}` : ""}
      </span>
      {hasMore ? (
        <Button size="sm" onClick={onLoadMore} busy={loading ? "Loading…" : false}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
