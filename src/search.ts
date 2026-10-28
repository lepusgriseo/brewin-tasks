// Task search. No Obsidian imports → unit-testable.
//
// Subsequence matching rather than plain substring, so "blhy" finds "Bleed hydraulics" —
// but scored so that a real prefix or word-start match always outranks a scattered one.
// With near-identical titles in the vault ("Bleed hydraulics" / "Bleed hydraulics 2") the
// ordering matters more than whether something matches at all.

import type { Priority, Task } from "./types";
import { shiftISO } from "./dates";

export interface Searchable {
  title: string;
  contexts: string[];
  /** The user's own attribute values (text, choices, links, numbers) — they count like a context. */
  attrs?: Record<string, string | number | boolean>;
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
  // So does an attribute's value: "kitchen" finds Room: Kitchen, "mum" finds Client: [[Mum]].
  if (Object.values(item.attrs ?? {}).some((v) => typeof v !== "boolean" && String(v).toLowerCase().includes(q))) bump(CONTEXT_MATCH);

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

// ── Operators ─────────────────────────────────────────────────────────────────────────────────
//
// The search box narrows by what a task is as well as what it says: `@home !high due:week -bins
// "phone the"`. Filters apply first; the words left over are matched as above. Anything with a colon
// the Planner doesn't know ("Re: dentist") stays a word, so a title with a colon is still found.


export type DateWhen = "today" | "tomorrow" | "week" | "overdue" | "none" | "any" | { on: string } | { before: string } | { after: string };
export type IsWhat = "recurring" | "someday" | "hold" | "done" | "open" | "blocked" | "timed" | "top" | "overdue";
export type HasWhat = "estimate" | "time" | "due" | "date" | "project" | "checklist" | "flag";

export type QueryFilter = { negate: boolean } & (
  | { kind: "context"; value: string }
  | { kind: "priority"; value: Priority }
  | { kind: "date"; field: "due" | "scheduled"; when: DateWhen }
  | { kind: "is"; value: IsWhat }
  | { kind: "has"; value: HasWhat }
  | { kind: "project"; value: string }
  | { kind: "flag"; value: string }
  | { kind: "attr"; key: string; value: string }
);

export interface ParsedQuery {
  /** The words left for the fuzzy match. */
  text: string;
  /** Phrases a title must hold ("…"), and words or phrases it mustn't (-word). */
  phrases: string[];
  exclude: string[];
  filters: QueryFilter[];
  /** Operators with a value the Planner doesn't understand — said back, not silently ignored. */
  unknown: string[];
}

const IS: IsWhat[] = ["recurring", "someday", "hold", "done", "open", "blocked", "timed", "top", "overdue"];
const HAS: HasWhat[] = ["estimate", "time", "due", "date", "project", "checklist", "flag"];

/** Every operator, for the search box's "?". */
export const QUERY_HELP: [string, string][] = [
  ["@home", "has the context (-@home: hasn't)"],
  ["!high  !normal  !low", "priority"],
  ["due:today  due:tomorrow  due:week  due:overdue", "deadline: today, tomorrow, the next 7 days, passed"],
  ["due:none  due:any  due:2026-11-02  due:<2026-11-02  due:>2026-11-02", "no deadline, any, on, before, after"],
  ["sched:…", "the same, for the planned day"],
  ["is:recurring  is:someday  is:hold  is:done  is:open", "what it is"],
  ["is:blocked  is:timed  is:top  is:overdue", "waiting on another task, has a time, one of today's top 3, past due"],
  ["has:estimate  has:time  has:due  has:date  has:project  has:checklist  has:flag", "what it has (time: focus time logged)"],
  ["project:ccnp  flag:waiting", "in a project, with a status flag (names, in part)"],
  ["energy:high", "one of your own attributes"],
  ["-word  \"a phrase\"  -\"a phrase\"", "leave out, match as written, leave out as written"],
];

/** Split on spaces, keeping "quoted phrases" (and -"quoted") whole. */
function tokens(q: string): string[] {
  return q.match(/-?"[^"]*"?|\S+/g) ?? [];
}

function readWhen(v: string): DateWhen | null {
  const s = v.toLowerCase();
  if (["today", "tomorrow", "week", "overdue", "none", "any"].includes(s)) return s as DateWhen;
  const m = /^([<>]?)(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (!m) return null;
  return m[1] === "<" ? { before: m[2] } : m[1] === ">" ? { after: m[2] } : { on: m[2] };
}

/** A query read into filters, phrases and the words left. `attrKeys` are the user's own attributes. */
export function parseQuery(q: string, attrKeys: readonly string[] = []): ParsedQuery {
  const out: ParsedQuery = { text: "", phrases: [], exclude: [], filters: [], unknown: [] };
  const words: string[] = [];
  const keys = new Map(attrKeys.map((k) => [k.toLowerCase(), k]));
  for (const raw of tokens(q)) {
    const negate = raw.startsWith("-") && raw.length > 1;
    const tok = negate ? raw.slice(1) : raw;
    if (tok.startsWith('"')) {
      const phrase = tok.replace(/^"|"$/g, "").trim().toLowerCase();
      if (phrase) (negate ? out.exclude : out.phrases).push(phrase);
      continue;
    }
    if (/^@[\w/-]+$/.test(tok)) {
      out.filters.push({ kind: "context", value: tok.slice(1).toLowerCase(), negate });
      continue;
    }
    const pri = /^!(high|med|medium|normal|low|!|[123])$/i.exec(tok);
    if (pri) {
      const v = pri[1].toLowerCase();
      out.filters.push({ kind: "priority", value: v === "high" || v === "!" || v === "1" ? "high" : v === "low" || v === "3" ? "low" : "normal", negate });
      continue;
    }
    const op = /^([\w-]+):(.+)$/.exec(tok);
    if (op) {
      const key = op[1].toLowerCase();
      const value = op[2];
      if (key === "due" || key === "sched" || key === "scheduled") {
        const when = readWhen(value);
        if (when) out.filters.push({ kind: "date", field: key === "due" ? "due" : "scheduled", when, negate });
        else out.unknown.push(raw);
        continue;
      }
      if (key === "is" || key === "has") {
        const v = value.toLowerCase();
        if (key === "is" && (IS as string[]).includes(v)) out.filters.push({ kind: "is", value: v as IsWhat, negate });
        else if (key === "has" && (HAS as string[]).includes(v)) out.filters.push({ kind: "has", value: v as HasWhat, negate });
        else out.unknown.push(raw);
        continue;
      }
      if (key === "project" || key === "flag") {
        out.filters.push({ kind: key, value: value.toLowerCase(), negate });
        continue;
      }
      const attr = keys.get(key);
      if (attr) {
        out.filters.push({ kind: "attr", key: attr, value: value.toLowerCase(), negate });
        continue;
      }
    }
    if (negate) out.exclude.push(tok.toLowerCase());
    else words.push(raw);
  }
  out.text = words.join(" ");
  return out;
}

export interface FilterContext {
  today: string;
  /** Has a dependency still open. */
  blocked: (t: Task) => boolean;
}

function dateMatches(d: string | null | undefined, when: DateWhen, today: string): boolean {
  if (when === "none") return !d;
  if (!d) return false;
  if (when === "any") return true;
  if (when === "today") return d === today;
  if (when === "tomorrow") return d === shiftISO(today, 1);
  if (when === "week") return d >= today && d <= (shiftISO(today, 6) ?? today);
  if (when === "overdue") return d < today;
  if ("on" in when) return d === when.on;
  if ("before" in when) return d < when.before;
  return d > when.after;
}

function filterMatches(t: Task, f: QueryFilter, c: FilterContext): boolean {
  switch (f.kind) {
    case "context":
      return t.contexts.some((x) => x.toLowerCase() === f.value);
    case "priority":
      return t.priority === f.value;
    case "date":
      return dateMatches(f.field === "due" ? t.due : t.scheduled, f.when, c.today);
    case "is":
      switch (f.value) {
        case "recurring": return !!t.recurrence;
        case "someday": case "hold": case "done": return t.status === f.value;
        case "open": return t.status !== "done";
        case "blocked": return c.blocked(t);
        case "timed": return !!t.startTime;
        case "top": return t.top === c.today;
        case "overdue": return !!t.due && t.due < c.today && t.status !== "done";
      }
      return false;
    case "has":
      switch (f.value) {
        case "estimate": return t.estimate != null;
        case "time": return (t.timeLog?.length ?? 0) > 0;
        case "due": return !!t.due;
        case "date": return !!(t.scheduled || t.due);
        case "project": return !!t.projectPath;
        case "checklist": return !!t.checklist;
        case "flag": return !!t.flag;
      }
      return false;
    case "project":
      return !!t.projectPath && (t.projectPath.split("/").pop() ?? "").toLowerCase().includes(f.value);
    case "flag":
      return !!t.flag && (t.flag.label.toLowerCase().includes(f.value) || t.flag.id.toLowerCase() === f.value);
    case "attr": {
      const v = t.attrs?.[f.key];
      if (v === undefined || v === null) return false;
      if (typeof v === "boolean") return v === ["yes", "true", "1"].includes(f.value);
      return String(v).toLowerCase().includes(f.value);
    }
  }
}

/** Tasks narrowed by a query's filters, phrases and leave-outs, then ranked by its words. */
export function searchTasks(tasks: Task[], q: ParsedQuery, c: FilterContext): Task[] {
  const kept = tasks.filter((t) => {
    const title = t.title.toLowerCase();
    if (q.phrases.some((p) => !title.includes(p))) return false;
    if (q.exclude.some((w) => title.includes(w))) return false;
    return q.filters.every((f) => filterMatches(t, f, c) !== f.negate);
  });
  return q.text.trim() ? search(kept, q.text) : kept;
}
