"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export type CodeLang = "shell" | "json" | "toml" | "text";

export interface CodeTab {
  label: string;
  code: string;
  lang?: CodeLang;
  /** Small muted line under the code (e.g. "~/.codex/config.toml"). */
  caption?: ReactNode;
}

type Token = { t: string; k?: "str" | "key" | "com" };

/** Minimal highlighting: strings green, keys/flags cobalt, comments muted. No HTML strings. */
function tokenize(code: string, lang: CodeLang): Token[][] {
  return code.split("\n").map((line) => {
    if (lang === "text") return [{ t: line }];
    const out: Token[] = [];
    const trimmed = line.trimStart();
    if ((lang === "shell" || lang === "toml") && trimmed.startsWith("#")) return [{ t: line, k: "com" }];
    if (lang === "toml" && /^\s*\[[^\]]+\]\s*$/.test(line)) return [{ t: line, k: "key" }];
    const re =
      lang === "json"
        ? /("(?:[^"\\]|\\.)*")(\s*:)?/g
        : lang === "toml"
          ? /("(?:[^"\\]|\\.)*")|^(\s*[A-Za-z0-9_.-]+)(?=\s*=)/g
          : /("(?:[^"\\]|\\.)*"|'[^']*')|(\s--?[A-Za-z][\w-]*)/g;
    let last = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (m.index > last) out.push({ t: line.slice(last, m.index) });
      if (lang === "json") {
        out.push({ t: m[1]!, k: m[2] ? "key" : "str" });
        if (m[2]) out.push({ t: m[2] });
      } else if (m[1]) {
        out.push({ t: m[1], k: "str" });
      } else if (m[2]) {
        out.push({ t: m[2], k: "key" });
      }
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < line.length) out.push({ t: line.slice(last) });
    return out;
  });
}

const TOKEN_CLASS = { str: "text-code-str", key: "text-code-key", com: "text-code-muted" } as const;

function Code({ code, lang }: { code: string; lang: CodeLang }) {
  const lines = tokenize(code, lang);
  return (
    <code className="block">
      {lines.map((tokens, i) => (
        <span key={i} className="block min-h-[1.55em]">
          {tokens.map((tok, j) =>
            tok.k ? (
              <span key={j} className={TOKEN_CLASS[tok.k]}>
                {tok.t}
              </span>
            ) : (
              <span key={j}>{tok.t}</span>
            ),
          )}
        </span>
      ))}
    </code>
  );
}

export function CopyButton({
  text,
  className,
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
      className={cn(
        "h-26 shrink-0 rounded-sm border border-code-line bg-transparent px-8 font-body text-sm text-code-fg hover:border-code-muted",
        className,
      )}
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

/**
 * Code surface, dark in both themes (SYSTEM 3.20): Plex Mono 12.5, radius 8, a copy button,
 * optional tabs (Claude Code · Codex · Cursor · Other) and minimal highlighting.
 */
export function CodeBlock({
  code,
  lang = "text",
  tabs,
  title,
  className,
  copy = true,
  defaultTab = 0,
  wrap = false,
}: {
  code?: string;
  lang?: CodeLang;
  tabs?: CodeTab[];
  /** Mono caption in the header when there are no tabs ("Terminal"). */
  title?: ReactNode;
  className?: string;
  copy?: boolean;
  defaultTab?: number;
  /** Wrap long lines (prose prompts, not commands): never clipped, nothing to scroll. */
  wrap?: boolean;
}) {
  const [active, setActive] = useState(defaultTab);
  const preRef = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  }, []);
  const base = useId();
  const current: CodeTab | undefined = tabs?.[active] ?? tabs?.[0];
  const text = current ? current.code : (code ?? "");
  const language = current ? (current.lang ?? "text") : lang;
  const hasHeader = Boolean(tabs?.length || title || copy);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, text, wrap]);

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-md bg-code-bg font-mono text-[12.5px] leading-[1.55] text-code-fg",
        className,
      )}
    >
      {hasHeader ? (
        <div className="flex items-center gap-8 border-b border-code-line px-10 py-6">
          {tabs?.length ? (
            <div role="tablist" aria-label="Client" className="flex min-w-0 flex-1 gap-2 overflow-x-auto scrollbar-none">
              {tabs.map((t, i) => (
                <button
                  key={t.label}
                  type="button"
                  role="tab"
                  id={`${base}-t${i}`}
                  aria-selected={i === active}
                  aria-controls={`${base}-p`}
                  onClick={() => setActive(i)}
                  className={cn(
                    "h-26 rounded-sm border-0 px-8 font-body text-sm whitespace-nowrap",
                    i === active ? "bg-code-raise text-code-fg" : "bg-transparent text-code-muted hover:text-code-fg",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="truncate text-micro text-code-muted">{title}</span>
          )}
          {copy ? <CopyButton text={text} className="ml-auto shrink-0" /> : null}
        </div>
      ) : null}
      <div className="relative">
        <pre
          ref={preRef}
          onScroll={measure}
          id={`${base}-p`}
          role={tabs?.length ? "tabpanel" : undefined}
          aria-labelledby={tabs?.length ? `${base}-t${active}` : undefined}
          className={cn(
            "m-0 px-14 py-12",
            wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto scrollbar-thin",
          )}
        >
          <Code code={text} lang={language} />
        </pre>
        {more && !wrap ? (
          // There is more to the right: fade the edge so the cut reads as "scroll", not a bug.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-40 bg-linear-to-l from-code-bg to-transparent"
          />
        ) : null}
      </div>
      {current?.caption ? (
        <p className="border-t border-code-line px-14 py-6 font-body text-sm text-code-muted">
          {current.caption}
        </p>
      ) : null}
    </div>
  );
}
