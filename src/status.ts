// What a task's status and dates mean for where it shows up. Pure, no Obsidian imports.
//
// Two rules replace a scatter of status comparisons:
//   open   — not done. A someday or on-hold task can still be someone's parent or dependency.
//   active — todo. Only active tasks belong in planning views, counts, and the shared backlog.

import { Task } from "./types";

export function isOpen(t: Pick<Task, "status">): boolean {
  return t.status !== "done";
}

export function isActive(t: Pick<Task, "status">): boolean {
  return t.status === "todo";
}

/**
 * Planned for a day that has passed and still not done.
 *
 * These used to roll into Today under "Anytime" with their old dates — eight of the ten "left" one
 * morning were weeks-old plans — and a timed one landed in today's timeline at its old time. Now
 * they are their own group, to be triaged rather than mistaken for today's plan. A multi-day span
 * still running today is today's work, not carried; a missed *due* date is overdue, which is worse.
 */
export function isCarried(t: Task, todayISO: string): boolean {
  if (!isActive(t) || !t.scheduled || t.scheduled >= todayISO) return false;
  if (t.due && t.due < todayISO) return false;
  if (t.endDate && t.endDate >= todayISO) return false;
  return true;
}

/** Whole days from `fromISO` to `toISO` (positive when `toISO` is later). */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date said the way it matters: "today", "yesterday", "16 days ago", "Fri", "24 Dec".
 * On a list of things that slipped, "16 days ago" says what "2026-09-26" makes you work out; a
 * month ahead, "24 Dec" says more than "in 73 days".
 */
export function relativeDay(iso: string, todayISO: string): string {
  const d = daysBetweenISO(todayISO, iso);
  if (d === 0) return "today";
  if (d === -1) return "yesterday";
  if (d === 1) return "tomorrow";
  if (d < 0) return `${-d} days ago`;
  const date = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  if (d < 7) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  const sameYear = iso.slice(0, 4) === todayISO.slice(0, 4);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${sameYear ? "" : ` ${date.getUTCFullYear()}`}`;
}

/**
 * Done tasks old enough to file away: completed at least `days` days before today. Recurring tasks
 * are never done in the archivable sense — completing one re-arms it — and nothing already filed
 * is returned again.
 */
export function archivable(tasks: Task[], todayISO: string, days: number, doneFolder: string): Task[] {
  if (days <= 0) return [];
  return tasks.filter(
    (t) =>
      t.status === "done" &&
      !t.recurrence &&
      !t.path.startsWith(doneFolder + "/") &&
      // A done task with no completion date is old by definition: it predates the field.
      (!t.completed || daysBetweenISO(t.completed, todayISO) >= days)
  );
}

/** The first day of next week — "Next week" on a carried task means its start, not today + 7. */
export function nextWeekStart(todayISO: string, firstDayOfWeek: number): string {
  const d = new Date(`${todayISO}T00:00:00Z`);
  const ahead = (firstDayOfWeek - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  return d.toISOString().slice(0, 10);
}

/**
 * Someday tasks grouped the way they read best: by their first context, so @shopping becomes a
 * shopping list. Contexts merge case-insensitively ("Bicycles" and "bicycles" are one list), and
 * anything without one comes last.
 */
export function groupSomeday(tasks: Task[]): { context: string | null; tasks: Task[] }[] {
  const groups = new Map<string, { context: string | null; tasks: Task[] }>();
  for (const t of tasks) {
    const c = t.contexts[0] ?? null;
    const key = c ? c.toLowerCase() : "￿";
    if (!groups.has(key)) groups.set(key, { context: c, tasks: [] });
    groups.get(key)!.tasks.push(t);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => ({ ...g, tasks: g.tasks.sort((x, y) => x.title.localeCompare(y.title)) }));
}
