import { cn } from "@/lib/cn";

import { AGENT_PROMPT, AGENT_REPLY, TRANSCRIPT } from "./sample";

/**
 * A Claude Code session, drawn as a dark code surface (SYSTEM 3.20). `data-theme="dark"` makes
 * the orchid token the dark-mode orchid, so agent tool calls read on the dark ground in both
 * themes. Fictional conversation; the tool names and arguments are the real MCP tools.
 */
export function AgentTranscript({ className }: { className?: string }) {
  return (
    <figure
      data-theme="dark"
      className={cn(
        "m-0 min-w-0 overflow-hidden rounded-md bg-code-bg font-mono text-[12.5px] leading-[1.6] text-code-fg",
        className,
      )}
    >
      <figcaption className="flex items-center gap-8 border-b border-code-line px-14 py-8 text-micro whitespace-nowrap text-code-muted">
        <span>claude-code</span>
        <span aria-hidden className="hidden sm:inline">·</span>
        <span className="hidden sm:inline">~/kestrel</span>
        <span className="ml-auto inline-flex items-center gap-6">
          <span aria-hidden className="inline-block size-6 rounded-pill bg-good" />
          raisebook connected
        </span>
      </figcaption>
      <div className="flex flex-col gap-14 px-14 py-14">
        <p className="flex gap-10 whitespace-pre-wrap">
          <span aria-hidden className="text-code-muted">&gt;</span>
          <span className="font-body text-[13.5px] text-code-fg">{AGENT_PROMPT}</span>
        </p>
        {TRANSCRIPT.map((call) => (
          <div key={call.tool} className="flex flex-col gap-2">
            <p className="flex items-center gap-8">
              <span aria-hidden className="agent-diamond" />
              <span className="text-agent">
                raisebook · <b className="font-medium">{call.tool}</b>
              </span>
              <span className="text-code-muted">(MCP)</span>
            </p>
            <div className="pl-15">
              {call.args.map(([k, v]) => (
                <p key={k} className="pl-[2ch] -indent-[2ch] [overflow-wrap:anywhere]">
                  <span className="text-code-key">{k}</span>
                  <span className="text-code-muted">: </span>
                  <span className="text-code-str">{v}</span>
                </p>
              ))}
              <p className="mt-2 text-code-muted">
                <span aria-hidden>→ </span>
                <span className="text-code-fg">{call.result}</span>
              </p>
            </div>
          </div>
        ))}
        <p className="border-t border-code-line pt-12 font-body text-[13.5px] leading-[1.55] text-code-fg">
          {AGENT_REPLY}
        </p>
      </div>
    </figure>
  );
}
