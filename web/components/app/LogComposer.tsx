"use client";

import { useRef, useState } from "react";

import { Button, Segmented, Textarea, useToast } from "@/components/ui";
import { DateField } from "@/components/ui/DateField";
import { logActivity } from "@/lib/api/activities";
import { errorMessage, type ApiClient } from "@/lib/api/client";
import type { Activity, LoggableKind } from "@/lib/api/types";
import { LOGGABLE_KIND_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";

import { localNoon, newIdempotencyKey } from "./util";

const KINDS: LoggableKind[] = ["note", "email", "call", "meeting"];

const PLACEHOLDER: Record<LoggableKind, string> = {
  note: "What happened?",
  email: "What did the email say?",
  call: "What did you talk about?",
  meeting: "How did the meeting go? What's next?",
};

const DONE: Record<LoggableKind, string> = {
  note: "Note added",
  email: "Email logged",
  call: "Call logged",
  meeting: "Meeting logged",
};

/**
 * The LOG section (SYSTEM §4.4): kind picker, "What happened?", the date (default today) and
 * "Log note ⌘↵". Writes a manual activity attributed to the signed-in user.
 */
export function LogComposer({
  client,
  investorId,
  investorName,
  round,
  today,
  timeZone,
  disabled,
  onLogged,
  className,
  textareaId,
}: {
  client: ApiClient;
  investorId: string;
  investorName: string;
  /** Round id or slug when the log concerns a specific round. */
  round?: string;
  today: string;
  timeZone: string;
  disabled?: boolean;
  onLogged?: (a: Activity) => void;
  className?: string;
  /** id of the textarea (the sheet's N key focuses it). */
  textareaId?: string;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<LoggableKind>("note");
  const [body, setBody] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const submit = async () => {
    const text = body.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const a = await logActivity(client, {
        investor_id: investorId,
        kind,
        body: text,
        round,
        occurred_at: date && date !== today ? localNoon(date, timeZone) : undefined,
        idempotency_key: key.current,
      });
      key.current = newIdempotencyKey();
      setBody("");
      setDate(today);
      toast.show(`${DONE[kind]} for ${investorName}.`);
      onLogged?.(a);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={cn("flex flex-col gap-8", className)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Segmented
        size="sm"
        label="What kind of entry"
        value={kind}
        onChange={setKind}
        className="self-start"
        options={KINDS.map((k) => ({ value: k, label: LOGGABLE_KIND_LABEL[k] }))}
      />
      <Textarea
        id={textareaId}
        aria-label={PLACEHOLDER[kind]}
        placeholder={disabled ? "View only" : PLACEHOLDER[kind]}
        value={body}
        disabled={disabled}
        maxLength={20000}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="min-h-80"
      />
      <div className="flex flex-wrap items-center gap-8">
        <DateField
          aria-label="When it happened"
          value={date}
          timeZone={timeZone}
          quickPicks="none"
          clearable={false}
          disabled={disabled}
          onChange={(iso) => setDate(iso || today)}
          className="w-[170px]"
        />
        <Button
          type="submit"
          kbd="⌘↵"
          disabled={disabled || !body.trim()}
          busy={busy ? "Saving…" : false}
        >
          Log {LOGGABLE_KIND_LABEL[kind].toLowerCase()}
        </Button>
        {error ? <p className="t-body-s basis-full text-bad">{error}</p> : null}
      </div>
    </form>
  );
}
