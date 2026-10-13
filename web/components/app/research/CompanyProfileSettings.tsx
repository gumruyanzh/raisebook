"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, type ReactElement } from "react";

import { Button, Field, FileDrop, Input, SaveState, SectionLabel, Segmented, Select, Textarea } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import {
  prefillCompanyProfile,
  putCompanyProfile,
  type AiSettings,
  type CompanyProfile,
  type CompanyProfileFields,
  type CompanyStage,
  type Run,
  type WantsLead,
} from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { currencySymbol } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { moneyInput, parseMoney } from "../util";
import { invalidateResearch, useRunPoll } from "./hooks";
import { ResearchError } from "./ResearchError";
import { RunProgress } from "./RunProgress";

const STAGES: { value: CompanyStage; label: string }[] = [
  { value: "pre-seed", label: "Pre-seed" },
  { value: "seed", label: "Seed" },
  { value: "series-a", label: "Series A" },
  { value: "series-b+", label: "Series B or later" },
  { value: "other", label: "Other" },
];

type FieldKey = keyof CompanyProfileFields;

interface Form {
  pitch: string;
  sectors: string[];
  stage: CompanyStage | "";
  location: string;
  traction: [string, string, string];
  wants_lead: WantsLead | "";
  check_min: string;
  check_max: string;
  strategic_help: string;
  website_url: string;
}

function toForm(p: CompanyProfileFields): Form {
  return {
    pitch: p.pitch ?? "",
    sectors: [...p.sectors],
    stage: p.stage ?? "",
    location: p.location ?? "",
    traction: [p.traction[0] ?? "", p.traction[1] ?? "", p.traction[2] ?? ""],
    wants_lead: p.wants_lead ?? "",
    check_min: moneyInput(p.check_min),
    check_max: moneyInput(p.check_max),
    strategic_help: p.strategic_help ?? "",
    website_url: p.website_url ?? "",
  };
}

function toBody(f: Form): CompanyProfileFields {
  const lo = parseMoney(f.check_min);
  const hi = parseMoney(f.check_max);
  const t = (v: string) => (v.trim() ? v.trim() : null);
  return {
    pitch: t(f.pitch),
    sectors: f.sectors.map((s) => s.trim()).filter(Boolean),
    stage: f.stage || null,
    location: t(f.location),
    traction: f.traction.map((x) => x.trim()).filter(Boolean),
    wants_lead: f.wants_lead || null,
    check_min: lo !== null && !Number.isNaN(lo) ? lo : null,
    check_max: hi !== null && !Number.isNaN(hi) ? hi : null,
    strategic_help: t(f.strategic_help),
    website_url: t(f.website_url),
  };
}

