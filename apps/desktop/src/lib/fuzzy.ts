/**
 * Lightweight fuzzy path matching for Quick Open.
 * Subsequence match with scoring: consecutive hits, word starts
 * (after `/`, `.`, `-`, `_`) and basename hits rank higher.
 */

/** Score a candidate against a query — null when not a subsequence match. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let qi = 0;
  let streak = 0;
  const basename = c.lastIndexOf("/") + 1;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) {
      streak = 0;
      continue;
    }
    streak += 1;
    score += 1 + streak * 2;
    // Word/basename starts and camelCase boundaries are stronger hits.
    const prev = c[i - 1];
    if (i === 0 || prev === "/" || prev === "." || prev === "-" || prev === "_") score += 6;
    if (i >= basename) score += 2;
    qi += 1;
  }
  if (qi < q.length) return null;
  // Prefer shorter paths and earlier first-match.
  return score - c.length * 0.01;
}

/** Ranked, capped filter over path candidates. */
export function fuzzyFilter(query: string, candidates: string[], cap = 50): string[] {
  const q = query.trim();
  if (!q) return candidates.slice(0, cap);
  return candidates
    .map((p) => ({ p, s: fuzzyScore(q, p) }))
    .filter((x): x is { p: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, cap)
    .map((x) => x.p);
}
