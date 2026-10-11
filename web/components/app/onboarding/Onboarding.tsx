"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, Field, Input, Select, Wordmark } from "@/components/ui";
import { api, ApiError, errorMessage, setCsrfToken } from "@/lib/api/client";
import { createWorkspace, type Workspace } from "@/lib/api/core";
import { createRound } from "@/lib/api/rounds";
import { cn } from "@/lib/cn";

import { draftFromRound, roundBody, RoundFields, type RoundDraft } from "../RoundForm";

const DEFAULT_STAGES = "New → Researching → Contacted → Replied → Meeting → Diligence → Committed → Passed";

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  } catch {
    return ["UTC"];
  }
}

const enc = encodeURIComponent;

/**
 * Onboarding (SYSTEM §4.11): 1 company → 2 first round → 3 how to bring investors in. The
 * step and the new workspace live in the URL (`?ws=<slug>&round=<slug>`) so a reload resumes.
 */
export function Onboarding({ csrf, workspaces }: { csrf: string; workspaces: Workspace[] }) {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => setCsrfToken(csrf), [csrf]);

  const wsSlug = params.get("ws");
  const roundSlug = params.get("round");
  const ws = workspaces.find((w) => w.slug === wsSlug) ?? null;
  const step = !wsSlug ? 1 : !roundSlug ? 2 : 3;

  const [company, setCompany] = useState("");
  const [tz, setTz] = useState("UTC");
  const tzs = useMemo(zones, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [draft, setDraft] = useState<RoundDraft>(() => draftFromRound(null, ws?.default_currency ?? "USD"));
  const [errors, setErrors] = useState<Partial<Record<keyof RoundDraft, string>>>({});
  const [sampleBusy, setSampleBusy] = useState(false);

  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setTz("UTC");
    }
  }, []);

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: errorMessage(err) });

  const createWs = async () => {
    if (!company.trim()) return setError({ message: "Enter your company's name." });
    setBusy(true);
    setError(null);
    try {
      const w = await createWorkspace(api, { name: company.trim(), timezone: tz });
      router.replace(`/onboarding?ws=${enc(w.slug)}`);
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const createFirstRound = async () => {
    if (!wsSlug) return;
    const { body, errors: errs } = roundBody(draft);
    setErrors(errs);
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createRound(api.ws(wsSlug), body);
      router.replace(`/onboarding?ws=${enc(wsSlug)}&round=${enc(r.slug)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate") {
        const existing = (err.details as { existing?: { slug?: string } } | undefined)?.existing;
        if (existing?.slug) {
          router.replace(`/onboarding?ws=${enc(wsSlug)}&round=${enc(existing.slug)}`);
          return;
        }
      }
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const openSample = async () => {
    setSampleBusy(true);
    setError(null);
    try {
      const existing = workspaces.find((w) => w.is_sandbox);
      const w = existing ?? (await createWorkspace(api, { name: "Kestrel Robotics (sample)", sample: true }));
      router.push(`/w/${enc(w.slug)}`);
      router.refresh();
    } catch (err) {
      fail(err);
      setSampleBusy(false);
    }
  };

  const base = wsSlug ? `/w/${enc(wsSlug)}` : "";
  const options = roundSlug
    ? [
        {
          title: "Import a spreadsheet",
          body: "Bring the list you already have. Columns are matched for you, duplicates are caught, and you preview before anything is written.",
          href: `${base}/import?round=${enc(roundSlug)}`,
          cta: "Import CSV →",
        },
        {
          title: "Add them as you go",
          body: "Start with an empty board and add investors one at a time as you research and reach out.",
          href: `${base}/r/${enc(roundSlug)}`,
          cta: "Open the pipeline →",
        },
        {
          title: "Connect your agent first",
          body: "Give Claude Code, Codex or Cursor a key and let it import, log and set follow-ups with you. Everything it does shows on the timeline.",
          href: `${base}/settings/mcp`,
          cta: "Connect an agent →",
        },
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-flow pt-24 pb-48">
      <div className="mb-40 flex items-center">
        <Wordmark size={20} href="/" />
        <span className="t-micro ml-auto text-muted" aria-label={`Step ${step} of 3`}>
          {step} / 3
        </span>
      </div>

      {step === 1 ? (
        <form
          className="flex flex-col gap-16"
          onSubmit={(e) => {
            e.preventDefault();
            void createWs();
          }}
        >
          <div>
            <h1 className="t-display-m">What are you raising for?</h1>
            <p className="mt-6 text-muted">Your company gets its own private workspace. Co-founders can join it later.</p>
          </div>
          <Field label="Company name" error={error ? { message: error.message, code: error.code } : null}>
            <Input autoFocus value={company} maxLength={80} onChange={(e) => setCompany(e.target.value)} placeholder="Kestrel Robotics" />
          </Field>
          <Field label="Timezone" hint="Follow-ups are due by this calendar.">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>
              {(tzs.includes(tz) ? tzs : [tz, ...tzs]).map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" size="lg" busy={busy ? "Creating…" : false} className="self-start">
            Continue
          </Button>
        </form>
      ) : step === 2 ? (
        <form
          className="flex flex-col gap-16"
          onSubmit={(e) => {
            e.preventDefault();
            void createFirstRound();
          }}
        >
          <div>
            <h1 className="t-display-m">Your round</h1>
            <p className="mt-6 text-muted">{ws ? `${ws.name}'s first round.` : "The round you're raising now."} Everything here can change later.</p>
          </div>
          <RoundFields draft={draft} onChange={setDraft} errors={errors} hint={<>You can change stages later. We start you with {DEFAULT_STAGES}.</>} />
          {error ? (
            <p className="t-body-s text-bad">
              {error.message}
              {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-12">
            <Button type="submit" variant="primary" size="lg" busy={busy ? "Creating…" : false}>
              Create round
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-16">
          <div>
            <h1 className="t-display-m">Bring your investors</h1>
            <p className="mt-6 text-muted">Pick a way to start. You can do all three.</p>
          </div>
          <ul className="m-0 list-none border-t border-line p-0">
            {options.map((o) => (
              <li key={o.title} className="border-b border-line">
                <Link href={o.href} className="group flex flex-col gap-4 py-16 pr-8">
                  <span className="t-display-xs group-hover:text-accent">{o.title}</span>
                  <span className="text-muted">{o.body}</span>
                  <span className="link t-body-s mt-2">{o.cta}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className={cn("t-body-s mt-40 text-muted", step === 3 && "mt-24")}>
        Just looking?{" "}
        <button type="button" className="link border-0 bg-transparent p-0" onClick={() => void openSample()} disabled={sampleBusy}>
          {sampleBusy ? "Opening the sample…" : "Open a sample workspace with fictional investors."}
        </button>
      </p>
      {step === 3 && error ? <p className="t-body-s mt-8 text-bad">{error.message}</p> : null}
    </div>
  );
}
