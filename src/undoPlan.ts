// What an action changed, and how to put it back. The stores record these as they write while an
// action is being recorded (undo.ts); Undo replays them backwards. Pure, no Obsidian imports.
//
// A property write keeps only the properties it changed, as they were — so taking it back leaves
// alone anything else written to the note since (a sync, a Base, the timer). A note's text is put
// back only if it is still exactly as the action left it; otherwise that change is skipped and said.

/** One property as it was before a write: its value, or that it wasn't there. */
export interface Before {
  had: boolean;
  value?: unknown;
}

export type Change =
  /** Properties a write changed, as they were before it. */
  | { kind: "fm"; path: string; keys: Record<string, Before> }
  /** A note's whole text, before and after an edit to it (a project step, a log line, a body). */
  | { kind: "text"; path: string; before: string; after: string }
  /** A note the action made. */
  | { kind: "create"; path: string }
  /** A note the action deleted, and what it held. */
  | { kind: "trash"; path: string; content: string }
  /** A note the action moved or renamed. */
  | { kind: "rename"; from: string; to: string };

const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The properties `after` differs from `before` in, as they were in `before`. Empty when nothing changed. */
export function propertyChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, Before> {
  const out: Record<string, Before> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const had = has(before, key);
    if (had === has(after, key) && JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    out[key] = had ? { had: true, value: copy(before[key]) } : { had: false };
  }
  return out;
}

/** Put the properties a write changed back as they were (in place, on the note's frontmatter). */
export function restoreProperties(fm: Record<string, unknown>, keys: Record<string, Before>): void {
  for (const [key, b] of Object.entries(keys)) {
    if (b.had) fm[key] = copy(b.value);
    else delete fm[key];
  }
}

/**
 * A note's text with an edit taken back — or null when the note has changed since the edit, so
 * putting back the old text would throw away whatever was written after it.
 */
export function restoreText(current: string, c: { before: string; after: string }): string | null {
  return current === c.after ? c.before : null;
}

/**
 * The changes of one action, ready to record: property writes to the same note (and nothing in
 * between that moved it) are folded into one, keeping the earliest state of each property.
 */
export function compactChanges(changes: Change[]): Change[] {
  const out: Change[] = [];
  for (const c of changes) {
    const prev = out[out.length - 1];
    if (c.kind === "fm" && prev?.kind === "fm" && prev.path === c.path) {
      for (const [k, b] of Object.entries(c.keys)) if (!has(prev.keys, k)) prev.keys[k] = b;
      continue;
    }
    if (c.kind === "text" && prev?.kind === "text" && prev.path === c.path && prev.after === c.before) {
      prev.after = c.after;
      continue;
    }
    out.push(c.kind === "fm" ? { ...c, keys: { ...c.keys } } : { ...c });
  }
  // A property write that changed nothing worth keeping (every key back where it started) is dropped.
  return out.filter((c) => c.kind !== "fm" || Object.keys(c.keys).length > 0);
}

/** How a change is described when it couldn't be taken back. */
export function changeName(c: Change): string {
  const name = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
  switch (c.kind) {
    case "fm":
    case "text":
    case "create":
    case "trash":
      return name(c.path);
    case "rename":
      return name(c.to);
  }
}
