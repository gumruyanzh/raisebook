"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  Button,
  ButtonLink,
  Checkbox,
  Chip,
  EmptyState,
  Kbd,
  Menu,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  StageDot,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
  useToastLift,
  type MenuEntry,
} from "@/components/ui";
import { Combobox } from "@/components/ui/Combobox";
import { FilterChips, FilterMenu, type FilterField, type FilterMenuHandle } from "@/components/ui/FilterBar";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import { errorMessage } from "@/lib/api/client";
import { investorSearchText, listAllInvestors, toInvestorRow, updateInvestor, type InvestorRow } from "@/lib/api/investors";
import { bulkAddParticipants } from "@/lib/api/rounds";
import type { InvestorType, Round } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { useCommands } from "@/lib/commands";
import { cn } from "@/lib/cn";
import { formatDate, isoDate, moneyCompact, num, plural, stageFocusLabel } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import { useWorkspace } from "@/lib/session";

import { AddInvestorDialog } from "./AddInvestorDialog";
import { downloadText, toCsv } from "./util";

type SortKey = "name" | "firm" | "type" | "location" | "updated";
type Col = "firm" | "type" | "check" | "focus" | "location" | "rounds" | "updated";

const DEFAULT_ORDER: Record<SortKey, "asc" | "desc"> = { name: "asc", firm: "asc", type: "asc", location: "asc", updated: "desc" };
const CONCURRENCY = 6;

const typeText = (t: InvestorType) => (t === "other" ? "—" : INVESTOR_TYPE_LABEL[t]);

function checkText(r: InvestorRow, currency: string): string {
  const { check_min: lo, check_max: hi } = r;
  if (lo && hi && lo !== hi) return `${moneyCompact(lo, currency)}–${moneyCompact(hi, currency)}`;
  if (lo || hi) return moneyCompact((lo || hi) as number, currency);
  return r.check_note ?? "";
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Run `fn` over `items` with at most `n` in flight; resolves with the failures. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>): Promise<unknown[]> {
  const errors: unknown[] = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++]!;
      try {
        await fn(it);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return errors;
}

/**
 * The investors directory (SYSTEM §4.7, UX-PASS-1 P2-5): every contact once, with their stage
 * in each round. All rows load once; search, filters and sort run in the browser and keep the
 * URL as the source of truth (replaceState, no server round trip). The table is windowed,
 * has one tab stop (↑/↓ or j/k, Enter opens, x selects, Shift extends, ⌘A selects all) and
 * hides columns that are empty for everyone. Phones get a list and a Filters sheet.
 */
