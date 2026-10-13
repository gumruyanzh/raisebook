/**
 * Ranked, diacritic-insensitive matching for pickers (Combobox, TimezonePicker,
 * CurrencyPicker). Pure and framework-free, so `node --test` can exercise it.
 *
 * Tiers, best first: exact label, label prefix, word prefix in the label, keyword exact,
 * keyword prefix, word prefix in a keyword, substring anywhere, in-order subsequence in the
 * label. Ties keep the original order (Array.prototype.sort is stable).
 */

export interface Rankable {
  label: string;
  keywords?: string[];
  disabled?: boolean;
}

const MARKS = /[̀-ͯ]/g;

/** Lowercase, strip diacritics ("São" → "sao"), fold "_" and runs of space to one space. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(MARKS, "").toLowerCase().replace(/[_\s]+/g, " ").trim();
}

/**
 * `fold` that also returns, for each folded character, its index in the original string, so
 * a match in the folded text can be highlighted in the original.
 */
export function foldWithMap(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const base = ch.normalize("NFD").replace(MARKS, "").toLowerCase();
    for (const c of base) {
      const isSpace = c === "_" || /\s/.test(c);
      if (isSpace) {
        if (prevSpace) continue;
        text += " ";
        map.push(i);
        prevSpace = true;
      } else {
        text += c;
        map.push(i);
        prevSpace = false;
      }
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** Word starts: after a space, "/", "-", "(", "." or a lower→upper change in the original. */
function wordPrefix(hay: string, q: string): boolean {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) return false;
    if (i === 0 || /[\s/\-(.,·]/.test(hay[i - 1]!)) return true;
    from = i + 1;
  }
}

function subsequence(hay: string, q: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < q.length; i++) if (hay[i] === q[j]) j++;
  return j === q.length;
}

/** Score of one folded label + folded keywords against a folded query; lower is better, -1 = no match. */
export function scoreFolded(label: string, keywords: readonly string[], q: string): number {
  if (!q) return 0;
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (wordPrefix(label, q)) return 2;
  for (const k of keywords) if (k === q) return 3;
  for (const k of keywords) if (k.startsWith(q)) return 4;
  for (const k of keywords) if (wordPrefix(k, q)) return 5;
  if (label.includes(q)) return 6;
  for (const k of keywords) if (k.includes(q)) return 6;
  if (q.length > 1 && subsequence(label.replace(/ /g, ""), q.replace(/ /g, ""))) return 7;
  return -1;
}

/** Rank `options` against `query`. An empty query returns the list unchanged. */
export function rankOptions<T extends Rankable>(options: readonly T[], query: string): T[] {
  const q = fold(query);
  if (!q) return options.slice();
  const scored: { o: T; s: number; i: number }[] = [];
  options.forEach((o, i) => {
    const s = scoreFolded(fold(o.label), (o.keywords ?? []).map(fold), q);
    if (s >= 0) scored.push({ o, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.map((x) => x.o);
}

/**
 * Character ranges of `text` to emphasize for `query`: the first word-start occurrence (or
 * any occurrence) of the folded query, else the in-order subsequence. Returns [start, end)
 * pairs in original-string indexes, merged.
 */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = fold(query);
  if (!q) return [];
  const { text: hay, map } = foldWithMap(text);
  let at = -1;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) break;
    if (at < 0) at = i;
    if (i === 0 || /[\s/\-(.,·]/.test(hay[i - 1]!)) {
      at = i;
      break;
    }
    from = i + 1;
  }
  const idx: number[] = [];
  if (at >= 0) {
    for (let k = at; k < at + q.length; k++) idx.push(k);
  } else {
    let j = 0;
    const qq = q.replace(/ /g, "");
    for (let i = 0; i < hay.length && j < qq.length; i++) {
      if (hay[i] === qq[j]) {
        idx.push(i);
        j++;
      }
    }
    if (j < qq.length) return [];
  }
  const ranges: [number, number][] = [];
  for (const k of idx) {
    const start = map[k]!;
    let end = start + 1;
    while (end < text.length && /[\u0300-\u036f]/.test(text[end]!)) end++; // trailing combining marks
    const last = ranges[ranges.length - 1];
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}
