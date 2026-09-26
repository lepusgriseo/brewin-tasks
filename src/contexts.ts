// Context normalisation. No Obsidian imports → unit-testable.
//
// Contexts are free text, so the same one drifts into several spellings — this vault already
// holds `obsidian` ×25 alongside `Obsidian` ×1, and `work` ×4 alongside `Work` ×1. Those look
// identical in a list but filter as different values, so a filter on one silently hides the
// other's tasks.
//
// The rule: variants that differ only by case (and surrounding space) are the same context,
// and the **most-used spelling wins**. Typing "Obsidian" stores `obsidian`, because that's
// what 25 existing notes say. A genuinely new context is kept exactly as typed.

export interface ContextIndex {
  /** Canonical spelling → total uses, summed across every case variant. */
  counts: Map<string, number>;
  /** Lowercase key → the canonical spelling to use. */
  canonical: Map<string, string>;
  /** Every known context, most-used first — what the picker offers. */
  suggestions: string[];
}

function key(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Build the index from contexts actually in use plus any configured in settings.
 *
 * `used` may contain duplicates — that's the point, it's the raw list across all tasks.
 * `configured` entries are offered as suggestions even with zero uses, but never outrank a
 * spelling the vault actually uses.
 */
export function buildContextIndex(used: string[], configured: string[] = []): ContextIndex {
  // Count each exact spelling.
  const exact = new Map<string, number>();
  for (const raw of used) {
    const v = raw.trim();
    if (!v) continue;
    exact.set(v, (exact.get(v) ?? 0) + 1);
  }
  for (const raw of configured) {
    const v = raw.trim();
    if (!v) continue;
    if (!exact.has(v)) exact.set(v, 0); // known, but unused
  }

  // Group case-insensitively and pick a winner per group.
  const groups = new Map<string, { spelling: string; uses: number }[]>();
  for (const [spelling, uses] of exact) {
    const k = key(spelling);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push({ spelling, uses });
  }

  const counts = new Map<string, number>();
  const canonical = new Map<string, string>();
  const configuredSet = new Set(configured.map((c) => c.trim()));

  for (const [k, variants] of groups) {
    const total = variants.reduce((n, v) => n + v.uses, 0);
    const winner = [...variants].sort(
      (a, b) =>
        b.uses - a.uses ||
        // Tie: prefer a spelling the user configured, then settle it alphabetically so the
        // result never depends on file-read order.
        Number(configuredSet.has(b.spelling)) - Number(configuredSet.has(a.spelling)) ||
        a.spelling.localeCompare(b.spelling)
    )[0].spelling;
    canonical.set(k, winner);
    counts.set(winner, total);
  }

  const suggestions = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([spelling]) => spelling);

  return { counts, canonical, suggestions };
}

/**
 * The spelling to actually store for `input`. Unknown contexts come back trimmed but
 * otherwise untouched — inventing a canonical form for something new would be wrong.
 */
export function canonicaliseContext(input: string, index: ContextIndex): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return index.canonical.get(key(trimmed)) ?? trimmed;
}

/**
 * Parse a comma-separated field into canonical contexts, dropping blanks and duplicates
 * (including duplicates that only appear once canonicalised — "work, Work" is one context).
 * Order of first appearance is kept.
 */
export function parseContexts(raw: string, index: ContextIndex): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const c = canonicaliseContext(part, index);
    if (!c) continue;
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Add or remove one context from a list, canonicalising and keeping it duplicate-free. */
export function toggleContext(list: string[], value: string, index: ContextIndex): string[] {
  const c = canonicaliseContext(value, index);
  if (!c) return list;
  const k = key(c);
  return list.some((x) => key(x) === k) ? list.filter((x) => key(x) !== k) : [...list, c];
}

/** Spellings that disagree with their canonical form — the tidy-up list. */
export function strayContexts(index: ContextIndex, used: string[]): { from: string; to: string; uses: number }[] {
  const seen = new Map<string, number>();
  for (const raw of used) {
    const v = raw.trim();
    if (!v) continue;
    seen.set(v, (seen.get(v) ?? 0) + 1);
  }
  const out: { from: string; to: string; uses: number }[] = [];
  for (const [spelling, uses] of seen) {
    const canon = index.canonical.get(key(spelling));
    if (canon && canon !== spelling) out.push({ from: spelling, to: canon, uses });
  }
  return out.sort((a, b) => b.uses - a.uses || a.from.localeCompare(b.from));
}

/** Case-insensitive membership — `obsidian` matches a task tagged `Obsidian`. */
export function hasContext(list: string[], value: string): boolean {
  const k = key(value);
  return list.some((c) => key(c) === k);
}

/**
 * Contexts worth offering as a filter: those carried by at least one **open** task, with
 * their open-task counts, most-used first.
 *
 * Done tasks are excluded deliberately. A context whose only tasks are finished offers a
 * filter that can never show anything — which is exactly how `Obsidian` came to sit in the
 * list looking selectable while every view came back empty.
 */
export function filterableContexts(
  tasks: { contexts: string[]; status: string }[]
): { value: string; count: number }[] {
  const open = tasks.filter((t) => t.status !== "done");
  const index = buildContextIndex(open.flatMap((t) => t.contexts));
  return index.suggestions.map((value) => ({ value, count: index.counts.get(value) ?? 0 }));
}
