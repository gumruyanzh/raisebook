"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  Button,
  Combobox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  SaveState,
  SectionLabel,
  Segmented,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
  type ComboboxOption,
} from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import {
  listResearchModels,
  removeAiKey,
  saveAiKey,
  updateAiSettings,
  type AiSettings,
  type PresetId,
  type ResearchModel,
  type Run,
} from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { num, relativeTime } from "@/lib/format";
import { useWorkspace } from "@/lib/session";
import { capUsd, formatUsd, modelName } from "@/lib/research";

import { invalidateResearch } from "./hooks";

const KIND_WORD: Record<string, string> = {
  identity: "Identity",
  dossier: "Dossier",
  refresh: "Refresh",
  prefill: "Profile draft",
  agent: "Agent dossier",
};
const STATUS_WORD: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Cancelled",
  capped: "Hit the limit",
  blocked_identity: "Needs a pick",
};

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

/** The month's research spend against the limit: green, warm from 80%, red when used up. */
function SpendMeter({ spent, cap }: { spent: number; cap: number }) {
  const ratio = cap > 0 ? Math.min(1, spent / cap) : spent > 0 ? 1 : 0;
  return (
    <div
      role="meter"
      aria-label="Research spend this month"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={spent}
      aria-valuetext={`${formatUsd(spent)} of ${formatUsd(cap)}`}
      className="h-8 w-full overflow-hidden rounded-pill bg-sunk"
    >
      <i
        className={cn("block h-full not-italic transition-[width] duration-[400ms] ease-out", ratio >= 1 ? "bg-bad" : ratio >= 0.8 ? "bg-warm" : "bg-good")}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

/**
 * Settings → AI research (RESEARCH-PLAN §8.1): what is sent where, the OpenRouter key (owner),
 * the model preset and Advanced ids, the monthly limit with this month's spend, and the last
 * 20 runs.
 */
export function AiResearchSettings({
  settings: s0,
  runs,
  names,
  profileEmpty,
}: {
  settings: AiSettings;
  runs: Run[];
  names: Record<string, string>;
  profileEmpty: boolean;
}) {
  const { workspace, client } = useWorkspace();
  const toast = useToast();
  const [s, setS] = useState(s0);
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const apply = (next: AiSettings) => {
    setS(next);
    invalidateResearch(client);
  };

  /* ---------- key ---------- */
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyErr, setKeyErr] = useState<{ message: string; code?: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const saveKey = async () => {
    setKeyBusy(true);
    setKeyErr(null);
    try {
      apply(await saveAiKey(client, key.trim()));
      setKey("");
      setReplacing(false);
      toast.show("OpenRouter key saved. Only its last 4 characters are kept readable.");
    } catch (e) {
      setKeyErr(e instanceof ApiError ? { message: e.message, code: e.code } : { message: errorMessage(e) });
    } finally {
      setKeyBusy(false);
    }
  };
  const doRemove = async () => {
    setRemoveBusy(true);
    try {
      await removeAiKey(client);
      apply({ ...s, has_key: false, key_status: "none", key_last4: null, key_label: null, key_set_at: null, key_validated_at: null, research_available: false });
      setRemoving(false);
      toast.show("Key removed. Queued research was cancelled.");
    } catch (e) {
      toast.show(errorMessage(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  /* ---------- models ---------- */
  const [modelState, setModelState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [modelErr, setModelErr] = useState<{ message: string; code?: string } | null>(null);
  const patch = async (body: Parameters<typeof updateAiSettings>[1], set = setModelState) => {
    set("saving");
    setModelErr(null);
    try {
      apply(await updateAiSettings(client, body));
      set("saved");
      return true;
    } catch (e) {
      set("error");
      setModelErr(e instanceof ApiError ? { message: e.message, code: e.code } : { message: errorMessage(e) });
      return false;
    }
  };
  const [models, setModels] = useState<ResearchModel[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const loadModels = () => {
    if (models || modelsErr) return;
    listResearchModels(client)
      .then((r) => setModels(r.data))
      .catch((e) => setModelsErr(errorMessage(e)));
  };
  const options = useMemo<ComboboxOption<string>[]>(
    () =>
      (models ?? []).map((m) => ({
        value: m.id,
        label: m.id,
        description: m.name,
        hint: `$${m.prompt_per_mtok_usd.toFixed(2)} / $${m.completion_per_mtok_usd.toFixed(2)}`,
        keywords: [m.name],
      })),
    [models],
  );

  /* ---------- cap ---------- */
  const [cap, setCap] = useState(String(s.monthly_cap_usd));
  const [capState, setCapState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => setCap(String(s.monthly_cap_usd)), [s.monthly_cap_usd]);
  const capValue = Number(cap.replace(/[$,\s]/g, ""));
  const capOk = cap.trim() !== "" && Number.isFinite(capValue) && capValue >= 0 && capValue <= 10_000;
  const capDirty = capOk && Math.round(capValue * 100) !== Math.round(s.monthly_cap_usd * 100);

  const u = s.usage;
  const used = u.spent_usd + u.reserved_usd;
  const presetOptions = s.presets.map((p) => ({
    value: p.id,
    label: (
      <span className="inline-flex items-baseline gap-6">
        {p.label}
        {p.dossier_usd !== null ? <span className={cn("font-mono text-[11.5px]", s.preset === p.id ? "text-canvas" : "text-muted")}>≈ {formatUsd(p.dossier_usd)}</span> : null}
      </span>
    ),
    disabled: !s.can_edit,
  }));
  const current = s.presets.find((p) => p.id === s.preset);

  if (!s.kek_configured) {
    return (
      <div className="flex flex-col gap-24">
        <Statement />
        <EmptyState title="Research is not set up on this server">
          Research keeps your OpenRouter key encrypted with a server key (<span className="font-mono">RAISEBOOK_SECRETS_KEK</span>), and this
          server has none. Whoever runs it can add one; the self-hosting guide says how. Agents can still save dossiers with{" "}
          <span className="font-mono">save_dossier</span>.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-28">
      <Statement />

      {/* ---------- the key ---------- */}
      <section aria-labelledby="ai-key">
        <SectionLabel id="ai-key">OpenRouter key</SectionLabel>
        {s.has_key && !replacing ? (
          <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
            <p className="min-w-0">
              {s.key_status === "unreadable" ? (
                <span className="text-bad">The saved key can no longer be read (the server key changed). Save it again.</span>
              ) : (
                <>
                  Key ending <span className="font-mono">••••{s.key_last4}</span>
                  {s.key_label ? <span className="text-muted"> · {s.key_label}</span> : null}
                  {s.key_validated_at ? (
                    <span className="t-micro ml-8 text-muted" title={s.key_validated_at}>
                      checked {relativeTime(s.key_validated_at, new Date(), workspace.timezone)}
                    </span>
                  ) : null}
                </>
              )}
            </p>
            {s.can_manage_key ? (
              <span className="flex gap-8">
                <Button size="sm" onClick={() => setReplacing(true)}>
                  Replace
                </Button>
                <Button size="sm" variant="danger-quiet" onClick={() => setRemoving(true)}>
                  Remove key
                </Button>
              </span>
            ) : null}
          </div>
        ) : s.can_manage_key ? (
          <form
            className="flex max-w-[560px] flex-col gap-8"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void saveKey();
            }}
          >
            <Field
              label="Your OpenRouter key"
              hint={
                <>
                  Create one at openrouter.ai under Keys, with a credit limit if you like. Raisebook checks it with OpenRouter, stores it
                  encrypted and never shows it again.
                </>
              }
              error={keyErr}
            >
              <Input type="password" mono autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
            <div className="flex gap-8">
              <Button type="submit" variant="primary" disabled={!key.trim()} busy={keyBusy ? "Checking with OpenRouter…" : false}>
                Save key
              </Button>
              {replacing ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setReplacing(false);
                    setKey("");
                    setKeyErr(null);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <p className="text-muted">No key yet. The workspace owner adds it here, signed in on the web.</p>
        )}
      </section>

      {/* ---------- models ---------- */}
      <section aria-labelledby="ai-models">
        <SectionLabel id="ai-models" aside={<SaveState state={modelState} />}>
          Models
        </SectionLabel>
        <div className="flex flex-wrap items-center gap-12">
          <Segmented<PresetId | "custom">
            label="Model preset"
            value={s.preset}
            onChange={(v) => v !== "custom" && void patch({ preset: v })}
            options={presetOptions}
          />
          <span className="t-body-s text-muted">per dossier</span>
        </div>
        <p className="t-body-s mt-8 max-w-[68ch] text-muted">
          {s.preset === "custom" ? (
            <>Custom models (set under Advanced). </>
          ) : current ? (
            <>
              {modelName(current.search_model)} searches, {modelName(current.writer_model)} writes.{" "}
            </>
          ) : null}
          Finding who someone is always uses the cheap search model ({approx(s.estimates.identity)} each). Prices are OpenRouter&apos;s; the
          real cost of every run is recorded.
        </p>
        <details className="group mt-10" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadModels()}>
          <summary className="link t-body-s inline-flex cursor-pointer list-none items-center gap-6 [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="group-open:hidden">
              →
            </span>
            <span aria-hidden className="hidden group-open:inline">
              ↓
            </span>
            Advanced: pick each model
          </summary>
          <div className="mt-10 grid max-w-[720px] grid-cols-1 gap-12 sm:grid-cols-3">
            {(
              [
                ["identity_model", "Identity (search)", s.identity_model],
                ["search_model", "Search", s.search_model],
                ["writer_model", "Writer (needs JSON output)", s.writer_model],
              ] as const
            ).map(([field, label, value]) => (
              <Field key={field} label={label}>
                <Combobox<string>
                  value={value}
                  disabled={!s.can_edit}
                  options={
                    models
                      ? options.map((o) => ({
                          ...o,
                          disabled: field === "writer_model" ? !models.find((m) => m.id === o.value)?.supports_structured : false,
                          description:
                            field === "writer_model" && !models.find((m) => m.id === o.value)?.supports_structured ? "no JSON output" : o.description,
                        }))
                      : [{ value, label: value }]
                  }
                  onOpen={loadModels}
                  renderValue={(o) => <span className="truncate font-mono text-[12.5px]">{o?.value ?? value}</span>}
                  searchPlaceholder="Search OpenRouter models"
                  emptyText={() => (modelsErr ? modelsErr : models ? "No model matches." : "Loading models…")}
                  onChange={(v) => v && v !== value && void patch({ [field]: v })}
                  popoverMinWidth={420}
                />
              </Field>
            ))}
          </div>
          <p className="t-micro mt-6 text-muted">Prices are per million tokens in / out. Raisebook checks each id with OpenRouter when you save.</p>
        </details>
        {modelErr ? (
          <p className="t-body-s mt-8 text-bad">
            {modelErr.message} {modelErr.code ? <span className="font-mono text-micro">{modelErr.code}</span> : null}
          </p>
        ) : null}
      </section>

      {/* ---------- monthly limit ---------- */}
      <section aria-labelledby="ai-cap">
        <SectionLabel id="ai-cap" aside={<SaveState state={capState} />}>
          Monthly limit
        </SectionLabel>
        <div className="flex max-w-[560px] flex-col gap-8">
          <SpendMeter spent={used} cap={s.monthly_cap_usd} />
          <p className="t-body-s text-muted">
            <span className="font-mono text-fg">{formatUsd(u.spent_usd)}</span> of <span className="font-mono text-fg">{formatUsd(s.monthly_cap_usd)}</span>{" "}
            used in {monthName(u.month)} · {num(u.calls)} {u.calls === 1 ? "call" : "calls"}
            {u.reserved_usd > 0 ? ` · ${formatUsd(u.reserved_usd)} held for runs in progress` : ""}
          </p>
          {used >= s.monthly_cap_usd && s.monthly_cap_usd > 0 ? (
            <p className="t-body-s text-bad" role="status">
              The limit is used up: new research waits until {monthName(nextMonth(u.month))}, or until you raise it.
            </p>
          ) : null}
          {s.can_edit ? (
            <form
              className="flex items-end gap-8"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!capDirty) return;
                setModelErr(null);
                await patch({ monthly_cap_usd: Math.round(capValue * 100) / 100 }, setCapState);
              }}
            >
              <Field label="Stop research after (USD per month)" className="w-[240px]">
                <Input mono inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} aria-invalid={!capOk || undefined} />
              </Field>
              <Button type="submit" disabled={!capDirty}>
                Save limit
              </Button>
            </form>
          ) : null}
          {s.can_edit ? (
            <p className="t-body-s text-muted">Runs stop cleanly when they reach it and can be resumed after you raise it or the month turns.</p>
          ) : (
            <p className="t-body-s text-muted">Owners change the limit ({capUsd(s.monthly_cap_usd)} now).</p>
          )}
        </div>
      </section>

      {profileEmpty ? (
        <p className="t-body-s -mt-8 text-muted">
          <Link className="link" href={`${base}/settings/company`}>
            Add your company profile
          </Link>{" "}
          so dossiers can judge fit and suggest talking points.
        </p>
      ) : null}

      {/* ---------- usage ---------- */}
      <section aria-labelledby="ai-runs">
        <SectionLabel id="ai-runs">Recent runs</SectionLabel>
        {runs.length === 0 ? (
          <p className="t-body-s text-muted">No research yet. Open an investor and press Research on the Dossier tab, or match identities in bulk from a round.</p>
        ) : (
          <TableScroll>
            <Table className="min-w-[560px]">
              <THead>
                <Tr>
                  <Th>Investor</Th>
                  <Th>Kind</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">When</Th>
                </Tr>
              </THead>
              <TBody>
                {runs.map((r) => (
                  <Tr key={r.id} className="[&>td]:align-middle!">
                    <Td className="font-medium">
                      {r.investor_id ? (
                        <Link href={`${base}/investors/${r.investor_id}#dossier`} className="hover:underline">
                          {names[r.investor_id] ?? "Investor"}
                        </Link>
                      ) : (
                        <span className="text-muted">Company profile</span>
                      )}
                    </Td>
                    <Td variant="muted">{KIND_WORD[r.kind] ?? r.kind}</Td>
                    <Td className={cn(r.status === "failed" || r.status === "capped" ? "text-bad" : r.status === "succeeded" ? "text-fg" : "text-muted")}>
                      {STATUS_WORD[r.status] ?? r.status}
                    </Td>
                    <Td variant="num" className="text-right">
                      {r.cost_usd ? formatUsd(r.cost_usd) : "—"}
                    </Td>
                    <Td className="t-data text-right whitespace-nowrap text-muted" title={r.created_at}>
                      {relativeTime(r.created_at, new Date(), workspace.timezone)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </section>

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={doRemove}
        busy={removeBusy}
        busyLabel="Removing…"
        title="Remove the OpenRouter key?"
        confirmLabel="Remove key"
      >
        <p>It is deleted now. Research that is queued is cancelled; dossiers you already have stay.</p>
      </ConfirmDialog>
    </div>
  );
}

function approx(n: number | null): string {
  return n === null ? "a cent or two" : `≈ ${formatUsd(n)}`;
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The plain statement (R6, R12): what is sent, to whom, and who pays. */
function Statement() {
  return (
    <section aria-label="How research works" className="max-w-[72ch]">
      <p>
        Research runs on <b className="font-semibold">your own OpenRouter key</b>, only when someone presses Research. When you research an
        investor, Raisebook sends their name, firm, title and links, your company profile and the round&apos;s terms (and your deck, when you
        prefill the profile) to OpenRouter and the models below. Raisebook never pays for model calls and sees nothing beyond the cost
        OpenRouter reports.
      </p>
      <p className="t-body-s mt-6 text-muted">
        Dossiers hold professional information only, every claim links to its source, and they stay private to this workspace.{" "}
        <Link href="/research-policy" className="link">
          Research Policy
        </Link>
      </p>
    </section>
  );
}
