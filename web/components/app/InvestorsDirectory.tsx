"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  Button,
  ButtonLink,
  Checkbox,
  EmptyState,
  Loading,
  Menu,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StageDot,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { listInvestors, type InvestorQuery, type InvestorSort } from "@/lib/api/investors";
import { bulkAddParticipants } from "@/lib/api/rounds";
import type { Investor, InvestorType, Page, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { formatDate, isoDate, num, plural, stageFocusLabel, firmText } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { AddInvestorDialog } from "./AddInvestorDialog";
import { checkSize } from "./InvestorSheet";
import { downloadText, toCsv } from "./util";

const SORTABLE: Record<string, InvestorSort> = { name: "name", firm: "firm", updated: "updated" };

/**
 * The investors directory (SYSTEM §4.7): every contact once, with their stage in each round.
 * Filters and sort live in the URL and run on the API; selection drives the bulk bar.
 */
export function InvestorsDirectory({
  initial,
  rounds,
  today,
  totalAll,
}: {
  initial: Page<Investor> & { total: number };
  rounds: Round[];
  today: string;
  /** Total contacts in the workspace (unfiltered), for the subline. */
  totalAll: number;
}) {
  const { workspace, client, canWrite } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(workspace.slug)}`;

  const get = (k: string) => params.get(k) ?? "";
  const q = get("q");
  const type = get("type");
  const tag = get("tag");
  const industry = get("industry");
  const roundFilter = get("round"); // "in:<slug>" | "out:<slug>"
  const sort = (get("sort") || "name") as InvestorSort;
  const order = (get("order") || (sort === "updated" ? "desc" : "asc")) as "asc" | "desc";

  const [rows, setRows] = useState(initial.data);
  const [cursor, setCursor] = useState(initial.next_cursor);
  const [total, setTotal] = useState(initial.total);
  const [loading, startTransition] = useTransition();
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [qText, setQText] = useState(q);

  // The server page re-renders with the new URL; take its first page.
  useEffect(() => {
    setRows(initial.data);
    setCursor(initial.next_cursor);
    setTotal(initial.total);
    setSelected(new Set());
  }, [initial]);

  const query = useMemo<InvestorQuery>(() => {
    const qy: InvestorQuery = { q: q || undefined, type: type || undefined, tag: tag || undefined, industry: industry || undefined, sort, order, limit: 200 };
    if (roundFilter.startsWith("in:")) qy.round = roundFilter.slice(3);
    if (roundFilter.startsWith("out:")) qy.not_in_round = roundFilter.slice(4);
    return qy;
  }, [q, type, tag, industry, roundFilter, sort, order]);

  const fetchPage = useCallback(() => startTransition(() => router.refresh()), [router]);

  useEffect(() => setQText(q), [q]);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (!v) sp.delete(k);
        else sp.set(k, v);
      }
      const s = sp.toString();
      startTransition(() => router.replace(s ? `${pathname}?${s}` : (pathname ?? ""), { scroll: false }));
    },
    [params, pathname, router],
  );

  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setQText(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setParams({ q: v.trim() || null }), 300);
  };

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await listInvestors(client, { ...query, cursor });
      setRows((r) => [...r, ...page.data]);
      setCursor(page.next_cursor);
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setMore(false);
    }
  };

  const tags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags))].sort(), [rows]);
  const industries = useMemo(() => [...new Set(rows.flatMap((r) => r.industries))].sort(), [rows]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const onSort = (col: string) => {
    const s = SORTABLE[col];
    if (!s) return;
    const nextOrder = s === sort ? (order === "asc" ? "desc" : "asc") : s === "updated" ? "desc" : "asc";
    setParams({ sort: s, order: nextOrder });
  };
  const sortOf = (col: string) => (SORTABLE[col] === sort ? order : null);

  const bulkAdd = async (r: Round) => {
    try {
      const res = await bulkAddParticipants(client, r.id, [...selected]);
      toast.show(
        `${plural(res.added, "investor")} added to ${r.name}.${res.already ? ` ${num(res.already)} ${res.already === 1 ? "was" : "were"} already there.` : ""}`,
      );
      fetchPage();
    } catch (err) {
      toast.show(errorMessage(err));
    }
  };

  const exportSelected = () => {
    const sel = rows.filter((r) => selected.has(r.id));
    const header = ["investor_id", "name", "firm", "title", "type", "email", "linkedin_url", "website_url", "x_url", "location", "check_min", "check_max", "check_note", "stage_focus", "industries", "tags", "source", "warm_intro_by", "rounds", "notes"];
    const csv = toCsv(
      header,
      sel.map((i) => [
        i.id, i.name, i.firm, i.title, i.type, i.email, i.linkedin_url, i.website_url, i.x_url, i.location, i.check_min, i.check_max, i.check_note,
        i.stage_focus, i.industries, i.tags, i.source, i.warm_intro_by,
        i.rounds.map((r) => `${r.round_name}: ${r.stage.label}`), i.notes,
      ]),
    );
    downloadText(`raisebook-${workspace.slug}-investors-${today.replaceAll("-", "")}.csv`, csv);
  };

  const filtered = Boolean(q || type || tag || industry || roundFilter);
  const roundCount = rounds.length;

  return (
    <div className="flex flex-col gap-14 pb-56">
      <PageHeader
        title="Investors"
        className="mb-2"
        subline={`${plural(totalAll, "contact")} across ${plural(roundCount, "round")}`}
        actions={
          canWrite ? (
            <>
              <ButtonLink href={`${base}/import`}>Import CSV</ButtonLink>
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add investor
              </Button>
            </>
          ) : null
        }
      />

      {totalAll === 0 ? (
        <EmptyState
          title="Your contacts live here"
          actions={
            canWrite ? (
              <>
                <ButtonLink href={`${base}/import`}>Import CSV</ButtonLink>
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add investor
                </Button>
              </>
            ) : null
          }
        >
          Every investor you add to any round shows up once, with their history across rounds.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-8" role="search" aria-label="Filter contacts">
            <SearchInput placeholder="Search name, firm, email, notes…" aria-label="Search contacts" value={qText} onChange={(e) => onSearch(e.target.value)} />
            <Select tone="toolbar" aria-label="Type" className="w-auto!" value={type} onChange={(e) => setParams({ type: e.target.value })}>
              <option value="">Type: all</option>
              {(Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => (
                <option key={t} value={t}>
                  {INVESTOR_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
            <Select tone="toolbar" aria-label="Tag" className="w-auto! max-w-[180px]" value={tag} onChange={(e) => setParams({ tag: e.target.value })}>
              <option value="">Tag: any</option>
              {(tag && !tags.includes(tag) ? [tag, ...tags] : tags).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Select tone="toolbar" aria-label="Industry" className="w-auto! max-w-[180px]" value={industry} onChange={(e) => setParams({ industry: e.target.value })}>
              <option value="">Industry: any</option>
              {(industry && !industries.includes(industry) ? [industry, ...industries] : industries).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Select tone="toolbar" aria-label="Round" className="w-auto! max-w-[200px]" value={roundFilter} onChange={(e) => setParams({ round: e.target.value })}>
              <option value="">Round: any</option>
              {rounds.map((r) => (
                <option key={`in-${r.id}`} value={`in:${r.slug}`}>
                  In {r.name}
                </option>
              ))}
              {rounds.map((r) => (
                <option key={`out-${r.id}`} value={`out:${r.slug}`}>
                  Not in {r.name}
                </option>
              ))}
            </Select>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQText("");
                  setParams({ q: null, type: null, tag: null, industry: null, round: null });
                }}
              >
                Clear filters
              </Button>
            ) : null}
            <span className="t-micro ml-auto text-muted" aria-live="polite">
              {loading ? "Loading…" : `${num(rows.length)} of ${num(total)}`}
            </span>
          </div>

          {rows.length === 0 && !loading ? (
            <p className="t-body-s text-muted">No contacts match these filters.</p>
          ) : (
            <TableScroll>
              <Table minWidth={1080}>
                <THead>
                  <Tr>
                    <Th className="w-[36px]">
                      <Checkbox
                        aria-label={allSelected ? "Clear selection" : "Select all shown"}
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                      />
                    </Th>
                    <Th sort={sortOf("name")} onSort={() => onSort("name")}>
                      Name
                    </Th>
                    <Th sort={sortOf("firm")} onSort={() => onSort("firm")}>
                      Firm
                    </Th>
                    <Th>Type</Th>
                    <Th>Check size</Th>
                    <Th>Stage focus</Th>
                    <Th>Location</Th>
                    <Th>Rounds</Th>
                    <Th sort={sortOf("updated")} onSort={() => onSort("updated")}>
                      Updated
                    </Th>
                  </Tr>
                </THead>
                <TBody>
                  {rows.map((i) => (
                    <Tr key={i.id} selected={selected.has(i.id)} onActivate={() => router.push(`${base}/investors/${i.id}`)}>
                      <Td>
                        <Checkbox aria-label={`Select ${i.name}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                      </Td>
                      <Td className="min-w-[180px]">
                        <Link href={`${base}/investors/${i.id}`} className="font-semibold hover:underline">
                          {i.name}
                        </Link>
                        {i.title ? <span className="t-body-s block text-muted">{i.title}</span> : null}
                      </Td>
                      <Td className={i.firm ? undefined : "text-muted"}>{firmText(i.firm, i.type)}</Td>
                      <Td variant="muted" className="whitespace-nowrap">
                        {INVESTOR_TYPE_LABEL[i.type]}
                      </Td>
                      <Td className="t-data whitespace-nowrap">{checkSize(i, workspace.default_currency)}</Td>
                      <Td variant="muted">{i.stage_focus.map(stageFocusLabel).join(", ")}</Td>
                      <Td variant="muted">{i.location ?? ""}</Td>
                      <Td>
                        <span className="flex flex-col gap-2">
                          {i.rounds.map((r) => (
                            <span key={r.round_id} className="t-body-s inline-flex items-center gap-6 whitespace-nowrap" title={`${r.round_name}: ${r.stage.label}`}>
                              <StageDot color={r.stage.color} />
                              {r.round_name} <span className="text-muted">· {r.stage.label}</span>
                            </span>
                          ))}
                        </span>
                      </Td>
                      <Td className="t-data whitespace-nowrap text-muted">{formatDate(isoDate(i.updated_at, workspace.timezone), today)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableScroll>
          )}
          {loading && rows.length === 0 ? <Loading>Loading contacts…</Loading> : null}
          {cursor ? <Pagination shown={rows.length} total={total} hasMore onLoadMore={() => void loadMore()} loading={more} noun="contacts" /> : null}
        </>
      )}

      {selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
          <div className="gutter mx-auto flex max-w-app flex-wrap items-center gap-8 py-10">
            <span className="t-micro text-fg">{num(selected.size)} selected</span>
            {canWrite && rounds.length ? (
              <Menu
                label="Add to round"
                trigger={<>Add to round ▾</>}
                triggerClassName="inline-flex h-32 items-center gap-6 rounded-sm border border-line bg-surface px-12 font-medium hover:border-muted"
                items={rounds.map((r) => ({ label: r.name, hint: r.status === "closed" ? "Closed" : undefined, onSelect: () => void bulkAdd(r) }))}
              />
            ) : null}
            <Button onClick={exportSelected}>Export CSV</Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <AddInvestorDialog
        open={adding}
        onClose={() => setAdding(false)}
        client={client}
        wsSlug={workspace.slug}
        onAdded={(inv) => router.push(`${base}/investors/${inv.id}`)}
        onOpen={(id) => router.push(`${base}/investors/${id}`)}
      />
    </div>
  );
}
