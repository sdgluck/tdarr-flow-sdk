/**
 * Subsequence fuzzy matching, scored so the obvious answer comes first.
 *
 * Plugin ids are long, uniformly prefixed strings - `Tdarr_Plugin_MC93_Migz1FFMPEG`,
 * `Tdarr_Plugin_bsh1_RemuxMKV` - which is exactly the case a plain substring
 * search handles badly: every entry matches `tdarr_plugin`, and nothing
 * distinguishes them. Typing `migz` or `remuxmkv` should land on one.
 *
 * Scoring rewards, in order of weight: matching at a word boundary (after `_`,
 * `-`, a space or a case change), matching consecutively, and matching early.
 * A short candidate wins a tie, because a query that fully describes a short
 * name is more likely to have meant it.
 */

export interface FuzzyResult<T> {
  item: T;
  score: number;
}

const BOUNDARY = /[\s_\-./]/;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  if (BOUNDARY.test(previous)) return true;
  // A lower-to-upper transition starts a word in camelCase and PascalCase.
  return previous === previous.toLowerCase() && text[index] !== text[index]!.toLowerCase();
}

/**
 * How well `query` matches `text`, or `null` when it does not match at all.
 * Higher is better; the scale is arbitrary and only meaningful for sorting.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const haystack = text.toLowerCase();
  if (needle.length > haystack.length) return null;

  // A plain substring hit is always at least as good as a scattered one.
  const direct = haystack.indexOf(needle);
  if (direct !== -1) {
    return 1000
      + (isBoundary(text, direct) ? 400 : 0)
      + Math.max(0, 100 - direct)
      + Math.max(0, 60 - (text.length - needle.length));
  }

  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;

    score += 10;
    if (isBoundary(text, found)) score += 30;
    if (found === previousIndex + 1) score += 20;
    score -= Math.min(10, found - cursor);

    previousIndex = found;
    cursor = found + 1;
  }

  return score + Math.max(0, 40 - (text.length - needle.length) / 4);
}

/**
 * Ranks `items` against a query. An empty query returns everything in its
 * original order, which is what a freshly-opened picker should show.
 */
export function fuzzySearch<T>(
  query: string,
  items: readonly T[],
  /** Fields to match against, most significant first. */
  fields: (item: T) => readonly string[],
): FuzzyResult<T>[] {
  if (!query.trim()) return items.map((item) => ({ item, score: 0 }));

  const results: FuzzyResult<T>[] = [];

  for (const item of items) {
    let best: number | null = null;
    fields(item).forEach((field, position) => {
      const score = fuzzyScore(query, field);
      if (score === null) return;
      // Later fields are weaker evidence than the name a user was aiming at.
      const weighted = score - position * 25;
      if (best === null || weighted > best) best = weighted;
    });

    if (best !== null) results.push({ item, score: best });
  }

  return results.sort((a, b) => b.score - a.score);
}
