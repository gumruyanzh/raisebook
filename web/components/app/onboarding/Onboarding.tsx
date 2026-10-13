"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, ButtonLink, CurrencyPicker, Field, Input, TimezonePicker, Wordmark } from "@/components/ui";
import { api, ApiError, errorMessage, setCsrfToken } from "@/lib/api/client";
import { createWorkspace, updateMe, updateWorkspace, type Workspace, type WorkspaceUpdate } from "@/lib/api/core";
import { createRound, getRound, updateRound } from "@/lib/api/rounds";
import { cn } from "@/lib/cn";
import { guessCurrency } from "@/lib/currency";
import { browserTimeZone, canonicalZone, loadZoneData } from "@/lib/tz";

import { draftFromRound, roundBody, RoundFields, type RoundDraft } from "../RoundForm";

const DEFAULT_STAGES = "New → Researching → Contacted → Replied → Meeting → Diligence → Committed → Passed";

const enc = encodeURIComponent;

const STEPS = ["Company", "Round", "Investors"] as const;

/** "Acme Robotics' first round", "Kestrel's first round". */
function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

/**
 * Whether the founder picked the default currency themselves (then the first round never
 * overrides it). Kept per workspace in sessionStorage so a reload between steps keeps it.
 */
const TOUCHED_KEY = (slug: string) => `rb-onb-currency-touched:${slug}`;
function readTouched(slug: string | null): boolean {
  if (!slug) return false;
  try {
    return sessionStorage.getItem(TOUCHED_KEY(slug)) === "1";
  } catch {
    return false;
  }
}
function writeTouched(slug: string) {
  try {
    sessionStorage.setItem(TOUCHED_KEY(slug), "1");
  } catch {
    /* private mode: best effort */
  }
}

type StepOneErrors = Partial<Record<"person" | "company", string>>;

