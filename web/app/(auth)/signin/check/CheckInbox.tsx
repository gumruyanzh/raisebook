"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, CodeBlock, buttonClasses } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { requestMagicLink } from "@/lib/api/core";

import { readPending, savePending, type PendingSignIn } from "../SignInForm";

export function CheckInbox({ email }: { email?: string }) {
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // A link was just sent: allow another only after 60 seconds.
  const [wait, setWait] = useState(60);
  useEffect(() => setPending(readPending()), []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const shownEmail = email ?? pending?.request.email;
  const request = pending?.request ?? (email ? { email } : null);

  const resend = async () => {
    if (!request || wait > 0) return;
    setState("sending");
    setError(null);
    try {
      const res = await requestMagicLink(api, request);
      const p = { request, devLink: res.dev_link ?? null };
      savePending(p);
      setPending(p);
      setState("sent");
      setWait(60);
    } catch (err) {
      setError(errorMessage(err));
      setState("error");
    }
  };

  return (
    <div className="flex flex-col gap-14">
      <p>
        We sent a sign-in link to{" "}
        {shownEmail ? <span className="font-mono text-sm break-all">{shownEmail}</span> : "your email"}.
        Open it on this device to continue.
      </p>
      <p className="t-body-s text-muted">
        The link works once and expires in 15 minutes. If it does not arrive, check spam, or send
        it again.
      </p>
      {pending?.devLink ? (
        <div className="flex flex-col gap-8">
          <p className="t-label">Development sign-in link</p>
          <CodeBlock code={pending.devLink} title="dev_link (shown only when the API runs locally)" />
          <a href={pending.devLink} className={buttonClasses("secondary", "md", "self-start")}>
            Open dev link
          </a>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-10">
        {request ? (
          <Button onClick={resend} disabled={wait > 0} busy={state === "sending" ? "Sending…" : false}>
            {wait > 0 ? `Send it again in ${wait}s` : "Send it again"}
          </Button>
        ) : null}
        <Link href="/signin" className="link">
          Use a different email
        </Link>
      </div>
      {error ? <p className="t-body-s text-bad">{error}</p> : null}
    </div>
  );
}
