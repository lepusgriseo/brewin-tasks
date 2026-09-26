// Task search. No Obsidian imports → unit-testable.
//
// Subsequence matching rather than plain substring, so "blhy" finds "Bleed hydraulics" —
// but scored so that a real prefix or word-start match always outranks a scattered one.
// With near-identical titles in the vault ("Bleed hydraulics" / "Bleed hydraulics 2") the
// ordering matters more than whether something matches at all.

export interface Searchable {
  title: string;
  contexts: string[];
}

/** Where a query matched, best first. Higher scores are better matches. */
export interface SearchHit<T> {
  item: T;
  score: number;
}

const EXACT = 1000;
const PREFIX = 500;
const WORD_START = 300;
const SUBSTRING = 150;
const SUBSEQUENCE = 40;
const CONTEXT_MATCH = 60;

/**
 * Is `query` a subsequence of `text` (characters in order, gaps allowed)?
 * Returns a small bonus for adjacency so tighter matches score higher.
 */
function subsequenceScore(text: string, query: string): number | null {
  let ti = 0;
  let runs = 0;
  let lastHit = -2;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    const found = text.indexOf(ch, ti);
    if (found === -1) return null;
    if (found === lastHit + 1) runs++;
    lastHit = found;
    ti = found + 1;
  }
  return SUBSEQUENCE + runs * 4;
}

/** Score one item against a query. Null means no match at all. */
export function scoreMatch(item: Searchable, rawQuery: string): number | null {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return 0; // an empty query matches everything, neutrally
  const title = item.title.toLowerCase();

  let best: number | null = null;
  const bump = (n: number) => {
    if (best == null || n > best) best = n;
  };

  if (title === q) bump(EXACT);
  else if (title.startsWith(q)) bump(PREFIX);
  else {
    // Word-start beats a match buried mid-word: "hyd" should favour "Bleed hydraulics"
    // over something that merely contains those letters.
    if (title.split(/[\s\-_/]+/).some((w) => w.startsWith(q))) bump(WORD_START);
    else if (title.includes(q)) bump(SUBSTRING);
    else {
      const sub = subsequenceScore(title, q);
      if (sub != null) bump(sub);
    }
  }

  // A context match counts, but never outranks a title match.
  if (item.contexts.some((c) => c.toLowerCase().includes(q))) bump(CONTEXT_MATCH);

  if (best == null) return null;
  // Among equal-quality matches, prefer the shorter title — it's the more specific one.
  return best - Math.min(title.length, 99) / 100;
}

/**
 * Filter and rank. Ties break on title so the order is stable between renders rather than
 * depending on how the vault happened to be read.
 */
export function searchItems<T extends Searchable>(items: T[], query: string): SearchHit<T>[] {
  const out: SearchHit<T>[] = [];
  for (const item of items) {
    const score = scoreMatch(item, query);
    if (score == null) continue;
    out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
}

/** Just the matching items, ranked. */
export function search<T extends Searchable>(items: T[], query: string): T[] {
  return searchItems(items, query).map((h) => h.item);
}
