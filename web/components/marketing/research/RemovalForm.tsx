"use client";

import { useState } from "react";

import { Button, Field, Input, Textarea } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { requestRemoval } from "@/lib/api/research";

/**
 * The removal request (R13): anyone can ask Raisebook to delete the research it stores about
 * them and to stop researching them. The answer is always the same, so it never says whether
 * anything is stored; the request counts only once the emailed link is opened.
 */
export function RemovalForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [firm, setFirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<{ text: string; code?: string; fields: Record<string, string> } | null>(null);
  const ok = name.trim() && /.+@.+\..+/.test(email.trim());

  if (sent) {
    return (
      <div className="rounded-md border border-line bg-surface p-20" role="status">
        <p className="font-semibold">Check your inbox.</p>
        <p className="mt-4 text-muted">{sent}</p>
      </div>
    );
  }
  return (
    <form
      noValidate
      className="flex flex-col gap-12 rounded-md border border-line bg-surface p-20"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) {
          setErr({ text: "Add your name and an email address we can write to.", fields: {} });
          return;
        }
        setBusy(true);
        setErr(null);
        try {
          const r = await requestRemoval(api, {
            name: name.trim(),
            email: email.trim(),
            ...(linkedin.trim() ? { linkedin_url: linkedin.trim() } : {}),
            ...(firm.trim() ? { firm: firm.trim() } : {}),
            ...(message.trim() ? { message: message.trim() } : {}),
          });
          setSent(r.message);
        } catch (e2) {
          setErr({
            text: errorMessage(e2),
            code: e2 instanceof ApiError ? e2.code : undefined,
            fields: e2 instanceof ApiError ? e2.fieldErrors : {},
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
        <Field label="Your name" error={err?.fields.name}>
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Email" hint="We send the confirmation link here." error={err?.fields.email}>
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
        </Field>
        <Field label="LinkedIn URL" optional hint="Helps us find every copy." error={err?.fields.linkedin_url}>
          <Input type="url" inputMode="url" placeholder="https://www.linkedin.com/in/…" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Firm" optional error={err?.fields.firm}>
          <Input value={firm} onChange={(e) => setFirm(e.target.value)} maxLength={200} />
        </Field>
      </div>
      <Field label="Anything else" optional error={err?.fields.message}>
        <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} className="min-h-72" />
      </Field>
      {err ? (
        <p className="t-body-s text-bad" role="alert">
          {err.text} {err.code ? <span className="font-mono text-micro">{err.code}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant="primary" busy={busy ? "Sending…" : false}>
          Send removal request
        </Button>
        <span className="t-body-s text-muted">We will email you a confirmation link.</span>
      </div>
    </form>
  );
}
