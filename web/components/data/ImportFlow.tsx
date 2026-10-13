"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  Button,
  ButtonLink,
  Chip,
  EmptyState,
  Field,
  FileDrop,
  Input,
  Radio,
  SectionLabel,
  Select,
  StagePill,
  TextLink,
  Textarea,
} from "@/components/ui";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { useVirtualRows } from "@/components/ui/useVirtualRows";
import { downloadText, toCsv } from "@/components/app/util";
import { ApiError, errorMessage } from "@/lib/api/client";
import {
  CONTACT_FIELDS,
  csvShape,
  detectFormat,
  LEFT_EMPTY_KINDS,
  previewImport,
  prototypeRoundKeys,
  ROUND_FIELD_SET,
  ROUND_FIELDS,
  runImport,
  WARNING_KIND_LABEL,
  type ImportField,
  type ImportPreview,
  type ImportRequest,
  type ImportResult,
  type ImportRow,
  type OnDuplicate,
  type RoundMapEntry,
} from "@/lib/api/data";
import type { Round } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact, num, plural } from "@/lib/format";
import { useHotkey } from "@/lib/hotkeys";
import { useWorkspace } from "@/lib/session";

type Step = "source" | "columns" | "review" | "done";
type ValueMap = Record<string, Record<string, string>>;
type Filter = "all" | "create" | "update" | "skip" | "error" | "warning";

const DUPLICATE_OPTIONS: { value: OnDuplicate; label: string; hint: string }[] = [
  {
    value: "skip",
    label: "Skip existing",
    hint: "Investors you already have stay as they are. They are still added to the round if they are not on it.",
  },
  {
    value: "fill_empty",
    label: "Fill empty fields",
    hint: "Existing investors keep what they have; empty fields are filled and tags are merged.",
  },
  {
    value: "update",
    label: "Update existing",
    hint: "Non-empty cells overwrite what is there, including the stage in the round.",
  },
];

const ACTION_TONE = { create: "type", update: "soon", skip: "tag", error: "due" } as const;
const ACTION_LABEL = { create: "Create", update: "Update", skip: "Skip", error: "Error" } as const;
const MAP_KEY = (sig: string) => `rb-import-map:${sig}`;
/** Notices that fill a value rather than drop one (listed after real problems). */
const isNotice = (w: string) => w.startsWith("Type guessed");
const problemsOf = (r: ImportRow) => r.warnings.filter((w) => !isNotice(w));
const IGNORE = "__ignore";

interface ErrState {
  message: string;
  code?: string;
}

function toErr(e: unknown): ErrState {
  return e instanceof ApiError ? { message: e.message, code: e.code } : { message: errorMessage(e) };
}

