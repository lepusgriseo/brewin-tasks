// Edits made outside the Planner — a Base's table, the Properties panel, another plugin, a sync from
// a device that did the same — reach a task note without the Planner's rules. This decides what the
// Planner does about a change it sees, so the note ends up as if the Planner had made it:
//
//   - set to done              → it gets today as its completed date
//   - a repeating task to done → that occurrence is ticked and the task moves on to its next date,
//                                rather than leaving the whole series done for ever. (Done *with* a
//                                completed date is how the Planner ends a series, so that is left be.)
//   - opened up again          → its completed date goes
//   - a status flag picked     → the status it stands for comes with it
//   - a status changed under a flag that no longer fits → the flag goes, as when the Planner does it
//
// Only a change is acted on — a note is compared with how it was last seen — so an untouched note is
// never rewritten, and the Planner's own writes (which already follow the rules) lead to nothing.
// Pure, no Obsidian imports.

import { findFlag, StatusFlag } from "./statusFlags";
import { Status } from "./types";

/** What reconciling needs to know about a task note, from its frontmatter. */
export interface SeenTask {
  status: Status;
  /** `flag:` as written, whether or not it fits the status. */
  flag: string | null;
  completed: string | null;
  recurring: boolean;
}

export type Repair =
  | { kind: "write"; status?: Status; flag?: null; completed?: string | null }
  /** A repeating task set to done: tick the occurrence through the Planner, which moves it on. */
  | { kind: "occurrence" };

const STATUSES: Status[] = ["todo", "hold", "someday", "done"];

/** A frontmatter record as `SeenTask` — read the way the Planner reads it. */
export function seenFrom(fm: Record<string, unknown>): SeenTask {
  const raw = String(fm.status ?? "todo").toLowerCase();
  const done = fm.completed;
  return {
    status: (STATUSES as string[]).includes(raw) ? (raw as Status) : "todo",
    flag: fm.flag == null || fm.flag === "" ? null : String(fm.flag),
    completed: done == null || done === "" || typeof done === "boolean" ? null : String(done).slice(0, 10),
    recurring: !!fm.recurrence,
  };
}

/** What to do about a note seen as `now`, last seen as `before`; null for nothing. */
export function reconcile(before: SeenTask | undefined, now: SeenTask, flags: readonly StatusFlag[], today: string): Repair | null {
  if (!before) return null;
  const flagChanged = now.flag !== before.flag;
  const statusChanged = now.status !== before.status;
  if (!flagChanged && !statusChanged) return null;

  // A flag picked by hand: its status comes with it.
  const flag = flagChanged ? findFlag(flags, now.flag) : null;
  if (flag && flag.base !== now.status) {
    if (now.recurring && (flag.base === "done" || flag.base === "someday")) return { kind: "write", flag: null };
    if (flag.base === "done") return { kind: "write", status: "done", completed: now.completed ?? today };
    return { kind: "write", status: flag.base, ...(now.status === "done" && now.completed ? { completed: null } : {}) };
  }

  if (!statusChanged) return null;
  if (now.status === "done" && now.recurring) return now.completed ? null : { kind: "occurrence" };
  const patch: { kind: "write"; flag?: null; completed?: string | null } = { kind: "write" };
  if (now.status === "done" && !now.completed) patch.completed = today;
  if (before.status === "done" && now.status !== "done" && now.completed) patch.completed = null;
  // The status moved away from what the note's flag stands for: the flag goes, as when the Planner moves it.
  const kept = findFlag(flags, now.flag);
  if (kept && kept.base !== now.status) patch.flag = null;
  return Object.keys(patch).length > 1 ? patch : null;
}