/** The draft's non-empty fields, merged over the form; returns the fields it changed. */
function mergeDraft(form: Form, draft: Partial<CompanyProfileFields>): { form: Form; changed: Set<FieldKey> } {
  const next = { ...form, traction: [...form.traction] as Form["traction"], sectors: [...form.sectors] };
  const changed = new Set<FieldKey>();
  const take = (k: FieldKey, apply: () => boolean) => {
    if (apply()) changed.add(k);
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  take("pitch", () => (str(draft.pitch) && str(draft.pitch) !== form.pitch ? ((next.pitch = str(draft.pitch)!), true) : false));
  take("location", () => (str(draft.location) && str(draft.location) !== form.location ? ((next.location = str(draft.location)!), true) : false));
  take("strategic_help", () =>
    str(draft.strategic_help) && str(draft.strategic_help) !== form.strategic_help ? ((next.strategic_help = str(draft.strategic_help)!), true) : false,
  );
  take("stage", () => (draft.stage && draft.stage !== form.stage ? ((next.stage = draft.stage), true) : false));
  take("wants_lead", () => (draft.wants_lead && draft.wants_lead !== form.wants_lead ? ((next.wants_lead = draft.wants_lead), true) : false));
  take("sectors", () => {
    const add = (draft.sectors ?? []).filter((s) => !form.sectors.some((x) => x.toLowerCase() === s.toLowerCase()));
    if (!add.length) return false;
    next.sectors = [...form.sectors, ...add].slice(0, 10);
    return true;
  });
  take("traction", () => {
    const lines = (draft.traction ?? []).filter(Boolean).slice(0, 3);
    if (!lines.length || lines.join("|") === form.traction.filter(Boolean).join("|")) return false;
    next.traction = [lines[0] ?? "", lines[1] ?? "", lines[2] ?? ""];
    return true;
  });
  take("check_min", () => (typeof draft.check_min === "number" && moneyInput(draft.check_min) !== form.check_min ? ((next.check_min = moneyInput(draft.check_min)), true) : false));
  take("check_max", () => (typeof draft.check_max === "number" && moneyInput(draft.check_max) !== form.check_max ? ((next.check_max = moneyInput(draft.check_max)), true) : false));
  return { form: next, changed };
}

/** A label with a quiet "drafted" mark while the field holds an unsaved draft value. */
function Drafted({ label, on }: { label: string; on: boolean }) {
  return (
    <>
      {label}
      {on ? <span className="ml-6 font-mono text-[11px] text-accent">drafted</span> : null}
    </>
  );
}

/**
 * Settings → Company profile (R6; RESEARCH-PLAN §8.2): what you are and what you want from
 * investors. Rounds inherit it; research uses it for Fit and Talking points. A prefill from
 * your website or deck fills the form as an unsaved draft for you to review.
 */
export function CompanyProfileSettings({ profile: p0, ai }: { profile: CompanyProfile; ai: AiSettings | null }) {
  const { workspace, client, canWrite } = useWorkspace();
  const [saved, setSaved] = useState(p0);
  const [form, setForm] = useState<Form>(() => toForm(p0));
  const [drafted, setDrafted] = useState<Set<FieldKey>>(new Set());
  const [draftFrom, setDraftFrom] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<ApiError | string | null>(null);
  const [sectorText, setSectorText] = useState("");
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  const cur = currencySymbol(p0.currency);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setState("idle");
  };
  const dirty = useMemo(() => JSON.stringify(toBody(form)) !== JSON.stringify(toBody(toForm(saved))), [form, saved]);
  const lo = parseMoney(form.check_min);
  const hi = parseMoney(form.check_max);
  const moneyErr =
    (lo !== null && Number.isNaN(lo)) || (hi !== null && Number.isNaN(hi))
      ? "Write amounts like 250k or 1,000,000."
      : lo !== null && hi !== null && !Number.isNaN(lo) && !Number.isNaN(hi) && lo > hi
        ? "The smallest check is larger than the largest."
        : null;

  const save = async () => {
    setState("saving");
    setErr(null);
    try {
      const next = await putCompanyProfile(client, toBody(form));
      setSaved(next);
      setForm(toForm(next));
      setDrafted(new Set());
      setDraftFrom(null);
      setState("saved");
      invalidateResearch(client);
    } catch (e) {
      setState("error");
      setErr(e instanceof ApiError ? e : errorMessage(e));
    }
  };

  /* ---------- prefill ---------- */
  const [site, setSite] = useState(p0.website_url ?? "");
  const [deck, setDeck] = useState<File | null>(null);
  const [startErr, setStartErr] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [run0, setRun0] = useState<Run | null>(null);
  const onDone = useCallback(
    (r: Run) => {
      const draft = (r.result?.draft ?? null) as Partial<CompanyProfileFields> | null;
      if (!draft) return;
      setForm((f) => {
        const m = mergeDraft(f, draft);
        setDrafted(m.changed);
        return m.form;
      });
      const from = [r.result?.deck_filename ? "your deck" : null, typeof r.result?.website_url === "string" ? String(r.result.website_url).replace(/^https?:\/\//, "") : null]
        .filter(Boolean)
        .join(" and ");
      setDraftFrom(from || "your material");
      invalidateResearch(client);
    },
    [client],
  );
  const run = useRunPoll(client, run0, onDone);
  const startPrefill = async () => {
    setStarting(true);
    setStartErr(null);
    try {
      const r = await prefillCompanyProfile(client, { websiteUrl: site, deck, deckName: deck?.name });
      setRun0(r.run);
    } catch (e) {
      setStartErr(e);
    } finally {
      setStarting(false);
    }
  };
  const available = Boolean(ai?.research_available);

  const fieldCls = (k: FieldKey) => cn(drafted.has(k) && "[&_input]:border-accent [&_textarea]:border-accent [&_select]:border-accent");
  const wrap = (k: FieldKey, el: ReactElement) => <div className={fieldCls(k)}>{el}</div>;
  const ro = !canWrite;

  return (
    <div className="flex flex-col gap-28">
      <p className="max-w-[72ch]">
        What you are building and what you want from investors. Every round in {workspace.name} uses it, and research needs it to judge
        fit and to suggest which part of your story to lead with.
      </p>

      {/* ---------- prefill ---------- */}
      <section aria-labelledby="cp-prefill" className="max-w-[640px]">
        <SectionLabel id="cp-prefill">Draft it from your website or deck</SectionLabel>
        {available ? (
          <div className="flex flex-col gap-10">
            <Field label="Website" optional>
              <Input type="url" inputMode="url" placeholder="https://yourcompany.com" value={site} onChange={(e) => setSite(e.target.value)} disabled={ro} />
            </Field>
            <FileDrop
              accept=".pdf,application/pdf"
              maxBytes={10 * 1024 * 1024}
              prompt="Drop your deck (PDF, up to 10 MB), or"
              onFile={setDeck}
              disabled={ro}
              className="py-16"
            />
            <div className="flex flex-wrap items-center gap-10">
              <Button
                disabled={ro || (!site.trim() && !deck) || Boolean(run && (run.status === "queued" || run.status === "running"))}
                busy={starting ? "Starting…" : false}
                onClick={() => void startPrefill()}
              >
                Draft the profile
              </Button>
              {deck ? (
                <button type="button" className="link t-body-s border-0 bg-transparent p-0" onClick={() => setDeck(null)}>
                  Don&apos;t send the deck
                </button>
              ) : null}
            </div>
            {run ? <RunProgress run={run} client={client} wsSlug={workspace.slug} canWrite={canWrite} onChange={setRun0} compact /> : null}
            {startErr ? <ResearchError error={startErr} wsSlug={workspace.slug} /> : null}
            <p className="t-body-s text-muted">
              Your deck and website are sent to the AI provider through your OpenRouter key and not kept by Raisebook. Nothing is saved until
              you press Save.
            </p>
          </div>
        ) : (
          <p className="t-body-s text-muted">
            Drafting needs an OpenRouter key.{" "}
            <Link href={`${base}/settings/ai`} className="link">
              Set one up in AI research
            </Link>
            , or fill the form by hand.
          </p>
        )}
      </section>

      {/* ---------- the form ---------- */}
      <form
        className="flex max-w-[640px] flex-col gap-14"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !moneyErr && canWrite) void save();
        }}
      >
        <SectionLabel aside={<SaveState state={state} />}>Profile</SectionLabel>
        {draftFrom && drafted.size ? (
          <p className="t-body-s -mt-6 border-l-2 border-accent pl-10 text-fg" role="status">
            Drafted from {draftFrom}: {drafted.size} {drafted.size === 1 ? "field" : "fields"} changed. Review them and save.
          </p>
        ) : null}
        {wrap(
          "pitch",
          <Field label={<Drafted label="One-line pitch" on={drafted.has("pitch")} />}>
            <Input maxLength={200} value={form.pitch} onChange={(e) => set("pitch", e.target.value)} disabled={ro} placeholder="Autonomous forklifts for mid-size warehouses" />
          </Field>,
        )}
        <div className={cn("flex flex-col gap-4", fieldCls("sectors"))}>
          <label htmlFor="cp-sectors" className="text-[12px] text-muted">
            <Drafted label="Sectors" on={drafted.has("sectors")} />
          </label>
          <div className="flex min-h-32 flex-wrap items-center gap-4 rounded-sm border border-line bg-canvas px-6 py-3 focus-within:border-accent">
            {form.sectors.map((s, i) => (
              <span key={`${s}-${i}`} className="t-chip inline-flex items-center gap-4 rounded-pill bg-sunk px-7 text-muted">
                {s}
                {ro ? null : (
                  <button type="button" aria-label={`Remove ${s}`} className="border-0 bg-transparent p-0 text-muted hover:text-fg" onClick={() => set("sectors", form.sectors.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </span>
            ))}
            <input
              id="cp-sectors"
              className="h-24 min-w-[120px] flex-1 border-0 bg-transparent text-fg outline-none placeholder:text-faint"
              placeholder={form.sectors.length ? "" : "Robotics, logistics… (Enter adds one)"}
              value={sectorText}
              disabled={ro || form.sectors.length >= 10}
              onChange={(e) => setSectorText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === ",") && sectorText.trim()) {
                  e.preventDefault();
                  set("sectors", [...form.sectors, sectorText.trim().slice(0, 60)]);
                  setSectorText("");
                } else if (e.key === "Backspace" && !sectorText && form.sectors.length) {
                  set("sectors", form.sectors.slice(0, -1));
                }
              }}
              onBlur={() => {
                if (sectorText.trim()) {
                  set("sectors", [...form.sectors, sectorText.trim().slice(0, 60)]);
                  setSectorText("");
                }
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-14 sm:grid-cols-2">
          {wrap(
            "stage",
            <Field label={<Drafted label="Company stage" on={drafted.has("stage")} />}>
              <Select value={form.stage} onChange={(e) => set("stage", e.target.value as CompanyStage | "")} disabled={ro}>
                <option value="">Not set</option>
                {STAGES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>,
          )}
          {wrap(
            "location",
            <Field label={<Drafted label="Location" on={drafted.has("location")} />}>
              <Input maxLength={200} value={form.location} onChange={(e) => set("location", e.target.value)} disabled={ro} placeholder="Oakland, CA" />
            </Field>,
          )}
        </div>
        <div className={cn("flex flex-col gap-4", fieldCls("traction"))}>
          <span className="text-[12px] text-muted">
            <Drafted label="Traction (up to three lines)" on={drafted.has("traction")} />
          </span>
          {form.traction.map((t, i) => (
            <Input
              key={i}
              aria-label={`Traction line ${i + 1}`}
              maxLength={200}
              value={t}
              disabled={ro}
              placeholder={["3 paid pilots", "$40k MRR, up 20% a month", "Two warehouse chains on the waitlist"][i]}
              onChange={(e) => {
                const next = [...form.traction] as Form["traction"];
                next[i] = e.target.value;
                set("traction", next);
              }}
            />
          ))}
        </div>
        <div className={cn("flex flex-col gap-4", fieldCls("wants_lead"))}>
          <span className="text-[12px] text-muted">
            <Drafted label="From this raise you want" on={drafted.has("wants_lead")} />
          </span>
          <Segmented<WantsLead | "">
            className="self-start"
            label="Lead or follow"
            value={form.wants_lead}
            onChange={(v) => !ro && set("wants_lead", v)}
            options={[
              { value: "lead", label: "A lead" },
              { value: "follow", label: "Followers" },
              { value: "either", label: "Either" },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-14">
          {wrap(
            "check_min",
            <Field label={<Drafted label={`Smallest check (${cur})`} on={drafted.has("check_min")} />} error={moneyErr}>
              <Input mono inputMode="decimal" value={form.check_min} onChange={(e) => set("check_min", e.target.value)} disabled={ro} placeholder="250k" />
            </Field>,
          )}
          {wrap(
            "check_max",
            <Field label={<Drafted label={`Largest check (${cur})`} on={drafted.has("check_max")} />}>
              <Input mono inputMode="decimal" value={form.check_max} onChange={(e) => set("check_max", e.target.value)} disabled={ro} placeholder="1M" />
            </Field>,
          )}
        </div>
        {wrap(
          "strategic_help",
          <Field label={<Drafted label="Help you want beyond money" on={drafted.has("strategic_help")} />} optional>
            <Textarea maxLength={500} value={form.strategic_help} onChange={(e) => set("strategic_help", e.target.value)} disabled={ro} className="min-h-72" placeholder="Intros to 3PL operators; hiring a VP of Sales" />
          </Field>,
        )}
        {err ? (
          <p className="t-body-s text-bad" role="alert">
            {typeof err === "string" ? err : err.message} {typeof err === "string" ? null : <span className="font-mono text-micro">{err.code}</span>}
          </p>
        ) : null}
        {canWrite ? (
          <div className="flex items-center gap-10">
            <Button type="submit" variant="primary" disabled={!dirty || Boolean(moneyErr)} busy={state === "saving" ? "Saving…" : false}>
              Save profile
            </Button>
            {dirty ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setForm(toForm(saved));
                  setDrafted(new Set());
                  setDraftFrom(null);
                }}
              >
                Discard changes
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="t-body-s text-muted">View only. Editors and owners change the profile.</p>
        )}
      </form>
    </div>
  );
}
