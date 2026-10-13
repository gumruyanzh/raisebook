"use client";

import { useId, useRef, useState, type DragEvent } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./Button";

/**
 * Dashed drop zone (SYSTEM 3.30): "Drop a CSV here, or paste below" + "Choose file". Reads the
 * file client-side as text (≤ 5 MB by default) and hands it to `onText`, or hands a binary
 * file (a deck PDF) to `onFile` unread; nothing is uploaded until the user confirms elsewhere.
 */
export function FileDrop({
  onText,
  onFile,
  accept = ".csv,.tsv,.txt,.json,text/csv,application/json",
  maxBytes = 5 * 1024 * 1024,
  prompt = "Drop a CSV here, or paste below",
  className,
  disabled,
}: {
  /** Text files (CSV, JSON): read in the browser. */
  onText?: (text: string, file: { name: string; size: number }) => void;
  /** Binary files (a PDF deck): handed over as they are, nothing is read here. */
  onFile?: (file: File) => void;
  accept?: string;
  maxBytes?: number;
  prompt?: string;
  className?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > maxBytes) {
      setError(
        onFile
          ? `${file.name} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${Math.round(maxBytes / 1048576)} MB.`
          : `${file.name} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${Math.round(maxBytes / 1048576)} MB; split the file and import it in parts.`,
      );
      return;
    }
    if (onFile) {
      setName(file.name);
      onFile(file);
      return;
    }
    try {
      const text = await file.text();
      setName(file.name);
      onText?.(text, { name: file.name, size: file.size });
    } catch {
      setError(`Could not read ${file.name}. Save it as UTF-8 CSV and try again.`);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) void read(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      aria-describedby={hintId}
      className={cn(
        "flex flex-col items-center gap-10 rounded-md border border-dashed bg-canvas px-16 py-24 text-center transition-colors duration-[120ms]",
        over ? "border-accent" : "border-line",
        disabled && "opacity-60",
        className,
      )}
    >
      <p id={hintId} className="text-muted">
        {name ? (
          <>
            Loaded <span className="font-mono text-fg">{name}</span>. Drop another file to replace it.
          </>
        ) : (
          prompt
        )}
      </p>
      <Button size="sm" onClick={() => input.current?.click()} disabled={disabled}>
        Choose file
      </Button>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          void read(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error ? (
        <p role="alert" className="t-body-s text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
