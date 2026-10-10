import Link from "next/link";

import { cn } from "@/lib/cn";

const SIZE = { 20: "text-[20px]", 22: "text-[22px]", 28: "text-[28px]" } as const;

/** "Raisebook" in Bricolage 700 (SYSTEM 3.28). Sizes: 20 app bar, 22 marketing nav, 28 sign-in. */
export function Wordmark({
  size = 20,
  href,
  className,
}: {
  size?: keyof typeof SIZE;
  href?: string;
  className?: string;
}) {
  const cls = cn(
    "font-display leading-none font-bold tracking-[-0.02em] text-fg [font-variation-settings:'opsz'_48]",
    SIZE[size],
    className,
  );
  if (href) {
    return (
      <Link href={href} className={cls} aria-label="Raisebook home">
        Raisebook
      </Link>
    );
  }
  return <span className={cls}>Raisebook</span>;
}
