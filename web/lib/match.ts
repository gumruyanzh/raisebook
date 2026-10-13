/**
 * Palette ranking (no React): diacritic-insensitive scoring, stable ranking and match
 * ranges for highlighting. Re-exported by `lib/commands.ts`.
 */

/** Lowercase and strip diacritics: "São Paulo" → "sao paulo". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Score a label against a query (higher is better, 0 = no match): exact > prefix > word
 * prefix > keyword > substring > in-order subsequence. Every query word must match.
 */
export function scoreText(label: string, query: string, keywords: string[] = []): number {
  const q = fold(query).trim();
  if (!q) return 1;
  const l = fold(label);
  const words = q.split(/\s+/);
  if (l === q) return 1000;
  if (l.startsWith(q)) return 900 - Math.min(l.length, 100) / 1000;
  const lw = l.split(/[\s·,./@()-]+/).filter(Boolean);
  if (words.every((w) => lw.some((x) => x.startsWith(w)))) return 800;
  const kws = keywords.map(fold);
  if (kws.some((k) => k === q)) return 700;
  if (kws.some((k) => k.startsWith(q))) return 600;
  if (words.every((w) => l.includes(w) || kws.some((k) => k.includes(w)))) return 500;
  let i = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    i = l.indexOf(ch, i);
    if (i < 0) return 0;
    i += 1;
  }
  return 100;
}

/** Ranked matches, stable for ties. */
export function rankBy<T>(items: T[], query: string, text: (t: T) => string, keywords?: (t: T) => string[]): T[] {
  if (!query.trim()) return items;
  return items
    .map((it, idx) => ({ it, idx, s: scoreText(text(it), query, keywords?.(it)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map((x) => x.it);
}

/** Query match ranges in `text` for highlighting (case- and diacritic-insensitive). */
export function matchRanges(text: string, query: string): [number, number][] {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const f = fold(text);
  const out: [number, number][] = [];
  for (const w of words) {
    const at = f.indexOf(w);
    if (at >= 0) out.push([at, at + w.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
