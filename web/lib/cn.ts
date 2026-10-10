/** Joins class names, skipping falsy values. No merging: tokens are few and explicit. */
export function cn(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(" ");
}
