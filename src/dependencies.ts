// Pure task-dependency logic. No Obsidian imports so it is unit-testable.
//
// Mirrors hierarchy.ts's shape (open-blockers, cycle check, valid-candidate filter) but over a
// flat "depends on" relation rather than a parent/child tree. Confirmed with the user:
// dependencies block completion ONLY — no effect on dates, scheduling, or where a task appears.

import { Task } from "./types";

/** Dependencies of `task` that aren't done yet — these are what block it from completing. */
export function openDependencies(tasks: Task[], task: Task): Task[] {
  if (!task.dependsOnPaths?.length) return [];
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  const out: Task[] = [];
  for (const path of task.dependsOnPaths) {
    const dep = byPath.get(path);
    if (dep && dep.status !== "done") out.push(dep);
  }
  return out;
}

/**
 * Would adding `candidatePath` as a dependency of `task` create a cycle? True for a direct
 * self-dependency, or when `candidatePath` already (transitively) depends on `task` — making
 * `task` depend on it too would close the loop.
 */
export function wouldCreateDependencyCycle(tasks: Task[], task: Task, candidatePath: string): boolean {
  if (candidatePath === task.path) return true;
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  const seen = new Set<string>();
  const stack = [candidatePath];
  while (stack.length) {
    const path = stack.pop()!;
    if (path === task.path) return true;
    if (seen.has(path)) continue;
    seen.add(path);
    const t = byPath.get(path);
    for (const dep of t?.dependsOnPaths ?? []) stack.push(dep);
  }
  return false;
}

/**
 * Every task that could safely be added as a dependency of `task` right now — itself, anything
 * already a dependency, and anything that would create a cycle are excluded. `task: null` (a
 * brand-new, not-yet-saved task) has nothing to exclude on cycle grounds, so every task qualifies.
 */
export function validDependencyCandidates(tasks: Task[], task: Task | null): Task[] {
  if (!task) return tasks;
  const existing = new Set(task.dependsOnPaths ?? []);
  return tasks.filter(
    (t) => t.path !== task.path && !existing.has(t.path) && !wouldCreateDependencyCycle(tasks, task, t.path)
  );
}