export function InvestorsDirectory({
  rows: initialRows,
  rounds,
  today,
}: {
  rows: InvestorRow[];
  rounds: Round[];
  today: string;
}) {
  const { workspace, client, canWrite } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const currency = workspace.default_currency;

  const [rows, setRows] = useState(initialRows);
  useEffect(() => setRows(initialRows), [initialRows]);

  /* ---------- URL state ---------- */
  const get = (k: string) => params.get(k) ?? "";
  const q = get("q");
  const type = get("type");
  const tag = get("tag");
  const industry = get("industry");
  const roundFilter = get("round"); // "in:<slug>" | "out:<slug>"
  const sort = ((get("sort") || "name") as SortKey) in DEFAULT_ORDER ? ((get("sort") || "name") as SortKey) : "name";
  const order = (get("order") || DEFAULT_ORDER[sort]) as "asc" | "desc";

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) sp.delete(k);
      else sp.set(k, v);
    }
    const s = sp.toString();
    window.history.replaceState(null, "", s ? `${window.location.pathname}?${s}` : window.location.pathname);
  }, []);

  const [qText, setQText] = useState(q);
  useEffect(() => setQText(q), [q]);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setQText(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setParams({ q: v.trim() || null }), 120);
  };

  /* ---------- filter + sort (client side) ---------- */
  const searchIndex = useMemo(() => new Map(rows.map((r) => [r.id, investorSearchText(r)])), [rows]);
  const shown = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    const inRound = roundFilter.startsWith("in:") ? roundFilter.slice(3) : null;
    const outRound = roundFilter.startsWith("out:") ? roundFilter.slice(4) : null;
    const lc = (s: string) => s.toLowerCase();
    const out = rows.filter((r) => {
      if (type && r.type !== type) return false;
      if (tag && !r.tags.some((t) => lc(t) === lc(tag))) return false;
      if (industry && !r.industries.some((t) => lc(t) === lc(industry))) return false;
      if (inRound && !r.rounds.some((x) => x.slug === inRound)) return false;
      if (outRound && r.rounds.some((x) => x.slug === outRound)) return false;
      if (words.length) {
        const text = searchIndex.get(r.id) ?? "";
        if (!words.every((w) => text.includes(w))) return false;
      }
      return true;
    });
    const dir = order === "desc" ? -1 : 1;
    const key = (r: InvestorRow): string =>
      sort === "firm" ? lc(r.firm ?? "") : sort === "type" ? typeText(r.type) : sort === "location" ? lc(r.location ?? "") : sort === "updated" ? r.updated_at : lc(r.name);
    return out.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      // Empty values last in either direction.
      if (!ka && kb) return 1;
      if (ka && !kb) return -1;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir || a.name.localeCompare(b.name);
    });
  }, [rows, q, type, tag, industry, roundFilter, sort, order, searchIndex]);

  const filtered = Boolean(q || type || tag || industry || roundFilter);
  const tags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b)), [rows]);
  const industries = useMemo(() => [...new Set(rows.flatMap((r) => r.industries))].sort((a, b) => a.localeCompare(b)), [rows]);

  // Columns that are empty for every contact are not shown.
  const cols = useMemo(() => {
    const has = (f: (r: InvestorRow) => unknown) => rows.some((r) => {
      const v = f(r);
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    });
    const c: Col[] = [];
    if (has((r) => r.firm)) c.push("firm");
    if (has((r) => r.type !== "other")) c.push("type");
    if (has((r) => r.check_min || r.check_max || r.check_note)) c.push("check");
    if (has((r) => r.stage_focus)) c.push("focus");
    if (has((r) => r.location)) c.push("location");
    if (has((r) => r.rounds)) c.push("rounds");
    c.push("updated");
    return c;
  }, [rows]);

  /* ---------- selection ---------- */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectionBar = useRef<HTMLDivElement>(null);
  useToastLift(selectionBar, selected.size > 0);
  const anchor = useRef<number | null>(null);
  useEffect(() => {
    // Drop selections that are no longer in the workspace.
    setSelected((s) => {
      const ids = new Set(rows.map((r) => r.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectRange = (from: number, to: number, on = true) =>
    setSelected((s) => {
      const n = new Set(s);
      const [a, b] = from < to ? [from, to] : [to, from];
      for (let i = a; i <= b; i++) {
        const id = shown[i]?.id;
        if (!id) continue;
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.id));

  /* ---------- table: windowing + roving focus ---------- */
  const scroll = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(37);
  const [headH, setHeadH] = useState(33);
  const [tableH, setTableH] = useState<number | string>("70vh");
  const v = useVirtualRows({ scrollRef: scroll, count: shown.length, height: rowH, offset: headH, initial: 40 });
  const [focusIdx, setFocusIdx] = useState(0);
  const cur = shown.length ? Math.min(focusIdx, shown.length - 1) : -1;

  const hasRows = shown.length > 0;
  // Fit the table to the viewport: the page stops scrolling, rows scroll inside.
  useLayoutEffect(() => {
    const fit = () => {
      const el = scroll.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const bar = selected.size ? 64 : 0;
      setTableH(Math.max(320, window.innerHeight - top - 24 - bar));
      const tr = el.querySelector<HTMLElement>("tbody tr[data-row]");
      if (tr && tr.offsetHeight) setRowH(tr.offsetHeight);
      const th = el.querySelector<HTMLElement>("thead");
      if (th && th.offsetHeight) setHeadH(th.offsetHeight);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [selected.size, hasRows]);

  // Focus lands after the window re-renders around the row (it may not exist yet).
  const pendingFocus = useRef<number | null>(null);
  const focusRow = useCallback(
    (i: number) => {
      if (!shown.length) return;
      const n = Math.max(0, Math.min(shown.length - 1, i));
      pendingFocus.current = n;
      setFocusIdx(n);
      v.scrollToIndex(n);
    },
    [shown.length, v],
  );
  useLayoutEffect(() => {
    const n = pendingFocus.current;
    if (n === null) return;
    const el = scroll.current?.querySelector<HTMLElement>(`tr[data-row="${n}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  const openRow = (r: InvestorRow) => router.push(`${base}/investors/${r.id}`);

  const onRowKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, i: number) => {
    if (e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (k === "ArrowDown" || (k === "j" && !mod)) {
      e.preventDefault();
      if (e.shiftKey) {
        anchor.current ??= i;
        selectRange(anchor.current, i + 1);
      }
      focusRow(i + 1);
    } else if (k === "ArrowUp" || (k === "k" && !mod)) {
      e.preventDefault();
      if (e.shiftKey) {
        anchor.current ??= i;
        selectRange(anchor.current, i - 1);
      }
      focusRow(i - 1);
    } else if (k === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (k === "End") {
      e.preventDefault();
      focusRow(shown.length - 1);
    } else if ((k === "x" || k === " ") && !mod) {
      e.preventDefault();
      anchor.current = i;
      toggle(shown[i]!.id);
    } else if (k === "a" && mod) {
      e.preventDefault();
      setSelected(new Set(shown.map((r) => r.id)));
    } else if (k === "Escape" && selected.size) {
      e.preventDefault();
      setSelected(new Set());
    }
  };

  /* ---------- writes ---------- */
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  useCommands(
    "investors-directory",
    canWrite ? [{ id: "investor.new", label: "New investor", group: "Investors", kbd: "c", run: () => setAdding(true) }] : null,
  );
  useHotkey("mod+a", () => setSelected(new Set(shown.map((r) => r.id))), {
    enabled: shown.length > 0,
    description: "Select every shown contact",
    group: "Table",
    blockedByModals: true,
  });

  const refresh = useCallback(async () => {
    try {
      const all = await listAllInvestors(client);
      setRows(all.data.map(toInvestorRow));
    } catch (err) {
      toast.show(errorMessage(err));
    }
  }, [client, toast]);

  const bulkAdd = async (r: Round) => {
    setBusy(true);
    try {
      const res = await bulkAddParticipants(client, r.id, [...selected]);
      toast.show(
        `${plural(res.added, "investor")} added to ${r.name}.${res.already ? ` ${num(res.already)} ${res.already === 1 ? "was" : "were"} already there.` : ""}`,
      );
      await refresh();
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bulkType = async (t: InvestorType) => {
    const targets = rows.filter((r) => selected.has(r.id) && r.type !== t);
    if (!targets.length) return;
    const before = new Map(targets.map((r) => [r.id, r.type]));
    setRows((rs) => rs.map((r) => (before.has(r.id) ? { ...r, type: t } : r)));
    setBusy(true);
    const errs = await pool(targets, CONCURRENCY, (r) => updateInvestor(client, r.id, { type: t }));
    setBusy(false);
    if (errs.length) {
      toast.show(`${num(targets.length - errs.length)} of ${num(targets.length)} updated. ${errorMessage(errs[0])}`);
      void refresh();
      return;
    }
    toast.show(`${plural(targets.length, "contact")} set to ${INVESTOR_TYPE_LABEL[t]}.`, {
      label: "Undo",
      onClick: async () => {
        setRows((rs) => rs.map((r) => (before.has(r.id) ? { ...r, type: before.get(r.id)! } : r)));
        const e2 = await pool(targets, CONCURRENCY, (r) => updateInvestor(client, r.id, { type: before.get(r.id)! }));
        if (e2.length) toast.show(errorMessage(e2[0]));
      },
    });
  };

  const bulkTag = async (name: string, add: boolean) => {
    const t = name.trim();
    if (!t) return;
    const has = (r: InvestorRow) => r.tags.some((x) => x.toLowerCase() === t.toLowerCase());
    const targets = rows.filter((r) => selected.has(r.id) && (add ? !has(r) : has(r)));
    if (!targets.length) {
      toast.show(add ? `Every selected contact already has “${t}”.` : `No selected contact has “${t}”.`);
      return;
    }
    const apply = (on: boolean) =>
      setRows((rs) =>
        rs.map((r) =>
          targets.some((x) => x.id === r.id)
            ? { ...r, tags: on ? [...r.tags, t] : r.tags.filter((x) => x.toLowerCase() !== t.toLowerCase()) }
            : r,
        ),
      );
    apply(add);
    setBusy(true);
    const errs = await pool(targets, CONCURRENCY, (r) => updateInvestor(client, r.id, add ? { add_tags: [t] } : { remove_tags: [t] }));
    setBusy(false);
    if (errs.length) {
      toast.show(`${num(targets.length - errs.length)} of ${num(targets.length)} updated. ${errorMessage(errs[0])}`);
      void refresh();
      return;
    }
    toast.show(`${add ? "Tagged" : "Untagged"} ${plural(targets.length, "contact")} “${t}”.`, {
      label: "Undo",
      onClick: async () => {
        apply(!add);
        const e2 = await pool(targets, CONCURRENCY, (r) => updateInvestor(client, r.id, add ? { remove_tags: [t] } : { add_tags: [t] }));
        if (e2.length) toast.show(errorMessage(e2[0]));
      },
    });
  };

  const [tagDraft, setTagDraft] = useState<{ add: boolean } | null>(null);
  const [tagText, setTagText] = useState("");

  const exportSelected = async () => {
    setBusy(true);
    try {
      const all = await listAllInvestors(client);
      const sel = all.data.filter((i) => selected.has(i.id));
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
    } catch (err) {
      toast.show(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* ---------- render ---------- */
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Phones get the list, larger screens the table; only one is ever in the DOM.
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const onSort = (k: SortKey) => setParams({ sort: k, order: k === sort ? (order === "asc" ? "desc" : "asc") : DEFAULT_ORDER[k] });
  const sortOf = (k: SortKey) => (k === sort ? order : null);
  const clearAll = () => {
    setQText("");
    setParams({ q: null, type: null, tag: null, industry: null, round: null });
  };

  const filterControls = (stacked: boolean) => (
    <>
      <Select tone="toolbar" aria-label="Type" className={stacked ? undefined : "w-auto!"} value={type} onChange={(e) => setParams({ type: e.target.value })}>
        <option value="">Type: all</option>
        {(Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => (
          <option key={t} value={t}>
            {t === "other" ? "Other / not set" : INVESTOR_TYPE_LABEL[t]}
          </option>
        ))}
      </Select>
      <Combobox
        size="md"
        aria-label="Tag"
        placeholder="Tag: any"
        searchPlaceholder="Find a tag"
        clearable
        value={tag || null}
        options={tags.map((t) => ({ value: t, label: t, hint: num(rows.filter((r) => r.tags.includes(t)).length) }))}
        onChange={(v) => setParams({ tag: v })}
        renderValue={(o) => (o ? `Tag: ${o.label}` : "Tag: any")}
        className={stacked ? "w-full" : "w-[150px]"}
      />
      <Combobox
        size="md"
        aria-label="Industry"
        placeholder="Industry: any"
        searchPlaceholder="Find an industry"
        clearable
        value={industry || null}
        options={industries.map((t) => ({ value: t, label: t, hint: num(rows.filter((r) => r.industries.includes(t)).length) }))}
        onChange={(v) => setParams({ industry: v })}
        renderValue={(o) => (o ? `Industry: ${o.label}` : "Industry: any")}
        className={stacked ? "w-full" : "w-[170px]"}
      />
      <Select tone="toolbar" aria-label="Round" className={stacked ? undefined : "w-auto! max-w-[200px]"} value={roundFilter} onChange={(e) => setParams({ round: e.target.value })}>
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
    </>
  );

  // Larger screens: the pipeline's Filter menu (F) and removable chips, one toolbar row.
  const filterRef = useRef<FilterMenuHandle>(null);
  const filterFields: FilterField[] = useMemo(() => {
    const count = (f: (r: InvestorRow) => boolean) => num(rows.filter(f).length);
    const fields: FilterField[] = [
      {
        key: "type",
        label: "Type",
        values: (Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => ({
          value: t,
          label: t === "other" ? "Other / not set" : INVESTOR_TYPE_LABEL[t],
          hint: count((r) => r.type === t),
        })),
      },
      {
        key: "tag",
        label: "Tag",
        values: tags.map((t) => ({ value: t, label: t, hint: count((r) => r.tags.includes(t)) })),
      },
      {
        key: "industry",
        label: "Industry",
        values: industries.map((t) => ({ value: t, label: t, hint: count((r) => r.industries.includes(t)) })),
      },
    ];
    if (rounds.length) {
      fields.push(
        {
          key: "in",
          label: "In round",
          chipLabel: (v) => `In ${v}`,
          values: rounds.map((r) => ({ value: r.slug, label: r.name, hint: count((x) => x.rounds.some((y) => y.slug === r.slug)) })),
        },
        {
          key: "out",
          label: "Not in round",
          chipLabel: (v) => `Not in ${v}`,
          values: rounds.map((r) => ({ value: r.slug, label: r.name, hint: count((x) => !x.rounds.some((y) => y.slug === r.slug)) })),
        },
      );
    }
    return fields;
  }, [rows, tags, industries, rounds]);
  const activeMap: Record<string, string | undefined> = {
    type: type || undefined,
    tag: tag || undefined,
    industry: industry || undefined,
    in: roundFilter.startsWith("in:") ? roundFilter.slice(3) : undefined,
    out: roundFilter.startsWith("out:") ? roundFilter.slice(4) : undefined,
  };
  const setFilter = (k: string, v: string | null) => {
    if (k === "in" || k === "out") setParams({ round: v ? `${k}:${v}` : null });
    else setParams({ [k]: v });
  };
  useHotkey("f", () => filterRef.current?.open(), {
    description: "Filter",
    group: "Investors",
    blockedByModals: true,
    enabled: rows.length > 0,
  });

  const activeFilters = [type, tag, industry, roundFilter].filter(Boolean).length;
  const emptyActions = canWrite ? (
    <>
      <ButtonLink href={`${base}/import`}>Import CSV</ButtonLink>
      <Button variant="primary" onClick={() => setAdding(true)}>
        Add investor
      </Button>
      <ButtonLink variant="ghost" href={`${base}/settings/mcp`}>
        Connect an agent →
      </ButtonLink>
    </>
  ) : null;

  const tagMenu: MenuEntry[] = [
    { label: "Add a tag…", onSelect: () => { setTagText(""); setTagDraft({ add: true }); } },
    ...(tags.length ? [{ type: "separator" } as MenuEntry, { type: "label", label: "Add" } as MenuEntry] : []),
    ...tags.slice(0, 12).map((t): MenuEntry => ({ label: t, onSelect: () => void bulkTag(t, true) })),
    ...(tags.length ? [{ type: "separator" } as MenuEntry, { label: "Remove a tag…", onSelect: () => { setTagText(""); setTagDraft({ add: false }); } } as MenuEntry] : []),
  ];

  return (
    <div className={cn("flex flex-col", selected.size ? "pb-72" : "pb-8")}>
      <PageHeader
        title="Investors"
        aside={`${plural(rows.length, "contact")} across ${plural(rounds.length, "round")}`}
        actions={
          canWrite && rows.length ? (
            <>
              <ButtonLink href={`${base}/import`}>Import CSV</ButtonLink>
              <Button variant="primary" onClick={() => setAdding(true)} title="Add investor (C)">
                Add investor
              </Button>
            </>
          ) : null
        }
      />

      {rows.length === 0 ? (
        <EmptyState title="Your contacts live here" actions={emptyActions}>
          Every investor you add to any round shows up once, with their history across rounds.
        </EmptyState>
      ) : (
        <>
          <div className="mb-10 flex flex-wrap items-center gap-8" role="search" aria-label="Filter contacts">
            <div className="relative flex min-w-[200px] flex-[1_1_220px]">
              <SearchInput
                placeholder="Search name, firm, email, notes…"
                aria-label="Search contacts"
                aria-keyshortcuts="/"
                value={qText}
                onChange={(e) => onSearch(e.target.value)}
                className="w-full pr-32"
              />
              {!qText ? (
                <Kbd className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2">/</Kbd>
              ) : null}
            </div>
            <FilterMenu
              ref={filterRef}
              fields={filterFields}
              active={activeMap}
              onChange={setFilter}
              onOpenRequest={() => {
                if (!phone) return false;
                setFiltersOpen(true);
                return true;
              }}
              className="max-sm:hidden"
            />
            <Button className="sm:hidden" onClick={() => setFiltersOpen(true)}>
              Filters{activeFilters ? ` · ${activeFilters}` : ""}
            </Button>
            <span className="t-micro ml-auto text-muted" aria-live="polite">
              {num(shown.length)} of {num(rows.length)}
            </span>
          </div>
          <FilterChips
            className="-mt-2 mb-10"
            fields={filterFields}
            active={activeMap}
            onRemove={(k) => setFilter(k, null)}
            onClear={clearAll}
            focusAfterRemove={() =>
              requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Filter contacts"] [aria-keyshortcuts="F"]')?.focus())
            }
            extra={q ? [{ key: "q", label: `Matches “${q}”`, onRemove: () => onSearch("") }] : undefined}
          />

          {shown.length === 0 ? (
            <EmptyState title="No contacts match" actions={<Button onClick={clearAll}>Clear filters</Button>}>
              Try fewer filters, or search by firm or email.
            </EmptyState>
          ) : (
            <>
              {/* Phones: a list, one contact per row. */}
              {phone ? (
                <PhoneList
                  rows={shown}
                  base={base}
                  selected={selected}
                  onToggle={toggle}
                  typeText={typeText}
                  bottomGap={selected.size ? 88 : 16}
                />
              ) : null}

              {phone ? null : (
              <TableScroll ref={scroll} height={tableH} className="hidden overscroll-contain sm:block">
                <Table minWidth={cols.length > 5 ? 1080 : 760} aria-rowcount={shown.length + 1}>
                  <THead>
                    <Tr>
                      <Th className="sticky left-0 z-[2] w-[40px]">
                        <Checkbox
                          aria-label={allShownSelected ? "Clear selection" : `Select all ${num(shown.length)} shown`}
                          checked={allShownSelected}
                          onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((r) => r.id)))}
                        />
                      </Th>
                      <Th className="sticky left-[40px] z-[2] min-w-[220px]" sort={sortOf("name")} onSort={() => onSort("name")}>
                        Name
                      </Th>
                      {cols.includes("firm") ? (
                        <Th sort={sortOf("firm")} onSort={() => onSort("firm")}>
                          Firm
                        </Th>
                      ) : null}
                      {cols.includes("type") ? (
                        <Th sort={sortOf("type")} onSort={() => onSort("type")}>
                          Type
                        </Th>
                      ) : null}
                      {cols.includes("check") ? <Th>Check size</Th> : null}
                      {cols.includes("focus") ? <Th>Stage focus</Th> : null}
                      {cols.includes("location") ? (
                        <Th sort={sortOf("location")} onSort={() => onSort("location")}>
                          Location
                        </Th>
                      ) : null}
                      {cols.includes("rounds") ? <Th>Rounds</Th> : null}
                      <Th align="right" sort={sortOf("updated")} onSort={() => onSort("updated")}>
                        Updated
                      </Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {v.padTop ? (
                      <tr aria-hidden style={{ height: v.padTop }}>
                        <td colSpan={cols.length + 2} />
                      </tr>
                    ) : null}
                    {shown.slice(v.start, v.end).map((r, k) => {
                      const i = v.start + k;
                      const sel = selected.has(r.id);
                      const cell = "py-0 h-36 align-middle whitespace-nowrap";
                      return (
                        <Tr
                          key={r.id}
                          data-row={i}
                          aria-rowindex={i + 2}
                          tabIndex={i === cur ? 0 : -1}
                          selected={sel}
                          onActivate={() => openRow(r)}
                          onFocus={(e) => {
                            if (e.target === e.currentTarget) setFocusIdx(i);
                          }}
                          onKeyDown={(e) => onRowKey(e, i)}
                        >
                          <Td className={cn(cell, "sticky left-0 z-[1] w-[40px] bg-surface")}>
                            <Checkbox
                              tabIndex={-1}
                              aria-label={`Select ${r.name}`}
                              checked={sel}
                              onChange={() => {}}
                              onClick={(e) => {
                                if (e.shiftKey && anchor.current !== null) selectRange(anchor.current, i, !sel);
                                else toggle(r.id);
                                anchor.current = i;
                              }}
                            />
                          </Td>
                          <Td className={cn(cell, "sticky left-[40px] z-[1] max-w-[320px] bg-surface")}>
                            <span className="flex min-w-0 items-baseline gap-6">
                              <Link href={`${base}/investors/${r.id}`} tabIndex={-1} className="min-w-0 truncate font-semibold hover:underline">
                                {r.name}
                              </Link>
                              {r.title ? <span className="t-body-s min-w-0 shrink truncate text-muted">{r.title}</span> : null}
                            </span>
                          </Td>
                          {cols.includes("firm") ? (
                            <Td className={cn(cell, "max-w-[220px] truncate", !r.firm && "text-muted")} title={r.firm ?? undefined}>
                              {r.firm ?? "—"}
                            </Td>
                          ) : null}
                          {cols.includes("type") ? (
                            <Td variant="muted" className={cell}>
                              {typeText(r.type)}
                            </Td>
                          ) : null}
                          {cols.includes("check") ? (
                            <Td className={cn(cell, "t-data max-w-[160px] truncate")} title={r.check_note ?? undefined}>
                              {checkText(r, currency)}
                            </Td>
                          ) : null}
                          {cols.includes("focus") ? (
                            <Td variant="muted" className={cn(cell, "max-w-[180px] truncate")}>
                              {r.stage_focus.map(stageFocusLabel).join(", ")}
                            </Td>
                          ) : null}
                          {cols.includes("location") ? (
                            <Td variant="muted" className={cn(cell, "max-w-[160px] truncate")} title={r.location ?? undefined}>
                              {r.location ?? ""}
                            </Td>
                          ) : null}
                          {cols.includes("rounds") ? (
                            <Td className={cn(cell, "max-w-[260px]")} title={r.rounds.map((x) => `${x.name}: ${x.label}`).join("\n") || undefined}>
                              {r.rounds.length ? (
                                <span className="t-body-s flex min-w-0 items-center gap-6">
                                  <StageDot color={r.rounds[0]!.color} />
                                  <span className="truncate">
                                    {r.rounds[0]!.name} <span className="text-muted">· {r.rounds[0]!.label}</span>
                                  </span>
                                  {r.rounds.length > 1 ? (
                                    <Chip tone="tag" className="shrink-0">
                                      +{r.rounds.length - 1}
                                    </Chip>
                                  ) : null}
                                </span>
                              ) : (
                                <span className="t-body-s text-muted">Not in a round</span>
                              )}
                            </Td>
                          ) : null}
                          <Td className={cn(cell, "t-data text-right text-muted")}>{formatDate(isoDate(r.updated_at, workspace.timezone), today)}</Td>
                        </Tr>
                      );
                    })}
                    {v.padBottom ? (
                      <tr aria-hidden style={{ height: v.padBottom }}>
                        <td colSpan={cols.length + 2} />
                      </tr>
                    ) : null}
                  </TBody>
                </Table>
              </TableScroll>
              )}
              <p className="t-micro mt-6 hidden text-muted sm:block" aria-hidden>
                ↑↓ move · Enter opens · X selects · Shift+↓ extends · {"⌘"}A selects all
              </p>
            </>
          )}
        </>
      )}

      {selected.size > 0 ? (
        <div ref={selectionBar} className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]" role="region" aria-label="Selection">
          <div className="gutter mx-auto flex max-w-app flex-wrap items-center gap-8 py-10">
            <span className="t-micro text-fg">{num(selected.size)} selected</span>
            {canWrite && rounds.length ? (
              <Menu
                label="Add to round"
                trigger={<>Add to round ▾</>}
                triggerClassName="inline-flex h-32 items-center gap-6 rounded-sm border border-line bg-surface px-12 font-medium hover:border-muted disabled:opacity-60"
                items={rounds.map((r) => ({ label: r.name, hint: r.status === "closed" ? "closed" : undefined, onSelect: () => void bulkAdd(r) }))}
              />
            ) : null}
            {canWrite ? (
              <Menu
                label="Tag"
                trigger={<>Tag ▾</>}
                triggerClassName="inline-flex h-32 items-center gap-6 rounded-sm border border-line bg-surface px-12 font-medium hover:border-muted"
                items={tagMenu}
              />
            ) : null}
            {canWrite ? (
              <Menu
                label="Set type"
                trigger={<>Set type ▾</>}
                triggerClassName="inline-flex h-32 items-center gap-6 rounded-sm border border-line bg-surface px-12 font-medium hover:border-muted"
                items={(Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => ({ label: INVESTOR_TYPE_LABEL[t], onSelect: () => void bulkType(t) }))}
              />
            ) : null}
            <Button onClick={() => void exportSelected()} disabled={busy}>
              Export CSV
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Clear <Kbd className="ml-6">Esc</Kbd>
            </Button>
            {busy ? <span className="t-micro text-muted">Working…</span> : null}
          </div>
        </div>
      ) : null}

      <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters" subline={`${num(shown.length)} of ${num(rows.length)} contacts`}>
        <div className="flex flex-col gap-12 px-18 py-16">
          {filterControls(true)}
          <div className="flex gap-8">
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>
              Show {num(shown.length)}
            </Button>
            {filtered ? <Button onClick={clearAll}>Clear</Button> : null}
          </div>
        </div>
      </Sheet>

      {tagDraft ? (
        <TagPrompt
          add={tagDraft.add}
          value={tagText}
          onChange={setTagText}
          suggestions={tags}
          count={selected.size}
          onClose={() => setTagDraft(null)}
          onSubmit={(t) => {
            setTagDraft(null);
            void bulkTag(t, tagDraft.add);
          }}
        />
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

function TagPrompt({
  add,
  value,
  onChange,
  suggestions,
  count,
  onClose,
  onSubmit,
}: {
  add: boolean;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  count: number;
  onClose: () => void;
  onSubmit: (tag: string) => void;
}) {
  const listId = "rb-tag-suggestions";
  return (
    <DialogLite title={add ? `Tag ${plural(count, "contact")}` : `Remove a tag from ${plural(count, "contact")}`} onClose={onClose}>
      <form
        className="flex flex-col gap-12"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label className="flex flex-col gap-4">
          <span className="text-[12px] text-muted">Tag</span>
          <input
            autoFocus
            list={listId}
            value={value}
            maxLength={60}
            onChange={(e) => onChange(e.target.value)}
            placeholder="warm-intro"
            className="h-32 rounded-sm border border-line bg-canvas px-9"
          />
          <datalist id={listId}>
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <div className="flex justify-end gap-8">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {add ? "Add tag" : "Remove tag"}
          </Button>
        </div>
      </form>
    </DialogLite>
  );
}

/** A small modal for one field (the bulk tag prompt). */
function DialogLite({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-32px)] max-w-[400px] rounded-md border border-line bg-surface p-0 text-fg shadow-dialog"
    >
      <div className="px-20 pt-18 pb-16">
        <h2 className="t-display-s mb-12">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

const PHONE_ROW_H = 76;

/** Phones: one contact per row, windowed in a list that fills the screen below the toolbar. */
function PhoneList({
  rows,
  base,
  selected,
  onToggle,
  typeText,
  bottomGap,
}: {
  rows: InvestorRow[];
  base: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
  typeText: (t: InvestorType) => string;
  bottomGap: number;
}) {
  const scroll = useRef<HTMLUListElement>(null);
  const [h, setH] = useState<number | string>("70vh");
  useLayoutEffect(() => {
    const fit = () => {
      const el = scroll.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setH(Math.max(320, window.innerHeight - top - bottomGap));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [bottomGap]);
  const v = useVirtualRows({ scrollRef: scroll, count: rows.length, height: PHONE_ROW_H, initial: 14 });
  return (
    <ul
      ref={scroll}
      aria-label="Contacts"
      className="m-0 list-none overflow-y-auto overscroll-contain rounded-md border border-line bg-surface p-0"
      style={{ height: h }}
    >
      {v.padTop > 0 ? <li aria-hidden style={{ height: v.padTop }} /> : null}
      {rows.slice(v.start, v.end).map((r) => (
        <li key={r.id} className="flex items-center gap-10 border-b border-line px-12" style={{ height: PHONE_ROW_H }}>
          <Checkbox aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => onToggle(r.id)} className="size-20" />
          <Link href={`${base}/investors/${r.id}`} className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{r.name}</span>
            <span className="t-body-s block truncate text-muted">{[r.title, r.firm].filter(Boolean).join(" · ") || typeText(r.type)}</span>
            {r.rounds.length ? (
              <span className="t-body-s mt-2 flex min-w-0 items-center gap-6 text-muted">
                <StageDot color={r.rounds[0]!.color} />
                <span className="truncate">
                  {r.rounds[0]!.name} · {r.rounds[0]!.label}
                  {r.rounds.length > 1 ? ` +${r.rounds.length - 1}` : ""}
                </span>
              </span>
            ) : null}
          </Link>
        </li>
      ))}
      {v.padBottom > 0 ? <li aria-hidden style={{ height: v.padBottom }} /> : null}
    </ul>
  );
}
