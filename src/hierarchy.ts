// Pure parent→child task hierarchy logic. No Obsidian imports → unit-testable.
//
// The link is stored on the CHILD (`parent:` frontmatter), so children are derived by
// scanning. `Task.parentPath` is the resolved vault path (the store fills it in), which
// keeps this layer robust to two tasks sharing a basename.

import { Task } from "./types";

export interface TaskIndex {
  byPath: Map<string, Task>;
  /** parentPath → its direct children, in stable title order. */
  children: Map<string, Task[]>;
}

export function buildIndex(tasks: Task[]): TaskIndex {
  const byPath = new Map<string, Task>();
  const children = new Map<string, Task[]>();
  for (const t of tasks) byPath.set(t.path, t);
  for (const t of tasks) {
    if (!t.parentPath || !byPath.has(t.parentPath)) continue;
    const list = children.get(t.parentPath) ?? [];
    list.push(t);
    children.set(t.parentPath, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  return { byPath, children };
}

export function childrenOf(index: TaskIndex, task: Task): Task[] {
  return index.children.get(task.path) ?? [];
}

export function hasChildren(index: TaskIndex, task: Task): boolean {
  return childrenOf(index, task).length > 0;
}

/**
 * Children that are not finished. A `hold` child counts as open — it still blocks its
 * parent (deliberate, strict reading of "a parent isn't done until all children are").
 */
export function openChildren(index: TaskIndex, task: Task): Task[] {
  return childrenOf(index, task).filter((c) => c.status !== "done");
}

export function progressOf(index: TaskIndex, task: Task): { done: number; total: number } {
  const kids = childrenOf(index, task);
  return { done: kids.filter((c) => c.status === "done").length, total: kids.length };
}

/**
 * May this task be completed? Only DIRECT children need checking: a child with open
 * grandchildren cannot itself be done, so an ancestor is transitively blocked too.
 */
export function canComplete(index: TaskIndex, task: Task): boolean {
  return openChildren(index, task).length === 0;
}

/** Ancestors nearest-first (parent, grandparent, …). Cycle-safe. */
export function ancestorsOf(index: TaskIndex, task: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>([task.path]);
  let cur = task.parentPath ? index.byPath.get(task.parentPath) : undefined;
  while (cur && !seen.has(cur.path)) {
    out.push(cur);
    seen.add(cur.path);
    cur = cur.parentPath ? index.byPath.get(cur.parentPath) : undefined;
  }
  return out;
}

/** Every descendant of `task` (depth-first). Cycle-safe. */
export function descendantsOf(index: TaskIndex, task: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>([task.path]);
  const walk = (t: Task) => {
    for (const c of childrenOf(index, t)) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push(c);
      walk(c);
    }
  };
  walk(task);
  return out;
}

/**
 * Would setting `task.parent = newParentPath` create a cycle? True when the target is the
 * task itself or one of its descendants.
 */
export function wouldCreateCycle(index: TaskIndex, task: Task, newParentPath: string | null): boolean {
  if (!newParentPath) return false;
  if (newParentPath === task.path) return true;
  return descendantsOf(index, task).some((d) => d.path === newParentPath);
}

/** Tasks that may be offered as a parent for `task` (excludes itself + its descendants). */
export function validParentCandidates(index: TaskIndex, task: Task | null, all: Task[]): Task[] {
  if (!task) return all;
  const banned = new Set<string>([task.path, ...descendantsOf(index, task).map((d) => d.path)]);
  return all.filter((t) => !banned.has(t.path));
}
