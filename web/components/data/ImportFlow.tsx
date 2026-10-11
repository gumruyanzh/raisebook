"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

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
  Table,
  TableScroll,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
} from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import {
  CONTACT_FIELDS,
  ROUND_FIELDS,
  ROUND_FIELD_SET,
  detectFormat,
  previewImport,
  prototypeRoundKeys,
  runImport,
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
import { useWorkspace } from "@/lib/session";

type Step = "source" | "columns" | "review" | "done";

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

interface ErrState {
  message: string;
  code?: string;
}

function toErr(e: unknown): ErrState {
  return e instanceof ApiError ? { message: e.message, code: e.code } : { message: errorMessage(e) };
}

/** Import flow (SYSTEM §4.10): 1 Source · 2 Columns · 3 Review, then the result. */
export function ImportFlow({ initialRound }: { initialRound?: string }) {
  const { workspace, rounds, client, canWrite } = useWorkspace();
  const router = useRouter();
  const openFirst = useMemo(
    () => [...rounds].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open")),
    [rounds],
  );

  const [step, setStep] = useState<Step>("source");
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [roundSlug, setRoundSlug] = useState<string>(() =>
    initialRound && rounds.some((r) => r.slug === initialRound) ? initialRound : "",
  );
  const [defaultStage, setDefaultStage] = useState("");
  const [source, setSource] = useState("");
  const [onDuplicate, setOnDuplicate] = useState<OnDuplicate>("skip");
  const [roundMap, setRoundMap] = useState<Record<string, { round: string; fit: string }>>({});
  const [mapping, setMapping] = useState<Record<string, ImportField | null> | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<string | false>(false);
  const [err, setErr] = useState<ErrState | null>(null);

  const format = detectFormat(text);
  const protoKeys = useMemo(() => (format === "prototype_json" ? prototypeRoundKeys(text) : []), [format, text]);
  const round: Round | undefined = rounds.find((r) => r.slug === roundSlug);

  if (!canWrite) {
    return (
      <EmptyState title="Viewers can't import">
        Ask an owner or editor of {workspace.name} to import investors, or to make you an editor.
      </EmptyState>
    );
  }

  const request = (withMapping: boolean): ImportRequest => {
    const base: ImportRequest = {
      format,
      content: text,
      filename,
      on_duplicate: onDuplicate,
      source: source.trim() || null,
      default_stage: defaultStage || null,
    };
    if (format === "csv") {
      return { ...base, round: roundSlug || null, mapping: withMapping ? mapping : null };
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
      const pv = await previewImport(client, request(withMapping));
      setPreview(pv);
      if (!withMapping) setMapping(pv.mapping);
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
    setErr(null);
  };

  return (
    <div className="flex flex-col gap-16">
      <StepLine step={step} skipColumns={format === "prototype_json"} />

      {step === "source" ? (
        <section aria-labelledby="imp-source" className="grid gap-16 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-24">
          <div className="flex min-w-0 flex-col gap-10">
            <SectionLabel id="imp-source">Source</SectionLabel>
            <FileDrop
              prompt="Drop a CSV or prototype JSON file here, or paste below"
              onText={(t, f) => {
                setText(t);
                setFilename(f.name);
                setMapping(null);
              }}
            />
            <Field
              label="Or paste CSV"
              hint={
                text
                  ? `${format === "csv" ? "CSV" : "Prototype JSON"} · ${num(text.split("\n").length)} lines`
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
          </div>

          <div className="flex min-w-0 flex-col gap-14">
            {format === "csv" ? (
              <>
                <Field label="Add to round" hint="Contacts only imports people without putting them on a board.">
                  <Select
                    value={roundSlug}
                    onChange={(e) => {
                      setRoundSlug(e.target.value);
                      setDefaultStage("");
                    }}
                  >
                    <option value="">Contacts only</option>
                    {openFirst.map((r) => (
                      <option key={r.id} value={r.slug}>
                        {r.name}
                        {r.status === "closed" ? " (closed)" : ""}
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
              <PrototypeRounds
                keys={protoKeys}
                rounds={openFirst}
                value={roundMap}
                onChange={setRoundMap}
              />
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
                variant="primary"
                disabled={!text.trim()}
                busy={busy}
                onClick={() => void loadPreview(false, format === "csv" ? "columns" : "review")}
              >
                {format === "csv" ? "Map columns" : "Review"}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {step === "columns" && preview && mapping ? (
        <section aria-labelledby="imp-columns" className="flex flex-col gap-10">
          <SectionLabel
            id="imp-columns"
            aside={<span className="t-micro text-muted">{plural(preview.row_count, "row")} · {preview.columns.length} columns</span>}
          >
            Columns
          </SectionLabel>
          <ColumnTable
            preview={preview}
            mapping={mapping}
            hasRound={!!round}
            onChange={(col, f) => setMapping({ ...mapping, [col]: f })}
          />
          <Warnings items={preview.warnings} />
          <div className="flex flex-wrap gap-8">
            <Button onClick={() => setStep("source")} disabled={!!busy}>
              Back
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void loadPreview(true, "review")}>
              Review
            </Button>
          </div>
        </section>
      ) : null}

      {step === "review" && preview ? (
        <section aria-labelledby="imp-review" className="flex flex-col gap-12">
          <SectionLabel id="imp-review">Review</SectionLabel>
          <CountsStrip preview={preview} roundName={round?.name ?? roundNameFromMap(roundMap, rounds)} />
          <Warnings items={preview.warnings} />
          <RowsTable
            rows={preview.rows}
            rounds={rounds}
            fallbackRound={round}
            currency={round?.currency ?? workspace.default_currency}
          />
          {preview.row_count > preview.rows.length ? (
            <p className="t-micro text-muted">
              Showing the first {num(preview.rows.length)} of {num(preview.row_count)} rows. The counts cover every row.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-8">
            <Button onClick={() => setStep(format === "csv" ? "columns" : "source")} disabled={!!busy}>
              Back
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={importable(preview) === 0}
              onClick={() => void commit()}
            >
              {importLabel(preview)}
            </Button>
          </div>
        </section>
      ) : null}

      {step === "done" && result ? (
        <ResultView result={result} wsSlug={workspace.slug} onAgain={reset} />
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

/** Rows that change something: new or updated investors, or existing ones added to a round. */
function importable(p: ImportPreview): number {
  return p.counts.create + p.counts.update + p.counts.add_to_round;
}

/** "Import 2 new investors, update 1" — says what the click writes, never counts skipped rows. */
function importLabel(p: ImportPreview): string {
  const c = p.counts;
  const parts: string[] = [];
  if (c.create) parts.push(plural(c.create, "new investor"));
  if (c.update) parts.push(`update ${num(c.update)}`);
  if (!parts.length) return c.add_to_round ? `Add ${plural(c.add_to_round, "investor")} to the round` : "Nothing to import";
  return `Import ${parts.join(", ")}`;
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

function ColumnTable({
  preview,
  mapping,
  hasRound,
  onChange,
}: {
  preview: ImportPreview;
  mapping: Record<string, ImportField | null>;
  hasRound: boolean;
  onChange: (col: string, f: ImportField | null) => void;
}) {
  const used = new Map<string, string>();
  for (const [col, f] of Object.entries(mapping)) if (f) used.set(f, col);
  return (
    <TableScroll>
      <Table minWidth={640}>
        <THead>
          <Tr>
            <Th>Column</Th>
            <Th>Sample values</Th>
            <Th>Raisebook field</Th>
          </Tr>
        </THead>
        <TBody>
          {preview.columns.map((col) => {
            const current = mapping[col] ?? null;
            const samples = preview.samples[col] ?? [];
            return (
              <Tr key={col}>
                <Td className="font-medium">{col}</Td>
                <Td className="t-data max-w-[320px] text-muted">
                  {samples.length ? (
                    samples.map((s, i) => (
                      <span key={i} className="block truncate" title={s}>
                        {s}
                      </span>
                    ))
                  ) : (
                    <span>empty</span>
                  )}
                </Td>
                <Td className="w-[240px]">
                  <Select
                    size="sm"
                    aria-label={`Field for ${col}`}
                    value={current ?? ""}
                    onChange={(e) => onChange(col, (e.target.value || null) as ImportField | null)}
                  >
                    <option value="">Ignore</option>
                    <optgroup label="Contact">
                      {CONTACT_FIELDS.map(([f, label]) => (
                        <option key={f} value={f} disabled={used.has(f) && used.get(f) !== col}>
                          {label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={hasRound ? "Round" : "Round (pick a round first)"}>
                      {ROUND_FIELDS.map(([f, label]) => (
                        <option
                          key={f}
                          value={f}
                          disabled={!hasRound || (used.has(f) && used.get(f) !== col)}
                        >
                          {label}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                  {current && ROUND_FIELD_SET.has(current) && !hasRound ? (
                    <span className="t-body-s mt-4 block text-muted">Pick a round first; this column is ignored.</span>
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </TableScroll>
  );
}

function CountsStrip({ preview, roundName }: { preview: ImportPreview; roundName?: string }) {
  const c = preview.counts;
  const items: [string, number, string][] = [
    ["Create", c.create, "text-fg"],
    ["Update", c.update, "text-fg"],
    ["Skip", c.skip, "text-fg"],
    ["Errors", c.error, c.error ? "text-bad" : "text-fg"],
  ];
  if (roundName) items.push([`Add to ${roundName}`, c.add_to_round, "text-fg"]);
  return (
    <p className="t-data flex flex-wrap gap-x-10 gap-y-4 rounded-md border border-line bg-surface px-14 py-10">
      {items.map(([label, n, tone], i) => (
        <span key={label} className="whitespace-nowrap">
          {i > 0 ? <span aria-hidden className="mr-10 text-muted">·</span> : null}
          <span className="text-muted">{label} </span>
          <b className={cn("font-medium", tone)}>{num(n)}</b>
        </span>
      ))}
    </p>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="t-body-s flex flex-col gap-4 text-warm">
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

function RowsTable({
  rows,
  rounds,
  fallbackRound,
  currency,
}: {
  rows: ImportRow[];
  rounds: Round[];
  fallbackRound?: Round;
  currency: string;
}) {
  const stageOf = (roundSlug: string | null | undefined, key: string) => {
    const r = (roundSlug && rounds.find((x) => x.slug === roundSlug)) || fallbackRound;
    return r?.stages.find((s) => s.key === key);
  };
  return (
    <TableScroll maxHeight="60vh">
      <Table minWidth={860}>
        <THead>
          <Tr>
            <Th align="right">Row</Th>
            <Th>Action</Th>
            <Th>Name</Th>
            <Th>Firm</Th>
            <Th>Round</Th>
            <Th>Matched</Th>
            <Th>Notes</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((r) => {
            const p = r.participant;
            return (
              <Tr key={r.row}>
                <Td variant="num">{r.row}</Td>
                <Td>
                  <Chip tone={ACTION_TONE[r.action]}>{ACTION_LABEL[r.action]}</Chip>
                </Td>
                <Td className="font-medium">{String(r.investor.name ?? "") || <span className="text-muted">No name</span>}</Td>
                <Td className="text-muted">{String(r.investor.firm ?? "")}</Td>
                <Td className="t-body-s whitespace-nowrap">
                  {p?.stage ? (
                    <span className="inline-flex items-center gap-6">
                      {(() => {
                        const st = stageOf(p.round, p.stage);
                        return st ? (
                          <StagePill color={st.color} label={st.label} />
                        ) : (
                          <span className="font-mono">{p.stage}</span>
                        );
                      })()}
                      {p.fit != null ? <span className="text-muted">fit {p.fit}</span> : null}
                      {p.amount_committed ? (
                        <Chip tone="money">{moneyCompact(p.amount_committed, currency)}</Chip>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </Td>
                <Td className="t-body-s">
                  {r.match ? (
                    <>
                      {r.match.name}
                      <span className="ml-6 font-mono text-muted">
                        {r.match.investor_id ? "existing" : `row ${r.match.row}`} · {r.match.matched_on.replace("_", "+")}
                      </span>
                    </>
                  ) : null}
                </Td>
                <Td className="t-body-s max-w-[360px]">
                  {r.errors.map((e) => (
                    <span key={e.field + e.message} className="block text-bad">
                      <span className="font-mono">{e.field}</span>: {e.message}
                    </span>
                  ))}
                  {r.warnings.map((w) => (
                    <span key={w} className="block text-muted">
                      {w}
                    </span>
                  ))}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </TableScroll>
  );
}

function ResultView({ result, wsSlug, onAgain }: { result: ImportResult; wsSlug: string; onAgain: () => void }) {
  const c = result.counts;
  const parts = [
    `Imported ${plural(c.created, "new investor")}`,
    c.updated ? `updated ${num(c.updated)}` : null,
    c.skipped ? `skipped ${num(c.skipped)} that ${c.skipped === 1 ? "was" : "were"} already there` : null,
  ].filter(Boolean);
  return (
    <section aria-live="polite" className="flex flex-col gap-12 rounded-md border border-line bg-surface p-16">
      <p className="t-display-xs">{parts.join(", ")}.</p>
      <p className="text-muted">
        {result.round ? (
          <>
            {plural(c.added_to_round, "investor")} added to{" "}
<span className="text-fg">{result.round.name}</span>
            .{" "}
          </>
        ) : null}
        {c.errors ? (
          <span className="text-bad">
            {c.errors === 1 ? "1 row had an error and was left out." : `${num(c.errors)} rows had errors and were left out.`}
          </span>
        ) : null}
      </p>
      {result.errors.length ? (
        <ul className="t-body-s flex max-h-[240px] flex-col gap-2 overflow-auto">
          {result.errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono text-muted">row {e.row}</span> <span className="font-mono">{e.field}</span>:{" "}
              <span className="text-bad">{e.message}</span>
            </li>
          ))}
        </ul>
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
        <Button onClick={onAgain}>Import another file</Button>
        <Link href={`/w/${wsSlug}/settings/data`} className="text-accent hover:underline">
          Import history
        </Link>
      </div>
    </section>
  );
}
