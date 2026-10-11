"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Input, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { updateMe } from "@/lib/api/core";
import { useSession } from "@/lib/session";

/**
 * Asks for a display name when the account has none (people who joined through an emailed
 * invite link, and accounts from before names were asked for), so the timeline reads as people
 * rather than email addresses.
 */
export function NamePrompt() {
  const session = useSession();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (session.user.name) return null;

  return (
    <form
      className="mb-16 flex flex-wrap items-center gap-10 rounded-md border border-line bg-surface px-14 py-10"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          await updateMe(api, { name: name.trim() });
          router.refresh();
        } catch (err) {
          toast.show(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <label htmlFor="rb-your-name" className="min-w-0 flex-1 basis-[240px]">
        Add your name so co-founders see who did what.
      </label>
      <Input
        id="rb-your-name"
        size="sm"
        className="w-[200px]!"
        value={name}
        maxLength={120}
        autoComplete="name"
        placeholder="Your name"
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" size="sm" variant="primary" busy={busy ? "Saving…" : false} disabled={!name.trim()}>
        Save
      </Button>
    </form>
  );
}
