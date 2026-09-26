// Pure bucket classifier. Given tasks (with their *effective* scheduled/due already
// resolved) and today's ISO date, split them into the dashboard's five buckets.
// No Obsidian imports — fully unit-testable with a fixed "today".

import { Buckets, Priority, Task } from "./types";

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

function byScheduledThenPriority(a: Task, b: Task): number {
  const sa = a.scheduled ?? "9999-99-99";
  const sb = b.scheduled ?? "9999-99-99";
  if (sa !== sb) return sa < sb ? -1 : 1;
  const pa = PRIORITY_RANK[a.priority];
  const pb = PRIORITY_RANK[b.priority];
  if (pa !== pb) return pa - pb;
  return a.title.localeCompare(b.title);
}

function byDueThenPriority(a: Task, b: Task): number {
  const da = a.due ?? "9999-99-99";
  const db = b.due ?? "9999-99-99";
  if (da !== db) return da < db ? -1 : 1;
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.title.localeCompare(b.title);
}

/**
 * Classify tasks into buckets relative to `todayISO`.
 *  - On hold: status === "hold"
 *  - Done:    status === "done" → excluded
 *  - Overdue: todo AND due < today (hard-deadline breach takes precedence)
 *  - Today:   todo AND scheduled <= today
 *  - Upcoming: todo AND scheduled > today
 *  - Unplanned: todo AND no scheduled date
 */
export function classify(tasks: Task[], todayISO: string): Buckets {
  const b: Buckets = { overdue: [], today: [], upcoming: [], unplanned: [], onhold: [] };

  for (const t of tasks) {
    if (t.status === "hold") {
      b.onhold.push(t);
      continue;
    }
    if (t.status === "done") continue;

    if (t.due && t.due < todayISO) {
      b.overdue.push(t);
    } else if (t.scheduled && t.scheduled <= todayISO) {
      // (a span that started earlier still counts as today's work — same branch)
      b.today.push(t);
    } else if (t.scheduled && t.scheduled > todayISO) {
      b.upcoming.push(t);
    } else {
      b.unplanned.push(t);
    }
  }

  b.overdue.sort(byDueThenPriority);
  b.today.sort(byScheduledThenPriority);
  b.upcoming.sort(byScheduledThenPriority);
  b.unplanned.sort((a, z) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[z.priority] || a.title.localeCompare(z.title));
  b.onhold.sort((a, z) => a.title.localeCompare(z.title));

  return b;
}

/**
 * Group open tasks by context, excluding `activeContext` (the one already filtered on —
 * every task shares it, so grouping by it says nothing). A task carrying several other
 * contexts appears under each.
 *
 * Tasks with no other context go in the `null` group. When a context is being filtered on
 * that group is the "purely @active" set and comes **first**; with no filter it's the
 * leftover "no context" bucket and comes last.
 */
export function groupByContext(
  tasks: Task[],
  activeContext: string | null
): { context: string | null; tasks: Task[] }[] {
  const groups = new Map<string | null, Task[]>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    const others = t.contexts.filter((c) => c !== activeContext);
    const keys: (string | null)[] = others.length ? others : [null];
    for (const k of keys) {
      const list = groups.get(k) ?? [];
      list.push(t);
      groups.set(k, list);
    }
  }
  for (const list of groups.values()) {
    list.sort(
      (a, b) => (a.scheduled ?? "9999").localeCompare(b.scheduled ?? "9999") || a.title.localeCompare(b.title)
    );
  }
  // The `null` group leads when it means "only the filtered context", trails otherwise.
  const nullRank = activeContext ? -1 : 1;
  return [...groups.entries()]
    .sort((a, z) => (a[0] === null ? nullRank : z[0] === null ? -nullRank : a[0].localeCompare(z[0])))
    .map(([context, ts]) => ({ context, tasks: ts }));
}

/** Group upcoming tasks by their scheduled date, in ascending date order. */
export function groupByDate(tasks: Task[]): { date: string; tasks: Task[] }[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.scheduled ?? "unscheduled";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.entries()]
    .sort((a, z) => (a[0] < z[0] ? -1 : 1))
    .map(([date, ts]) => ({ date, tasks: ts }));
}
