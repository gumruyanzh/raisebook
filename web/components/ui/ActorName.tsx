import type { Actor } from "@/lib/api/types";
import { cn } from "@/lib/cn";

/** The 7px orchid diamond that marks agent work (SYSTEM §2.5). Decorative. */
export function AgentMarker({ className, label }: { className?: string; label?: string }) {
  return label ? (
    <span role="img" aria-label={label} className={cn("agent-diamond", className)} />
  ) : (
    <span aria-hidden className={cn("agent-diamond", className)} />
  );
}

/**
 * Who did it (SYSTEM §2.5). Agent: diamond + name in orchid 500 + model in mono at 75%.
 * User: name in fg 500. System: "Raisebook" in muted. Always the actor, never "the AI".
 */
export function ActorName({
  actor,
  showModel = true,
  className,
}: {
  actor: Pick<Actor, "type" | "label" | "agent_model">;
  showModel?: boolean;
  className?: string;
}) {
  if (actor.type === "agent") {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-6 text-agent", className)}>
        <AgentMarker />
        <span className="font-medium">{actor.label}</span>
        {showModel && actor.agent_model ? (
          <span className="truncate font-mono text-micro opacity-75">· {actor.agent_model}</span>
        ) : null}
      </span>
    );
  }
  if (actor.type === "system") {
    return <span className={cn("text-muted", className)}>{actor.label || "Raisebook"}</span>;
  }
  return <span className={cn("font-medium text-fg", className)}>{actor.label}</span>;
}
