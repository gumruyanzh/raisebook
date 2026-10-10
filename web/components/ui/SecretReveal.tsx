"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./Button";

/**
 * Copy-once API key panel (SYSTEM 3.21): warm-soft background, 1px warm border, the secret in a
 * read-only mono input and a Copy button. The parent must drop the secret from state once this
 * panel closes; it is never rendered again.
 */
export function SecretReveal({
  secret,
  label = "API key",
  className,
  onCopied,
}: {
  secret: string;
  label?: string;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("rounded-md border border-warm bg-warm-soft p-12", className)}>
      <p className="t-label mb-6 text-fg">{label}</p>
      <div className="flex gap-8">
        <input
          readOnly
          value={secret}
          aria-label={label}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          className="h-32 min-w-0 flex-1 rounded-sm border border-line bg-surface px-9 font-mono text-sm text-fg"
        />
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
              onCopied?.();
            } catch {
              setCopied(false);
            }
          }}
        >
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <p className="t-body-s mt-8 text-fg">
        This is the only time you&apos;ll see this key. Store it in your agent&apos;s config or a
        password manager.
      </p>
    </div>
  );
}