/** A short stable signature of a header row, for remembering mappings per file layout. */
function headerSig(columns: string[]): string {
  let h = 5381;
  for (const ch of columns.map((c) => c.trim().toLowerCase()).join("\u0001")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return `${columns.length}-${(h >>> 0).toString(36)}`;
}

function readSaved(sig: string): { mapping: Record<string, ImportField | null>; valueMap: ValueMap } | null {
  try {
    const v = JSON.parse(localStorage.getItem(MAP_KEY(sig)) ?? "null");
    return v && typeof v === "object" && v.mapping ? v : null;
  } catch {
    return null;
  }
}

function writeSaved(sig: string, mapping: Record<string, ImportField | null>, valueMap: ValueMap) {
  try {
    localStorage.setItem(MAP_KEY(sig), JSON.stringify({ mapping, valueMap }));
  } catch {
    /* storage unavailable: the mapping just is not remembered */
  }
}

/**
 * Import flow (SYSTEM §4.10, UX-PASS-1 P1-10): 1 Source · 2 Columns · 3 Review, then the
 * result. The round defaults to the one you came from (or the only open one); column and
 * value mappings are remembered per header layout; the review lists every row with filter
 * chips and keyboard navigation; nothing is written until the last button.
 */
export function ImportFlow({ initialRound }: { initialRound?: string }) {
  const { workspace, rounds, client, canWrite } = useWorkspace();
  const router = useRouter();
  const openFirst = useMemo(
    () => [...rounds].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open")),
    [rounds],
  );
  const openRounds = rounds.filter((r) => r.status === "open");

  const [step, setStep] = useState<Step>("source");
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [roundSlug, setRoundSlug] = useState<string>(() => {
    if (initialRound && rounds.some((r) => r.slug === initialRound)) return initialRound;
    return openRounds.length === 1 ? openRounds[0]!.slug : "";
  });
  const [defaultStage, setDefaultStage] = useState("");
  const [source, setSource] = useState("");
  const [onDuplicate, setOnDuplicate] = useState<OnDuplicate>("skip");
  const [roundMap, setRoundMap] = useState<Record<string, { round: string; fit: string }>>({});
  const [mapping, setMapping] = useState<Record<string, ImportField | null> | null>(null);
  const [valueMap, setValueMap] = useState<ValueMap>({});
  const [restored, setRestored] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [reviewed, setReviewed] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<string | false>(false);
  const [err, setErr] = useState<ErrState | null>(null);

  const format = detectFormat(text);
  const protoKeys = useMemo(() => (format === "prototype_json" ? prototypeRoundKeys(text) : []), [format, text]);
  const shape = useMemo(() => (format === "csv" && text.trim() ? csvShape(text) : null), [format, text]);
  const round: Round | undefined = rounds.find((r) => r.slug === roundSlug);

  if (!canWrite) {
    return (
      <EmptyState title="Viewers can't import">
        Ask an owner or editor of {workspace.name} to import investors, or to make you an editor.
      </EmptyState>
    );
  }

  const request = (withMapping: boolean, m = mapping, vm = valueMap): ImportRequest => {
    const base: ImportRequest = {
      format,
      content: text,
      filename,
      on_duplicate: onDuplicate,
      source: source.trim() || null,
      default_stage: defaultStage || null,
    };
    if (format === "csv") {
      const values = Object.fromEntries(Object.entries(vm).filter(([, v]) => Object.keys(v).length));
      return {
        ...base,
        round: roundSlug || null,
        mapping: withMapping ? m : null,
        value_map: roundSlug && Object.keys(values).length ? values : null,
      };
    }
    const entries: RoundMapEntry[] = Object.entries(roundMap)
      .filter(([, v]) => v.round)
      .map(([key, v]) => ({ source_key: key, round: v.round, fit_field: v.fit || null }));
    return { ...base, round_map: entries.length ? entries : null, default_stage: null };
  };

  const loadPreview = async (withMapping: boolean, next: Step) => {
    setErr(null);
    setBusy(next === "columns" ? "Reading…" : "Checking…");
    try {
      let pv = await previewImport(client, request(withMapping));
      if (!withMapping) {
        // The same header layout as last time: start from the mappings used then.
        const saved = format === "csv" ? readSaved(headerSig(pv.columns)) : null;
        if (saved) {
          const m = Object.fromEntries(pv.columns.map((c) => [c, c in saved.mapping ? saved.mapping[c]! : (pv.mapping[c] ?? null)]));
          setMapping(m);
          setValueMap(saved.valueMap ?? {});
          setRestored(true);
          pv = await previewImport(client, request(true, m, saved.valueMap ?? {}));
        } else {
          setMapping(pv.mapping);
          setRestored(false);
        }
      }
      setPreview(pv);
      setStep(next);
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setErr(null);
    setBusy("Importing…");
    try {
      const res = await runImport(client, request(format === "csv"));
      if (format === "csv" && preview && mapping) writeSaved(headerSig(preview.columns), mapping, valueMap);
      setReviewed(preview);
      setResult(res);
      setStep("done");
      router.refresh();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("source");
    setPreview(null);
    setResult(null);
    setMapping(null);
    setValueMap({});
    setErr(null);
  };

  const clearFile = () => {
    setText("");
    setFilename(null);
    setMapping(null);
    setValueMap({});
    setPasting(false);
  };

  const roundHint = round
    ? `${plural(round.participant_count, "investor")} in ${round.name} now${round.status === "closed" ? " · closed round" : ""}. New rows start in ${defaultStage ? round.stages.find((s) => s.key === defaultStage)?.label : (round.stages[0]?.label ?? "the first stage")} unless a column says otherwise.`
    : "Contacts only: people go to the directory, on no board. Stage, fit, follow-up and amount columns are ignored.";

  return (
    <div className="flex flex-col gap-16">
      <StepLine step={step} skipColumns={format === "prototype_json"} />

      {step === "source" ? (
        <section aria-labelledby="imp-source" className="grid gap-16 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-24">
          <div className="flex min-w-0 flex-col gap-10">
            <SectionLabel
              id="imp-source"
              aside={
                <span className="t-body-s flex items-center gap-12">
                  <a href="/templates/raisebook-investors-template.csv" download className="link">
                    Download template CSV
                  </a>
                  <TextLink href="/docs/csv">CSV format</TextLink>
                </span>
              }
            >
              Source
            </SectionLabel>
            {filename && text ? (
              <div className="flex flex-wrap items-center gap-10 rounded-md border border-line bg-surface px-14 py-10">
                <span className="min-w-0 truncate font-medium" title={filename}>
                  {filename}
                </span>
                <span className="t-micro text-muted">
                  {format === "csv" && shape
                    ? `${num(shape.rows)} ${shape.rows === 1 ? "row" : "rows"} + header · ${num(shape.columns)} columns`
                    : "Prototype JSON"}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={clearFile}>
                  Remove
                </Button>
              </div>
            ) : (
              <FileDrop
                prompt="Drop a CSV file here, or paste below"
                onText={(t, f) => {
                  setText(t);
                  setFilename(f.name);
                  setMapping(null);
                  setValueMap({});
                  setPasting(false);
                }}
              />
            )}
            {!filename || pasting ? (
              <Field
                label="Or paste CSV"
                hint={
                  text && shape
                    ? `CSV · ${num(shape.rows)} ${shape.rows === 1 ? "row" : "rows"} + header · ${num(shape.columns)} columns`
                    : text
                      ? "Prototype JSON"
                      : "First row = column headers. Commas, semicolons and tabs all work."
                }
              >
                <Textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setFilename(null);
                    setMapping(null);
                  }}
                  rows={8}
                  spellCheck={false}
                  className="font-mono text-sm"
                  placeholder={"Name,Firm,Email,Stage\nDana Whitfield,Harbor Light Ventures,dana@example.com,Contacted"}
                />
              </Field>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-14">
            {format === "csv" ? (
              <>
                <Field label="Add to round" hint={roundHint}>
                  <Select
                    value={roundSlug}
                    onChange={(e) => {
                      setRoundSlug(e.target.value);
                      setDefaultStage("");
                      setValueMap({});
                    }}
                  >
                    <option value="">Contacts only</option>
                    {openFirst.map((r) => (
                      <option key={r.id} value={r.slug}>
                        {r.name} · {plural(r.participant_count, "investor")}
                        {r.status === "closed" ? " · closed" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                {round ? (
                  <Field label="Stage for rows without one">
                    <Select value={defaultStage} onChange={(e) => setDefaultStage(e.target.value)}>
                      <option value="">{round.stages[0]?.label ?? "First stage"} (first stage)</option>
                      {round.stages.slice(1).map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
              </>
            ) : (
              <PrototypeRounds keys={protoKeys} rounds={openFirst} value={roundMap} onChange={setRoundMap} />
            )}
            <Field label="Source label" optional hint='Fills "source" on rows that have none.'>
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="SF Tech Week 2026" maxLength={200} />
            </Field>
            <fieldset className="flex flex-col gap-8">
              <legend className="mb-6 text-[12px] text-muted">When an investor already exists</legend>
              {DUPLICATE_OPTIONS.map((o) => (
                <Radio
                  key={o.value}
                  name="on_duplicate"
                  value={o.value}
                  checked={onDuplicate === o.value}
                  onChange={() => setOnDuplicate(o.value)}
                  label={o.label}
                  hint={o.hint}
                />
              ))}
            </fieldset>
            <p className="t-body-s text-muted">
              Matches by email, then LinkedIn, then name + firm. Nothing is written until you confirm.
            </p>
            <div className="flex flex-wrap gap-8">
              <Button
                variant={text.trim() ? "primary" : "secondary"}
                disabled={!text.trim()}
                busy={busy}
                onClick={() => void loadPreview(false, format === "csv" ? "columns" : "review")}
              >
                {format === "csv" ? "Map columns" : "Review"}
              </Button>
              {filename && !pasting ? (
                <Button variant="ghost" onClick={() => setPasting(true)}>
                  Paste instead
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {step === "columns" && preview && mapping ? (
        <section aria-labelledby="imp-columns" className="flex flex-col gap-10">
          <SectionLabel
            id="imp-columns"
            aside={
              <span className="t-micro text-muted">
                {restored ? "Mapped like your last import of this layout · " : ""}
                {plural(preview.row_count, "row")} · {preview.columns.length} columns
              </span>
            }
          >
            Columns
          </SectionLabel>
          <ColumnTable
            preview={preview}
            mapping={mapping}
            round={round}
            onChange={(col, f) => setMapping({ ...mapping, [col]: f })}
          />
          {round ? (
            <ValueMapping preview={preview} mapping={mapping} round={round} value={valueMap} onChange={setValueMap} />
          ) : null}
          <Warnings items={preview.warnings} />
          <ActionBar>
            <Button onClick={() => setStep("source")} disabled={!!busy}>
              Back
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void loadPreview(true, "review")}>
              Review {plural(preview.row_count, "row")}
            </Button>
          </ActionBar>
        </section>
      ) : null}

      {step === "review" && preview ? (
        <section aria-labelledby="imp-review" className="flex flex-col gap-12">
          <SectionLabel id="imp-review">Review</SectionLabel>
          <Review
            preview={preview}
            rounds={rounds}
            fallbackRound={round}
            currency={round?.currency ?? workspace.default_currency}
            roundName={round?.name ?? roundNameFromMap(roundMap, rounds)}
            filename={filename}
          />
          <ActionBar>
            <Button onClick={() => setStep(format === "csv" ? "columns" : "source")} disabled={!!busy}>
              Back
            </Button>
            <Button variant="primary" busy={busy} disabled={importable(preview) === 0} onClick={() => void commit()}>
              {importLabel(preview)}
            </Button>
          </ActionBar>
        </section>
      ) : null}

      {step === "done" && result ? (
        <ResultView result={result} preview={reviewed} round={round} wsSlug={workspace.slug} onAgain={reset} />
      ) : null}

      {err ? (
        <p role="alert" className="t-body-s text-bad">
          {err.message}
          {err.code ? <span className="ml-6 font-mono">{err.code}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** The step's buttons stay on screen while the list scrolls. */
function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-16 flex flex-wrap items-center gap-8 border-t border-line bg-canvas px-16 py-10 pb-[calc(10px+env(safe-area-inset-bottom))] lg:-mx-24 lg:px-24">
      {children}
    </div>
  );
}

/** Rows that change something: new or updated investors, or existing ones added to a round. */
function importable(p: ImportPreview): number {
  return p.counts.create + p.counts.update + p.counts.add_to_round;
}

/**
 * "Import 390 · 20 duplicates skipped · 74 cells left empty": what the click writes, then
 * what it will not (UX-PASS-1 P0-6), so the label matches the counts above it.
 */
function importLabel(p: ImportPreview): string {
  const c = p.counts;
  const n = c.create + c.update;
  const extra: string[] = [];
  if (c.skip) extra.push(`${num(c.skip)} ${c.skip === 1 ? "duplicate" : "duplicates"} skipped`);
  if (c.cells_left_empty) extra.push(`${num(c.cells_left_empty)} ${c.cells_left_empty === 1 ? "cell" : "cells"} left empty`);
  if (!n) {
    if (!c.add_to_round) return "Nothing to import";
    return [`Add ${plural(c.add_to_round, "investor")} to the round`, ...extra].join(" · ");
  }
  return [`Import ${num(n)}`, ...extra].join(" · ");
}

function roundNameFromMap(m: Record<string, { round: string }>, rounds: Round[]): string | undefined {
  const slugs = Object.values(m).map((v) => v.round).filter(Boolean);
  if (slugs.length !== 1) return slugs.length ? "rounds" : undefined;
  return rounds.find((r) => r.slug === slugs[0])?.name;
}

function StepLine({ step, skipColumns }: { step: Step; skipColumns: boolean }) {
  const steps: { key: Step; label: string }[] = [
    { key: "source", label: "1 Source" },
    { key: "columns", label: skipColumns ? "2 Columns (CSV only)" : "2 Columns" },
    { key: "review", label: "3 Review" },
  ];
  const current = step === "done" ? "review" : step;
  return (
    <ol className="t-micro flex flex-wrap items-center gap-x-8 gap-y-4 text-muted" aria-label="Import steps">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-8">
          {i > 0 ? <span aria-hidden>·</span> : null}
          <span className={cn(s.key === current && "text-fg")} aria-current={s.key === current ? "step" : undefined}>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ColumnTable({
  preview,
  mapping,
  round,
  onChange,
}: {
  preview: ImportPreview;
  mapping: Record<string, ImportField | null>;
  round?: Round;
  onChange: (col: string, f: ImportField | null) => void;
}) {
  const used = new Map<string, string>();
  for (const [col, f] of Object.entries(mapping)) if (f) used.set(f, col);
  const roundGroup = round ? `In ${round.name}` : "In a round (pick one first)";
  const optionsFor = (col: string): ComboboxOption<string>[] => [
    { value: IGNORE, label: "Ignore", description: "This column is not imported" },
    ...CONTACT_FIELDS.map(([f, label]) => ({
      value: f,
      label,
      group: "Contact",
      disabled: used.has(f) && used.get(f) !== col,
      hint: used.has(f) && used.get(f) !== col ? `← ${used.get(f)}` : undefined,
    })),
    ...ROUND_FIELDS.map(([f, label]) => ({
      value: f,
      label,
      group: roundGroup,
      disabled: !round || (used.has(f) && used.get(f) !== col),
      hint: used.has(f) && used.get(f) !== col ? `← ${used.get(f)}` : undefined,
    })),
  ];
  const picker = (col: string) => {
    const current = mapping[col] ?? null;
    return (
      <>
        <Combobox
          size="sm"
          aria-label={`Field for ${col}`}
          searchPlaceholder="Find a field"
          value={current ?? IGNORE}
          options={optionsFor(col)}
          onChange={(v) => onChange(col, !v || v === IGNORE ? null : (v as ImportField))}
          renderValue={(o) => (o && o.value !== IGNORE ? o.label : <span className="text-muted">Ignore</span>)}
          className="w-full"
        />
        {current && ROUND_FIELD_SET.has(current) && !round ? (
          <span className="t-body-s mt-4 block text-muted">Pick a round first; this column is ignored.</span>
        ) : null}
      </>
    );
  };
  return (
    <>
    {/* Phones: one card per column, the field picker in reach (a 680px table hid it). */}
    <ul className="m-0 flex list-none flex-col gap-8 p-0 md:hidden" aria-label="Columns">
      {preview.columns.map((col) => {
        const samples = (preview.samples[col] ?? []).slice(0, 2);
        return (
          <li key={col} className="flex min-w-0 flex-col gap-6 rounded-md border border-line bg-surface p-12">
            <span className="flex min-w-0 items-baseline gap-8">
              <span className="min-w-0 truncate font-medium">{col}</span>
              <span aria-hidden className="text-muted">→</span>
            </span>
            {picker(col)}
            <span className="t-data min-w-0 truncate text-muted">
              {samples.length ? samples.join(" · ") : "empty"}
            </span>
          </li>
        );
      })}
    </ul>
    <div className="hidden overflow-x-auto rounded-md border border-line bg-surface md:block">
      <table className="w-full min-w-[680px] border-collapse text-base">
        <thead>
          <tr>
            {["Column", "Sample values", "In the file", "Raisebook field"].map((h) => (
              <th key={h} scope="col" className="t-th border-b border-line px-10 py-8 text-left text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.columns.map((col) => {
            const samples = preview.samples[col] ?? [];
            const st = preview.column_stats?.[col];
            return (
              <tr key={col}>
                <td className="border-b border-line px-10 py-8 align-top font-medium">{col}</td>
                <td className="t-data max-w-[300px] border-b border-line px-10 py-8 align-top text-muted">
                  {samples.length ? (
                    samples.map((v, i) => (
                      <span key={i} className="block truncate" title={v}>
                        {v}
                      </span>
                    ))
                  ) : (
                    <span>empty</span>
                  )}
                </td>
                <td className="border-b border-line px-10 py-8 align-top">
                  <span className="flex flex-wrap gap-4">
                    {st?.empty ? <Chip tone="tag">{num(st.empty)} empty</Chip> : null}
                    {st?.unreadable ? (
                      <Chip tone="soon" title="Values that could not be read; those cells stay empty">
                        {num(st.unreadable)} unreadable
                      </Chip>
                    ) : null}
                    {!st?.empty && !st?.unreadable ? <span className="t-micro text-muted">all filled</span> : null}
                  </span>
                </td>
                <td className="w-[260px] border-b border-line px-10 py-8 align-top">{picker(col)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

/**
 * When a column is mapped to Pipeline stage or Fit: each distinct value, how many rows have
 * it, and what it becomes. Exact and similar labels match on their own; others get a
 * suggestion ("Intro requested" → Contacted) that you can change.
 */
function ValueMapping({
  preview,
  mapping,
  round,
  value,
  onChange,
}: {
  preview: ImportPreview;
  mapping: Record<string, ImportField | null>;
  round: Round;
  value: ValueMap;
  onChange: (v: ValueMap) => void;
}) {
  const stageCol = Object.keys(mapping).find((c) => mapping[c] === "stage");
  const fitCol = Object.keys(mapping).find((c) => mapping[c] === "fit");
  const stageVals = useMemo(() => (stageCol ? (preview.values?.[stageCol] ?? []) : []), [preview.values, stageCol]);
  const fitVals = fitCol ? (preview.values?.[fitCol] ?? []).filter((v) => v.fit == null) : [];

  // Unmatched stage values start from their suggestion.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !stageVals.length) return;
    seeded.current = true;
    const auto: Record<string, string> = { ...(value.stage ?? {}) };
    for (const v of stageVals) if (!v.stage && v.suggestion && !(v.value in auto)) auto[v.value] = v.suggestion;
    if (Object.keys(auto).length !== Object.keys(value.stage ?? {}).length) onChange({ ...value, stage: auto });
  }, [stageVals, value, onChange]);

  if (!stageVals.length && !fitVals.length) return null;
  const first = round.stages[0];
  const setStage = (raw: string, key: string) => {
    const next = { ...(value.stage ?? {}) };
    if (key) next[raw] = key;
    else delete next[raw];
    onChange({ ...value, stage: next });
  };
  const setFit = (raw: string, fit: string) => {
    const next = { ...(value.fit ?? {}) };
    if (fit) next[raw] = fit;
    else delete next[raw];
    onChange({ ...value, fit: next });
  };
  return (
    <section aria-label="Values" className="flex max-w-[760px] flex-col gap-8 rounded-md border border-line bg-surface p-14">
      <SectionLabel>Values</SectionLabel>
      <p className="t-body-s text-muted">
        What each value in your file becomes in {round.name}. Changes apply when you review.
      </p>
      {stageVals.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(160px,220px)] items-center gap-x-12 gap-y-6">
          <span className="t-label">{stageCol}</span>
          <span className="t-label text-right">Rows</span>
          <span className="t-label">Stage in {round.name}</span>
          {stageVals.map((v) => {
            const chosen = v.stage ?? value.stage?.[v.value] ?? "";
            return (
              <div key={v.value} className="contents">
                <span className="min-w-0 truncate" title={v.value}>
                  {v.value}
                </span>
                <span className="t-data text-right text-muted">{num(v.count)}</span>
                {v.stage ? (
                  <span className="t-body-s flex items-center gap-6">
                    {(() => {
                      const st = round.stages.find((s) => s.key === v.stage);
                      return st ? <StagePill color={st.color} label={st.label} /> : v.stage;
                    })()}
                    <span className="t-micro text-muted">matches</span>
                  </span>
                ) : (
                  <Select size="sm" aria-label={`Stage for “${v.value}”`} value={chosen} onChange={(e) => setStage(v.value, e.target.value)}>
                    <option value="">{first ? `${first.label} (default)` : "Default stage"}</option>
                    {round.stages.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                        {s.key === v.suggestion ? " (suggested)" : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {fitVals.length ? (
        <div className="mt-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(160px,220px)] items-center gap-x-12 gap-y-6">
          <span className="t-label">{fitCol}</span>
          <span className="t-label text-right">Rows</span>
          <span className="t-label">Fit</span>
          {fitVals.map((v) => (
            <div key={v.value} className="contents">
              <span className="min-w-0 truncate">{v.value}</span>
              <span className="t-data text-right text-muted">{num(v.count)}</span>
              <Select size="sm" aria-label={`Fit for “${v.value}”`} value={value.fit?.[v.value] ?? ""} onChange={(e) => setFit(v.value, e.target.value)}>
                <option value="">Leave empty</option>
                {[5, 4, 3, 2, 1, 0].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="t-body-s flex flex-col gap-4 text-warm-ink">
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

const ROW_H = 40;

/**
 * Every row of the file (windowed), filtered by the count chips, with the problems written
 * out. One tab stop: j/k or ↑/↓ move. "Download rows with problems" writes a CSV in the
 * browser.
 */
function Review({
  preview,
  rounds,
  fallbackRound,
  currency,
  roundName,
  filename,
}: {
  preview: ImportPreview;
  rounds: Round[];
  fallbackRound?: Round;
  currency: string;
  roundName?: string;
  filename: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const c = preview.counts;
  const warned = useMemo(() => preview.rows.filter((r) => r.action !== "error" && problemsOf(r).length).length, [preview.rows]);
  const rows = useMemo(
    () =>
      preview.rows.filter((r) =>
        filter === "all" ? true : filter === "warning" ? problemsOf(r).length > 0 && r.action !== "error" : r.action === filter,
      ),
    [preview.rows, filter],
  );
  const chips: [Filter, string, number][] = [
    ["all", "All", preview.row_count],
    ["create", "Create", c.create],
    ["update", "Update", c.update],
    ["skip", "Skip", c.skip],
    ["error", "Errors", c.error],
    ["warning", "Warnings", warned],
  ];
  const kinds = Object.entries(preview.warning_kinds ?? {}).filter(([, n]) => n > 0);
  const leftEmpty = kinds.filter(([k]) => LEFT_EMPTY_KINDS.has(k));
  const notices = kinds.filter(([k]) => !LEFT_EMPTY_KINDS.has(k));
  const sentence = (list: [string, number][]) =>
    list
      .map(([k, n]) => {
        const [one, many] = WARNING_KIND_LABEL[k] ?? WARNING_KIND_LABEL.value_invalid!;
        return `${num(n)} ${n === 1 ? one : many}`;
      })
      .join(" · ");

  const stageOf = (roundSlug: string | null | undefined, key: string) => {
    const r = (roundSlug && rounds.find((x) => x.slug === roundSlug)) || fallbackRound;
    return r?.stages.find((s) => s.key === key);
  };

  const scroll = useRef<HTMLDivElement>(null);
  const v = useVirtualRows({ scrollRef: scroll, count: rows.length, height: ROW_H, offset: 33, initial: 30 });
  const [focus, setFocus] = useState(0);
  const pending = useRef<number | null>(null);
  const cur = rows.length ? Math.min(focus, rows.length - 1) : -1;
  const focusRow = useCallback(
    (i: number) => {
      if (!rows.length) return;
      const n = Math.max(0, Math.min(rows.length - 1, i));
      pending.current = n;
      setFocus(n);
      v.scrollToIndex(n);
    },
    [rows.length, v],
  );
  useEffect(() => {
    const n = pending.current;
    if (n === null) return;
    const el = scroll.current?.querySelector<HTMLElement>(`[data-row="${n}"]`);
    if (el) {
      pending.current = null;
      el.focus({ preventScroll: true });
    }
  });
  useHotkey("j", () => focusRow(scroll.current?.contains(document.activeElement) ? cur + 1 : Math.max(cur, 0)), {
    description: "Next row",
    group: "Import",
    blockedByModals: true,
  });
  useHotkey("k", () => focusRow(cur - 1), { description: "Previous row", group: "Import", blockedByModals: true });
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, i: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(rows.length - 1);
    }
  };

  const problems = preview.rows.filter((r) => r.errors.length || problemsOf(r).length);
  const downloadProblems = () => {
    const csv = toCsv(
      ["row", "action", "name", "firm", "email", "errors", "warnings"],
      problems.map((r) => [
        r.row,
        r.action,
        r.investor.name ?? "",
        r.investor.firm ?? "",
        r.investor.email ?? "",
        r.errors.map((e) => `${e.field}: ${e.message}`).join(" | "),
        r.warnings.join(" | "),
      ]),
    );
    const base = (filename ?? "import").replace(/\.[a-z0-9]+$/i, "");
    downloadText(`${base}-problems.csv`, csv);
  };

  return (
    <div className="flex flex-col gap-10">
      <div role="group" aria-label="Show rows" className="flex flex-wrap items-center gap-6">
        {chips.map(([key, label, n]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            disabled={n === 0 && key !== "all"}
            onClick={() => setFilter(key)}
            className={cn(
              "t-chip inline-flex h-28 items-center gap-6 rounded-pill border px-10 transition-colors duration-[120ms] disabled:opacity-50",
              filter === key ? "border-fg bg-fg text-canvas" : "border-line bg-surface text-fg hover:border-muted",
            )}
          >
            {label}
            <span className={cn("font-mono", filter === key ? "text-canvas" : key === "error" && n ? "text-bad" : "text-muted")}>{num(n)}</span>
          </button>
        ))}
        {roundName ? (
          <span className="t-micro text-muted">
            · {num(c.add_to_round)} added to {roundName}
          </span>
        ) : null}
        {problems.length ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={downloadProblems}>
            Download {plural(problems.length, "row")} with problems (CSV)
          </Button>
        ) : null}
      </div>
      {leftEmpty.length ? (
        <p className="t-body-s text-warm-ink">{sentence(leftEmpty)}. Those cells stay empty; the rows still import.</p>
      ) : null}
      {notices.length ? <p className="t-body-s text-muted">{sentence(notices)}.</p> : null}
      <Warnings items={preview.warnings} />

      <div ref={scroll} className="max-h-[min(64vh,720px)] overflow-auto overscroll-contain rounded-md border border-line bg-surface">
        <div role="table" aria-label="Rows to import" aria-rowcount={rows.length + 1} className="min-w-[640px] md:min-w-[880px]">
          <div
            role="row"
            className={cn(
              "t-th sticky top-0 z-[1] grid h-33 items-center gap-x-10 border-b border-line bg-surface px-10 text-muted",
              REVIEW_COLS,
            )}
          >
            <span role="columnheader" className="text-right max-md:hidden">Row</span>
            <span role="columnheader">Action</span>
            <span role="columnheader">Name</span>
            <span role="columnheader" className="max-md:order-2">Firm</span>
            <span role="columnheader" className="max-md:order-2">Round</span>
            <span role="columnheader" className="max-md:order-2">Matched</span>
            <span role="columnheader" className="max-md:order-1">Notes</span>
          </div>
          <div style={{ height: v.padTop }} aria-hidden />
          {rows.slice(v.start, v.end).map((r, k) => {
            const i = v.start + k;
            return (
              <ReviewRow
                key={r.row}
                r={r}
                index={i}
                focused={i === cur}
                onKeyDown={(e) => onKey(e, i)}
                onFocus={() => setFocus(i)}
                stageOf={stageOf}
                currency={currency}
              />
            );
          })}
          <div style={{ height: v.padBottom }} aria-hidden />
          {rows.length === 0 ? <p className="t-body-s px-10 py-12 text-muted">No rows in this filter.</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Review columns. Phones drop the row number and put Notes (why a row is skipped or
 * flagged) right after the name, so it is on screen without scrolling sideways.
 */
const REVIEW_COLS =
  "grid-cols-[56px_76px_minmax(140px,1.1fr)_minmax(120px,1fr)_minmax(140px,1fr)_minmax(150px,1fr)_minmax(200px,1.6fr)] " +
  "max-md:grid-cols-[68px_minmax(96px,1fr)_minmax(150px,1.6fr)_minmax(110px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)]";

function ReviewRow({
  r,
  index,
  focused,
  onKeyDown,
  onFocus,
  stageOf,
  currency,
}: {
  r: ImportRow;
  index: number;
  focused: boolean;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  stageOf: (round: string | null | undefined, key: string) => { color: Round["stages"][number]["color"]; label: string } | undefined;
  currency: string;
}) {
  const p = r.participant;
  const notes = [
    ...r.errors.map((e) => `${e.field}: ${e.message}`),
    ...problemsOf(r),
    ...r.warnings.filter(isNotice),
  ];
  const st = p?.stage ? stageOf(p.round, p.stage) : undefined;
  return (
    <div
      role="row"
      data-row={index}
      tabIndex={focused ? 0 : -1}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      aria-rowindex={index + 2}
      className={cn(
        "grid items-center gap-x-10 border-b border-line px-10 outline-none",
        REVIEW_COLS,
        "hover:bg-[color-mix(in_oklab,var(--sunk)_55%,var(--surface))] focus-visible:bg-accent-soft focus-visible:shadow-[inset_2px_0_0_var(--accent)]",
      )}
      style={{ height: ROW_H }}
    >
      <span role="cell" className="t-data text-right text-muted max-md:hidden">
        {r.row}
      </span>
      <span role="cell">
        <Chip tone={ACTION_TONE[r.action]}>{ACTION_LABEL[r.action]}</Chip>
      </span>
      <span role="cell" className="truncate font-medium" title={String(r.investor.name ?? "")}>
        {String(r.investor.name ?? "") || <span className="text-muted">No name</span>}
      </span>
      <span role="cell" className="truncate text-muted max-md:order-2" title={String(r.investor.firm ?? "")}>
        {String(r.investor.firm ?? "")}
      </span>
      <span role="cell" className="t-body-s flex min-w-0 items-center gap-6 whitespace-nowrap max-md:order-2">
        {p?.stage ? (
          <>
            {st ? <StagePill color={st.color} label={st.label} /> : <span className="font-mono">{p.stage}</span>}
            {p.fit != null ? <span className="text-muted">fit {p.fit}</span> : null}
            {p.amount_committed ? <Chip tone="money">{moneyCompact(p.amount_committed, currency)}</Chip> : null}
          </>
        ) : (
          <span className="text-muted">–</span>
        )}
      </span>
      <span role="cell" className="t-body-s min-w-0 truncate max-md:order-2" title={r.match ? `${r.match.name} (${r.match.matched_on.replace("_", " + ")})` : undefined}>
        {r.match ? (
          <>
            {r.match.investor_id ? "Already in Raisebook" : `Same as row ${r.match.row}`}
            <span className="ml-6 font-mono text-muted">{r.match.matched_on.replace("_", "+")}</span>
          </>
        ) : null}
      </span>
      <span role="cell" className={cn("t-body-s min-w-0 truncate max-md:order-1 max-md:line-clamp-2 max-md:whitespace-normal max-md:leading-[1.25]", r.errors.length ? "text-bad" : "text-muted")} title={notes.join("\n") || undefined}>
        {notes[0] ?? ""}
        {notes.length > 1 ? <span className="ml-6 font-mono text-muted">+{notes.length - 1}</span> : null}
      </span>
    </div>
  );
}

function ResultView({
  result,
  preview,
  round,
  wsSlug,
  onAgain,
}: {
  result: ImportResult;
  preview: ImportPreview | null;
  round?: Round;
  wsSlug: string;
  onAgain: () => void;
}) {
  const c = result.counts;
  const skips = preview?.rows.filter((r) => r.action === "skip" && r.match) ?? [];
  const inFile = skips.filter((r) => !r.match!.investor_id);
  const existing = skips.filter((r) => r.match!.investor_id);
  const parts = [
    `Imported ${plural(c.created, "new investor")}`,
    c.updated ? `updated ${num(c.updated)}` : null,
  ].filter(Boolean);
  // Errors grouped by what went wrong.
  const groups = new Map<string, number[]>();
  for (const e of result.errors) {
    const k = `${e.field}: ${e.message}`;
    groups.set(k, [...(groups.get(k) ?? []), e.row]);
  }
  // Next step: the biggest active stage whose new investors have no follow-up yet.
  const next = useMemo(() => {
    if (!preview || !result.round) return null;
    const by = new Map<string, number>();
    for (const r of preview.rows) {
      const p = r.participant;
      if (r.action !== "create" || !p?.stage || p.follow_up_on) continue;
      by.set(p.stage, (by.get(p.stage) ?? 0) + 1);
    }
    const passive = new Set(["new", "research", "researching", "passed", "committed"]);
    const best = [...by.entries()].filter(([k]) => !passive.has(k)).sort((a, b) => b[1] - a[1])[0];
    return best ? { stage: best[0], n: best[1] } : null;
  }, [preview, result.round]);
  const enc = encodeURIComponent;
  return (
    <section aria-live="polite" className="flex flex-col gap-12 rounded-md border border-line bg-surface p-16">
      <p className="t-display-xs">{parts.join(", ")}.</p>
      <ul className="t-body-s m-0 flex list-none flex-col gap-4 p-0 text-muted">
        {result.round ? (
          <li>
            {plural(c.added_to_round, "investor")} added to <span className="text-fg">{result.round.name}</span>.
          </li>
        ) : null}
        {existing.length ? (
          <li>
            {plural(existing.length, "row")} {existing.length === 1 ? "was" : "were"} already in Raisebook and skipped.
          </li>
        ) : null}
        {inFile.length ? (
          <li>
            {plural(inFile.length, "row")} repeated an earlier row of this file:{" "}
            {inFile.slice(0, 6).map((r, i) => (
              <span key={r.row}>
                {i ? ", " : ""}row {r.row} = row {r.match!.row}
              </span>
            ))}
            {inFile.length > 6 ? ` and ${num(inFile.length - 6)} more` : ""}.
          </li>
        ) : null}
        {c.cells_left_empty ? <li>{plural(c.cells_left_empty, "unreadable cell")} left empty; those rows imported.</li> : null}
      </ul>
      {groups.size ? (
        <div className="flex flex-col gap-4">
          <p className="t-body-s text-bad">
            {c.errors === 1 ? "1 row could not be imported:" : `${num(c.errors)} rows could not be imported:`}
          </p>
          <ul className="t-body-s m-0 flex max-h-[200px] list-none flex-col gap-2 overflow-auto p-0">
            {[...groups.entries()].map(([k, rows]) => (
              <li key={k}>
                <span className="text-bad">{k}</span>{" "}
                <span className="font-mono text-muted">
                  {rows.length === 1 ? "row" : "rows"} {rows.slice(0, 12).join(", ")}
                  {rows.length > 12 ? ` +${rows.length - 12}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-8">
        {result.round ? (
          <ButtonLink href={`/w/${wsSlug}/r/${result.round.slug}`} variant="primary">
            View in {result.round.name} →
          </ButtonLink>
        ) : (
          <ButtonLink href={`/w/${wsSlug}/investors`} variant="primary">
            View investors →
          </ButtonLink>
        )}
        {next && result.round ? (
          <ButtonLink href={`/w/${wsSlug}/r/${enc(result.round.slug)}?view=table&stage=${enc(next.stage)}&follow=none`}>
            Set follow-ups for the {num(next.n)} new in {round?.stages.find((s) => s.key === next.stage)?.label ?? next.stage} →
          </ButtonLink>
        ) : null}
        <Button onClick={onAgain}>Import another file</Button>
        <Link href={`/w/${wsSlug}/settings/data`} className="text-accent hover:underline">
          Import history
        </Link>
      </div>
    </section>
  );
}

function PrototypeRounds({
  keys,
  rounds,
  value,
  onChange,
}: {
  keys: string[];
  rounds: Round[];
  value: Record<string, { round: string; fit: string }>;
  onChange: (v: Record<string, { round: string; fit: string }>) => void;
}) {
  if (!keys.length) {
    return (
      <p className="t-body-s text-muted">
        Prototype JSON detected. It has no per-round data, so only the contacts are imported.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-10">
      <p className="t-body-s text-muted">
        Prototype JSON detected. Choose which Raisebook round each prototype round goes to; stages,
        follow-ups, amounts and log entries come along.
      </p>
      {keys.map((k) => {
        const v = value[k] ?? { round: "", fit: "" };
        return (
          <div key={k} className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <Field label={<>Round for <span className="font-mono text-fg">p.{k}</span></>}>
              <Select value={v.round} onChange={(e) => onChange({ ...value, [k]: { ...v, round: e.target.value } })}>
                <option value="">Skip this round</option>
                {rounds.map((r) => (
                  <option key={r.id} value={r.slug}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Fit from">
              <Select
                value={v.fit}
                disabled={!v.round}
                onChange={(e) => onChange({ ...value, [k]: { ...v, fit: e.target.value } })}
              >
                <option value="">No fit</option>
                <option value="qFit">qFit</option>
                <option value="eFit">eFit</option>
              </Select>
            </Field>
          </div>
        );
      })}
    </div>
  );
}

