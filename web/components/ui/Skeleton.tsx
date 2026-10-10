import { cn } from "@/lib/cn";

/**
 * Static sunk bars, no shimmer (SYSTEM 3.25). Use only where a layout would jump; otherwise
 * show text ("Loading pipeline…") with `<Loading>`.
 */
export function Skeleton({
  className,
  lines = 1,
  width,
}: {
  className?: string;
  lines?: number;
  width?: string | number;
}) {
  return (
    <span aria-hidden className={cn("flex flex-col gap-6", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="block h-10 rounded-xs bg-sunk"
          style={{ width: i === lines - 1 && lines > 1 ? "60%" : (width ?? "100%") }}
        />
      ))}
    </span>
  );
}

/** Loading text in muted (SYSTEM §1.7: no spinners). */
export function Loading({
  children = "Loading…",
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <p role="status" className={cn("t-body-s text-muted", className)}>
      {children}
    </p>
  );
}
