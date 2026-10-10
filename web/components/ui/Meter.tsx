import { cn } from "@/lib/cn";
import { pct } from "@/lib/format";

/**
 * Ledger meter: an 8px sunk pill track with a good fill (width animates 400ms). Over 100% the
 * fill is full and a mono "112% of target" appears in good (SYSTEM 3.8).
 */
export function Meter({
  value,
  max,
  label,
  className,
}: {
  value: number;
  max: number;
  /** Accessible name, e.g. "Committed toward Seed". */
  label: string;
  className?: string;
}) {
  const ratio = max > 0 ? (value / max) * 100 : 0;
  const width = Math.max(0, Math.min(100, ratio));
  const over = ratio > 100;
  return (
    <div className={cn("flex items-center gap-10", className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${pct(Math.round(ratio * 10) / 10)} of target`}
        className="h-8 flex-1 overflow-hidden rounded-pill bg-sunk"
      >
        <i
          className="block h-full bg-good not-italic transition-[width] duration-[400ms] ease-out"
          style={{ width: `${width}%` }}
        />
      </div>
      {over ? (
        <span className="t-micro whitespace-nowrap text-good">
          {pct(Math.round(ratio))} of target
        </span>
      ) : null}
    </div>
  );
}
