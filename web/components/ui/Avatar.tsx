import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

/**
 * A person's initials in a `sunk` circle (20px in table cells, 28px for the account menu).
 * Decorative: the name always sits next to it, so it is `aria-hidden`.
 */
export function Avatar({
  name,
  size = 20,
  className,
}: {
  /** Name, else the email (initials come from the local part). */
  name: string;
  size?: 20 | 28;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-pill bg-sunk font-mono font-medium text-muted",
        size === 20 ? "size-20 text-2xs" : "size-28 text-xs",
        className,
      )}
    >
      {initials(name) || "?"}
    </span>
  );
}

/** "You" for the viewer, else the first name (or the email's local part). */
export function shortPersonName(p: { name?: string | null; email: string }, isYou?: boolean): string {
  if (isYou) return "You";
  const name = p.name?.trim();
  if (name) return name.split(/\s+/)[0]!;
  return p.email.split("@")[0] || p.email;
}