function Stepper({ step }: { step: number }) {
  return (
    <nav aria-label="Setup progress" className="min-w-0">
      <ol className="t-micro m-0 flex list-none items-center gap-6 p-0 text-muted">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const current = n === step;
          return (
            <li key={label} className="flex items-center gap-6" aria-current={current ? "step" : undefined}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <span className={cn(current ? "font-medium text-fg" : n < step ? "text-muted" : "text-muted")}>
                <span className="sr-only">{n < step ? "Done: " : current ? "Current step: " : ""}</span>
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Onboarding (SYSTEM §4.11): 1 company → 2 first round → 3 how to bring investors in. The
 * step and the new workspace live in the URL (`?ws=<slug>&round=<slug>`) so a reload resumes.
 */
export function Onboarding({
  csrf,
  workspaces,
  userName,
}: {
  csrf: string;
  workspaces: Workspace[];
  userName: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => setCsrfToken(csrf), [csrf]);

  const wsSlug = params.get("ws");
  const roundSlug = params.get("round");
  const ws = workspaces.find((w) => w.slug === wsSlug) ?? null;
  // ?step= revisits an earlier step after "Back" (editing what was created, not duplicating it).
  const asked = Number(params.get("step"));
  const natural = !wsSlug ? 1 : !roundSlug ? 2 : 3;
  const step = asked >= 1 && asked < natural ? asked : natural;

  const [person, setPerson] = useState(userName ?? "");
  const [company, setCompany] = useState(ws?.name ?? "");
  // An existing workspace keeps its zone and currency (Back from step 2); only a new one starts
  // from the browser's zone and a currency guessed from it.
  const [tz, setTz] = useState(() => (ws ? canonicalZone(ws.timezone) : "UTC"));
  const [currency, setCurrency] = useState(() => ws?.default_currency ?? "USD");
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [stepOneErrors, setStepOneErrors] = useState<StepOneErrors>({});
  const [draft, setDraft] = useState<RoundDraft>(() => draftFromRound(null, ws?.default_currency ?? "USD"));
  const [roundCurrencyTouched, setRoundCurrencyTouched] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof RoundDraft, string>>>({});
  const [sampleBusy, setSampleBusy] = useState(false);
  const personRef = useRef<HTMLInputElement>(null);
  const companyRef = useRef<HTMLInputElement>(null);
  const currencyTouchedRef = useRef(false);
  currencyTouchedRef.current = currencyTouched;

  useEffect(() => {
    const zone = browserTimeZone();
    setBrowserTz(zone);
    if (ws) return;
    setTz(zone);
    const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
    setCurrency(guessCurrency({ timeZone: zone, locale }));
    // The zone → country table makes the guess right beyond the founder hubs.
    loadZoneData().then(
      () => setCurrency((c) => (currencyTouchedRef.current ? c : guessCurrency({ timeZone: zone, locale }))),
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 1 revisited (Back): start from what the workspace has now.
  useEffect(() => {
    if (step !== 1 || !ws) return;
    setCompany(ws.name);
    setTz(canonicalZone(ws.timezone));
    setCurrency(ws.default_currency);
    setCurrencyTouched(readTouched(ws.slug));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ws?.slug]);

  // A new round starts in the workspace currency (unless the founder already changed it).
  useEffect(() => {
    if (!ws || roundSlug || roundCurrencyTouched) return;
    setDraft((d) => (d.currency === ws.default_currency ? d : { ...d, currency: ws.default_currency }));
  }, [ws, roundSlug, roundCurrencyTouched]);

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: errorMessage(err) });

  useEffect(() => {
    // Back from step 3: load the round so step 2 edits it.
    if (step !== 2 || !wsSlug || !roundSlug) return;
    let live = true;
    getRound(api.ws(wsSlug), roundSlug)
      .then((r) => {
        if (!live) return;
        setDraft(draftFromRound(r, r.currency));
        setRoundCurrencyTouched(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [step, wsSlug, roundSlug]);

  const createWs = async () => {
    const errs: StepOneErrors = {};
    if (!person.trim()) errs.person = "Enter your name, so co-founders know who did what.";
    if (!company.trim()) errs.company = "Enter your company's name.";
    setStepOneErrors(errs);
    if (errs.person || errs.company) {
      (errs.person ? personRef : companyRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (person.trim() !== (userName ?? "")) await updateMe(api, { name: person.trim() });
      if (ws) {
        const patch: WorkspaceUpdate = {};
        if (company.trim() !== ws.name) patch.name = company.trim();
        if (tz !== canonicalZone(ws.timezone)) patch.timezone = tz;
        if (currency !== ws.default_currency) patch.default_currency = currency;
        if (Object.keys(patch).length) await updateWorkspace(api.ws(ws.slug), patch);
        if (currencyTouched) writeTouched(ws.slug);
        router.replace(`/onboarding?ws=${enc(ws.slug)}${roundSlug ? `&round=${enc(roundSlug)}` : ""}`);
        router.refresh();
        return;
      }
      const w = await createWorkspace(api, { name: company.trim(), timezone: tz, default_currency: currency });
      if (currencyTouched) writeTouched(w.slug);
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
    const { body, errors: errs } = roundBody(draft, { update: !!roundSlug });
    setErrors(errs);
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const r = roundSlug
        ? await updateRound(api.ws(wsSlug), roundSlug, body)
        : await createRound(api.ws(wsSlug), body);
      // The first round's currency becomes the workspace default unless the founder chose one.
      if (!roundSlug && ws && r.currency !== ws.default_currency && !readTouched(ws.slug)) {
        await updateWorkspace(api.ws(wsSlug), { default_currency: r.currency }).catch(() => undefined);
        router.refresh();
      }
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
  const options: { title: string; body: string; href: string; cta: string; variant: "primary" | "secondary" | "ghost" }[] =
    roundSlug
      ? [
          {
            title: "Import a spreadsheet",
            body: "Bring the list you already have. Columns are matched for you, duplicates are caught, and you preview before anything is written.",
            href: `${base}/import?round=${enc(roundSlug)}`,
            cta: "Import a spreadsheet",
            variant: "primary",
          },
          {
            title: "Add them as you go",
            body: "Start with an empty board and add investors one at a time as you research and reach out.",
            href: `${base}/r/${enc(roundSlug)}`,
            cta: "Open the pipeline",
            variant: "secondary",
          },
          {
            title: "Connect your agent first",
            body: "Give Claude Code, Codex or Cursor a key and let it import, log and set follow-ups with you. Everything it does shows on the timeline.",
            href: `${base}/settings/mcp`,
            cta: "Connect an agent",
            variant: "ghost",
          },
        ]
      : [];
  const backHref =
    step === 2 && wsSlug
      ? `/onboarding?ws=${enc(wsSlug)}${roundSlug ? `&round=${enc(roundSlug)}` : ""}&step=1`
      : step === 3 && wsSlug && roundSlug
        ? `/onboarding?ws=${enc(wsSlug)}&round=${enc(roundSlug)}&step=2`
        : null;

  return (
    <div className="mx-auto w-full max-w-flow pt-24 pb-48">
      <div className="mb-40 flex items-center gap-12">
        <Wordmark size={20} href="/" />
        {backHref ? (
          <Link href={backHref} className="t-body-s ml-auto text-muted hover:text-fg">
            ← Back
          </Link>
        ) : null}
        <span className={cn(!backHref && "ml-auto")}>
          <Stepper step={step} />
        </span>
      </div>

      {step === 1 ? (
        <form
          noValidate
          className="flex flex-col gap-16"
          onSubmit={(e) => {
            e.preventDefault();
            void createWs();
          }}
        >
          <div>
            <h1 className="t-display-m">Set up your company</h1>
            <p className="mt-6 text-muted">Your company gets its own private workspace. Co-founders can join it later.</p>
          </div>
          <Field label="Your name" hint="Shown to co-founders on the timeline." error={stepOneErrors.person}>
            <Input
              ref={personRef}
              autoFocus={!userName}
              value={person}
              maxLength={120}
              autoComplete="name"
              onChange={(e) => {
                setPerson(e.target.value);
                if (stepOneErrors.person) setStepOneErrors((x) => ({ ...x, person: undefined }));
              }}
            />
          </Field>
          <Field label="Company name" error={stepOneErrors.company}>
            <Input
              ref={companyRef}
              autoFocus={!!userName}
              value={company}
              maxLength={80}
              autoComplete="organization"
              onChange={(e) => {
                setCompany(e.target.value);
                if (stepOneErrors.company) setStepOneErrors((x) => ({ ...x, company: undefined }));
              }}
            />
          </Field>
          <div className="grid grid-cols-1 gap-16 sm:grid-cols-[3fr_2fr] sm:gap-12">
            <Field label="Timezone" hint="Follow-ups are due by this calendar.">
              <TimezonePicker value={tz} suggest={browserTz} onChange={setTz} />
            </Field>
            <Field label="Default currency" hint="New rounds start in it.">
              <CurrencyPicker
                value={currency}
                suggestFrom={{ timeZone: tz, locale: typeof navigator !== "undefined" ? navigator.language : null }}
                onChange={(c) => {
                  setCurrency(c);
                  setCurrencyTouched(true);
                }}
              />
            </Field>
          </div>
          {error ? (
            <p className="t-body-s text-bad" role="alert">
              {error.message}
              {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" busy={busy ? "Saving…" : false} className="self-start">
            Continue
          </Button>
        </form>
      ) : step === 2 ? (
        <form
          noValidate
          className="flex flex-col gap-16"
          onSubmit={(e) => {
            e.preventDefault();
            void createFirstRound();
          }}
        >
          <div>
            <h1 className="t-display-m">Your round</h1>
            <p className="mt-6 text-muted">{ws ? `${possessive(ws.name)} first round.` : "Your first round."} Everything here can change later.</p>
          </div>
          <RoundFields
            draft={draft}
            onChange={(d) => {
              if (d.currency !== draft.currency) setRoundCurrencyTouched(true);
              setDraft(d);
            }}
            errors={errors}
            timeZone={ws ? canonicalZone(ws.timezone) : tz}
            hint={<>You can change stages later. We start you with {DEFAULT_STAGES}.</>}
          />
          {error ? (
            <p className="t-body-s text-bad">
              {error.message}
              {error.code ? <span className="ml-6 font-mono text-micro">{error.code}</span> : null}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-12">
            <Button type="submit" variant="primary" size="lg" busy={busy ? "Saving…" : false}>
              {roundSlug ? "Save round" : "Create round"}
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
                <div className="-mx-12 flex flex-col gap-10 rounded-sm px-12 py-16 hover:bg-sunk sm:flex-row sm:items-center sm:gap-16">
                  <div className="flex min-w-0 flex-1 flex-col gap-4">
                    <span className="t-display-xs">{o.title}</span>
                    <span className="text-muted">{o.body}</span>
                  </div>
                  <ButtonLink href={o.href} variant={o.variant} className="self-start sm:self-center">
                    {o.cta}
                  </ButtonLink>
                </div>
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
