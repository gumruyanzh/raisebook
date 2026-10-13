"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Input, SaveState, SectionLabel, Select } from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { updateInvestor, type InvestorUpdate } from "@/lib/api/investors";
import type { Investor, InvestorType } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { money, stageFocusLabel } from "@/lib/format";

import { moneyInput, parseMoney } from "./util";

type TextKey =
  | "name"
  | "firm"
  | "title"
  | "email"
  | "linkedin_url"
  | "website_url"
  | "x_url"
  | "location"
  | "check_note"
  | "source"
  | "warm_intro_by";
type ListKey = "stage_focus" | "industries" | "tags";
type MoneyKey = "check_min" | "check_max";

const EMPTY = "—";

const splitList = (s: string) =>
  s
    .split(/[;,|]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** "dana.whitfield.partner@harborlight.example.com" → "dana.whit…@harborlight.example.com". */
export function middleTruncateEmail(email: string, max = 30): string {
  if (email.length <= max) return email;
  const at = email.lastIndexOf("@");
  if (at <= 0) return `${email.slice(0, max - 1)}…`;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = Math.max(3, max - domain.length - 1);
  return local.length > keep ? `${local.slice(0, keep)}…${domain}` : email;
}

/** A profile URL shown short: "linkedin.com/in/dana-w" → "in/dana-w", "x.com/dana" → "@dana". */
export function shortUrl(url: string, kind: "linkedin" | "x" | "web"): string {
  const bare = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (kind === "linkedin") {
    const m = bare.match(/linkedin\.com\/(in|company|pub)\/([^/?#]+)/i);
    if (m) return `${m[1]!.toLowerCase()}/${decodeURIComponent(m[2]!)}`;
  }
  if (kind === "x") {
    const m = bare.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
    if (m) return `@${m[1]}`;
  }
  return bare.length > 36 ? `${bare.slice(0, 35)}…` : bare;
}

const hrefOf = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/**
 * One fact, edited in place: the value reads as text until you click it (or press Enter on
 * it); then it becomes an input that saves on Enter or blur and cancels on Esc. Links stay
 * clickable through the ↗ beside the value.
 */
function Fact({
  label,
  display,
  value,
  onCommit,
  readOnly,
  error,
  placeholder,
  mono,
  inputMode,
  type,
  link,
  hint,
  children,
}: {
  label: string;
  /** What the cell shows when not editing (defaults to the value). */
  display?: ReactNode;
  value: string;
  onCommit: (v: string) => void;
  readOnly?: boolean;
  error?: string;
  placeholder?: string;
  mono?: boolean;
  inputMode?: "decimal" | "email" | "url" | "text";
  type?: string;
  link?: string | null;
  hint?: string;
  /** A custom editor (the Type select) instead of the text input. */
  children?: (stop: () => void) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const btn = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const id = useId();
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const stop = (focusBack = true) => {
    setEditing(false);
    if (focusBack) requestAnimationFrame(() => btn.current?.focus());
  };
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (draft.trim() !== value.trim()) onCommit(draft);
    stop(false);
  };
  const start = () => {
    done.current = false;
    setEditing(true);
  };

  const shown = display ?? (value ? value : null);
  return (
    <div className="contents">
      <dt className="flex min-h-32 items-center text-muted">
        <label htmlFor={editing ? id : undefined}>{label}</label>
      </dt>
      <dd className="m-0 min-w-0">
        {editing && !readOnly ? (
          children ? (
            children(() => stop())
          ) : (
            <Input
              id={id}
              autoFocus
              size="md"
              mono={mono}
              type={type}
              inputMode={inputMode}
              value={draft}
              placeholder={placeholder}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                  requestAnimationFrame(() => btn.current?.focus());
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  done.current = true;
                  setDraft(value);
                  stop();
                }
              }}
            />
          )
        ) : (
          <div className="flex min-h-32 min-w-0 items-center gap-6">
            <button
              ref={btn}
              type="button"
              disabled={readOnly}
              onClick={start}
              title={readOnly ? undefined : `Edit ${label.toLowerCase()}`}
              aria-label={`${label}: ${typeof shown === "string" ? shown : value || "empty"}${readOnly ? "" : ". Edit"}`}
              className={cn(
                "-mx-8 flex min-h-32 min-w-0 items-center truncate rounded-sm border border-transparent bg-transparent px-8 text-left",
                !readOnly && "hover:border-line hover:bg-canvas",
                readOnly && "cursor-default disabled:cursor-default",
                mono && "font-mono text-sm tnum",
                !shown && "text-faint",
              )}
            >
              <span className="min-w-0 truncate">{shown ?? EMPTY}</span>
            </button>
            {link ? (
              <a
                href={hrefOf(link)}
                target="_blank"
                rel="noopener noreferrer"
                className="link shrink-0 px-2"
                aria-label={`Open ${label} in a new tab`}
              >
                ↗
              </a>
            ) : null}
          </div>
        )}
        {error ? (
          <p className="t-body-s text-bad" role="alert">
            {error}
          </p>
        ) : editing && hint ? (
          <p className="t-body-s text-muted">{hint}</p>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * The Profile on the investor page (SYSTEM §4.8, UX-PASS-1 P2-6): every contact field as a
 * fact list (112px terms), edited in place one cell at a time and saved when you leave it.
 * LinkedIn reads "in/handle ↗", long emails are middle-truncated. Email and LinkedIn
 * conflicts with another contact are shown on the cell.
 */
export function InvestorProfile({
  client,
  investor,
  currency,
  canWrite,
  onSaved,
}: {
  client: ApiClient;
  investor: Investor;
  currency: string;
  canWrite: boolean;
  onSaved: (inv: Investor) => void;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ro = !canWrite;
  const inv = investor;

  const save = async (key: string, patch: InvestorUpdate) => {
    setState("saving");
    try {
      const next = await updateInvestor(client, inv.id, patch);
      setErrors((e) => {
        const { [key]: _x, ...rest } = e;
        return rest;
      });
      setState("saved");
      onSaved(next);
    } catch (err) {
      setState("error");
      let msg = errorMessage(err);
      if (err instanceof ApiError && err.code === "duplicate") {
        msg = `Another contact already has this ${key === "email" ? "email" : "LinkedIn profile"}.`;
      } else if (err instanceof ApiError) {
        msg = err.fieldErrors[key] ?? msg;
      }
      setErrors((e) => ({ ...e, [key]: msg }));
    }
  };

  const text = (key: TextKey) => (v: string) => {
    const t = v.trim();
    if (key === "name" && !t) {
      setErrors((e) => ({ ...e, name: "A contact needs a name." }));
      return;
    }
    void save(key, { [key]: t || null } as InvestorUpdate);
  };
  const list = (key: ListKey) => (v: string) => {
    const next = splitList(v);
    if (next.join("|") === inv[key].join("|")) return;
    void save(key, { [key]: next } as InvestorUpdate);
  };
  const amount = (key: MoneyKey) => (v: string) => {
    const n = parseMoney(v);
    if (Number.isNaN(n)) {
      setErrors((e) => ({ ...e, [key]: "Use a number like 250k or 1M." }));
      return;
    }
    if ((n ?? null) === (inv[key] ?? null)) return;
    void save(key, { [key]: n } as InvestorUpdate);
  };

  const s = (v: string | null | undefined) => v ?? "";

  return (
    <section aria-label="Profile">
      <SectionLabel aside={<SaveState state={state} />}>Profile</SectionLabel>
      <dl className="mt-4 grid grid-cols-[112px_minmax(0,1fr)] gap-x-10 gap-y-2 text-13">
        <Fact label="Name" value={inv.name} onCommit={text("name")} readOnly={ro} error={errors.name} />
        <Fact label="Firm" value={s(inv.firm)} onCommit={text("firm")} readOnly={ro} error={errors.firm} />
        <Fact label="Title" value={s(inv.title)} onCommit={text("title")} readOnly={ro} error={errors.title} />
        <Fact label="Type" value={inv.type} display={INVESTOR_TYPE_LABEL[inv.type]} onCommit={() => {}} readOnly={ro}>
          {(stop) => (
            <Select
              autoFocus
              aria-label="Type"
              defaultValue={inv.type}
              onBlur={() => stop()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  stop();
                }
              }}
              onChange={(e) => {
                const t = e.target.value as InvestorType;
                stop();
                if (t !== inv.type) void save("type", { type: t });
              }}
            >
              {(Object.keys(INVESTOR_TYPE_LABEL) as InvestorType[]).map((t) => (
                <option key={t} value={t}>
                  {INVESTOR_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          )}
        </Fact>
        <Fact
          label="Email"
          type="email"
          inputMode="email"
          value={s(inv.email)}
          display={inv.email ? <span title={inv.email}>{middleTruncateEmail(inv.email)}</span> : null}
          link={inv.email ? `mailto:${inv.email}` : null}
          onCommit={text("email")}
          readOnly={ro}
          error={errors.email}
        />
        <Fact label="Location" value={s(inv.location)} onCommit={text("location")} readOnly={ro} error={errors.location} />
        <Fact
          label="LinkedIn"
          inputMode="url"
          value={s(inv.linkedin_url)}
          display={inv.linkedin_url ? shortUrl(inv.linkedin_url, "linkedin") : null}
          link={inv.linkedin_url}
          placeholder="linkedin.com/in/…"
          onCommit={text("linkedin_url")}
          readOnly={ro}
          error={errors.linkedin_url}
        />
        <Fact
          label="Website"
          inputMode="url"
          value={s(inv.website_url)}
          display={inv.website_url ? shortUrl(inv.website_url, "web") : null}
          link={inv.website_url}
          onCommit={text("website_url")}
          readOnly={ro}
          error={errors.website_url}
        />
        <Fact
          label="X"
          inputMode="url"
          value={s(inv.x_url)}
          display={inv.x_url ? shortUrl(inv.x_url, "x") : null}
          link={inv.x_url}
          onCommit={text("x_url")}
          readOnly={ro}
          error={errors.x_url}
        />
        <Fact
          label="Check size"
          value={s(inv.check_note)}
          onCommit={text("check_note")}
          readOnly={ro}
          error={errors.check_note}
          hint="Free text, e.g. “$250k–$1M, leads”. Min and max are read from it when empty."
        />
        <Fact
          label={`Min check`}
          mono
          inputMode="decimal"
          value={moneyInput(inv.check_min)}
          display={inv.check_min != null ? money(inv.check_min, currency) : null}
          onCommit={amount("check_min")}
          readOnly={ro}
          error={errors.check_min}
          placeholder="250k"
        />
        <Fact
          label={`Max check`}
          mono
          inputMode="decimal"
          value={moneyInput(inv.check_max)}
          display={inv.check_max != null ? money(inv.check_max, currency) : null}
          onCommit={amount("check_max")}
          readOnly={ro}
          error={errors.check_max}
          placeholder="1M"
        />
        <Fact
          label="Invests at"
          value={inv.stage_focus.join(", ")}
          display={inv.stage_focus.length ? inv.stage_focus.map(stageFocusLabel).join(", ") : null}
          onCommit={list("stage_focus")}
          readOnly={ro}
          error={errors.stage_focus}
          hint="Comma-separated: pre-seed, seed, series a"
        />
        <Fact label="Industries" value={inv.industries.join(", ")} onCommit={list("industries")} readOnly={ro} error={errors.industries} hint="Comma-separated" />
        <Fact label="Tags" value={inv.tags.join(", ")} onCommit={list("tags")} readOnly={ro} error={errors.tags} hint="Comma-separated" />
        <Fact label="Source" value={s(inv.source)} onCommit={text("source")} readOnly={ro} error={errors.source} />
        <Fact label="Warm intro by" value={s(inv.warm_intro_by)} onCommit={text("warm_intro_by")} readOnly={ro} error={errors.warm_intro_by} />
      </dl>
    </section>
  );
}
