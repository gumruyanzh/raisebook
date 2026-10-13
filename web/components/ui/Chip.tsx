import type { ComponentProps, ReactNode } from "react";

import type { FollowUpState, Priority } from "@/lib/api/types";
import { PRIORITY_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { followUpLabel, money, moneyCompact, priorityFromFit } from "@/lib/format";

/**
 * Chips (SYSTEM §2.4): pills with chip type and a 1px transparent border. Never interactive
 * unless rendered as a button (`as="button"`, used by the due strip), which adds the hover
 * underline. At most four chips on a board card.
 */
export type ChipTone =
  | "hot"
  | "warm"
  | "maybe"
  | "low"
  | "type"
  | "tag"
  | "industry"
  | "due"
  | "soon"
  | "money"
  | "agent"
  | "mode";

const TONE: Record<ChipTone, string> = {
  hot: "bg-hot-soft text-hot-ink",
  warm: "bg-warm-soft text-warm-ink",
  maybe: "bg-maybe-soft text-maybe-ink",
  low: "bg-sunk text-muted",
  // A static label: neutral and outlined (cobalt means "you can act"; critique 2).
  type: "border-line! bg-transparent text-muted",
  tag: "bg-sunk text-muted",
  industry: "bg-sunk text-muted",
  due: "bg-bad-soft text-bad",
  soon: "bg-warm-soft text-warm-ink",
  money: "bg-good-soft text-good-ink font-mono",
  agent: "bg-agent-soft text-agent",
  mode: "border-line! bg-transparent text-muted font-mono uppercase tracking-[0.06em] text-2xs!",
};

const BASE =
  "t-chip inline-flex max-w-full items-center gap-4 rounded-pill border border-transparent px-7 whitespace-nowrap";

type ChipProps =
  | ({ as?: "span"; tone: ChipTone } & ComponentProps<"span">)
  | ({ as: "button"; tone: ChipTone } & ComponentProps<"button">);

export function Chip(props: ChipProps) {
  if (props.as === "button") {
    const { as: _as, tone, className, type = "button", ...rest } = props;
    return (
      <button
        type={type}
        className={cn(BASE, TONE[tone], "hover:underline hover:underline-offset-2", className)}
        {...rest}
      />
    );
  }
  const { as: _as, tone, className, ...rest } = props;
  return <span className={cn(BASE, TONE[tone], className)} {...rest} />;
}

/** Priority chip from fit (SYSTEM §2.2). `showFit` adds "· fit 4/5" (sheet header). */
export function PriorityChip({
  fit,
  showFit,
  className,
}: {
  fit: number;
  showFit?: boolean;
  className?: string;
}) {
  const p: Priority = priorityFromFit(fit);
  return (
    <Chip tone={p} className={className}>
      {PRIORITY_LABEL[p]}
      {showFit ? ` · fit ${fit}/5` : null}
    </Chip>
  );
}

/** Follow-up chip (SYSTEM §2.3). Renders nothing for "later" or no date. */
export function FollowUpChip({
  on,
  state,
  today,
  className,
}: {
  on: string | null | undefined;
  state: FollowUpState | null | undefined;
  today?: string;
  className?: string;
}) {
  if (!on || !state || state === "later") return null;
  return (
    <Chip tone={state === "soon" ? "soon" : "due"} className={className}>
      {followUpLabel(on, state, today)}
    </Chip>
  );
}

/** Compact money chip ("$250k") with the exact amount in the title. */
export function MoneyChip({
  amount,
  currency = "USD",
  className,
  children,
}: {
  amount: number;
  currency?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Chip tone="money" className={className} title={money(amount, currency)}>
      {moneyCompact(amount, currency)}
      {children}
    </Chip>
  );
}
