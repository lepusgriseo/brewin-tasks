// Pure auto-scheduling logic. No Obsidian imports so it is unit-testable.
//
// Confirmed shape with the user: fill TODAY's free gaps only (not a multi-day spread), assign
// real time slots sized from each task's estimate, and keep same-context tasks adjacent rather
// than scattering them — minimising context-switching is worth more here than packing every
// last minute.

import { mergeIntervals } from "./timeTracking";
import { Task } from "./types";

/**
 * The complement of `busy` (already-committed time) within `[windowStart, windowEnd]` — all
 * times in minutes-of-day. Gaps shorter than `minGapMinutes` are dropped as not worth using.
 */
export function freeGapsToday(
  busy: [number, number][],
  windowStart: number,
  windowEnd: number,
  minGapMinutes = 5
): [number, number][] {
  if (windowStart >= windowEnd) return [];

  const clipped = mergeIntervals(busy)
    .map(([s, e]): [number, number] => [Math.max(s, windowStart), Math.min(e, windowEnd)])
    .filter(([s, e]) => e > s);

  const gaps: [number, number][] = [];
  let cursor = windowStart;
  for (const [s, e] of clipped) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < windowEnd) gaps.push([cursor, windowEnd]);

  return gaps.filter(([s, e]) => e - s >= minGapMinutes);
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
function byPriorityThenTitle(a: Task, b: Task): number {
  return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || a.title.localeCompare(b.title);
}

/**
 * Order tasks so ones sharing a context land next to each other, without losing priority as
 * the primary sort: each context bucket is placed by the BEST (highest-priority) task it
 * contains, ties broken alphabetically by context name for a stable order; within a bucket,
 * tasks are priority-then-title as usual. A task with no context is its own bucket ("").
 */
export function groupByContext(tasks: Task[]): Task[] {
  const buckets = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.contexts[0] ?? "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }
  return [...buckets.entries()]
    .map(([context, list]) => ({
      context,
      list: [...list].sort(byPriorityThenTitle),
      bestRank: Math.min(...list.map((t) => PRIORITY_RANK[t.priority] ?? 1)),
    }))
    .sort((a, b) => a.bestRank - b.bestRank || a.context.localeCompare(b.context))
    .flatMap((g) => g.list);
}

export interface Placement {
  task: Task;
  /** Minutes-of-day. */
  start: number;
  end: number;
}

export interface AutoScheduleResult {
  placements: Placement[];
  /** Left over once the free gaps ran out — reported, never silently dropped. */
  unplaced: Task[];
}

/**
 * Greedily pack `tasks` (already context-grouped) into `freeGaps`, in order. For each gap, keep
 * taking the next task off the queue as long as it fits in whatever room is left; the moment one
 * doesn't fit, that gap is done — deliberately NOT skipping ahead to a smaller, later task, which
 * would fill the day more tightly but scatter context groups across gaps instead of keeping them
 * together. `defaultMinutes` sizes a task with no estimate (same fallback the calendar's own
 * drop-to-schedule already uses).
 */
export function autoScheduleDay(tasks: Task[], freeGaps: [number, number][], defaultMinutes: number): AutoScheduleResult {
  const queue = groupByContext(tasks);
  const placements: Placement[] = [];
  let qi = 0;

  for (const [gapStart, gapEnd] of freeGaps) {
    let cursor = gapStart;
    while (qi < queue.length) {
      const task = queue[qi];
      const dur = task.estimate && task.estimate > 0 ? task.estimate : defaultMinutes;
      if (cursor + dur > gapEnd) break;
      placements.push({ task, start: cursor, end: cursor + dur });
      cursor += dur;
      qi++;
    }
  }

  return { placements, unplaced: queue.slice(qi) };
}
