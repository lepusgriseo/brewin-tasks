// A day's plan, worked out once for Plan my day, Shut down and the calendar's "To plan" panel: what is
// left over from days gone, what the day already holds and whether it fits, what could join it, and
// the day's top three. Pure, no Obsidian imports.

import { CalendarItem, Task } from "./types";
import { eventMinutesOn, todayAgenda, weekTaskReview } from "./views";
import { workload, Workload } from "./estimate";
import { shiftISO } from "./dates";

/** How many tasks can be the day's top. */
export const TOP_LIMIT = 3;

/** Starred as one of `day`'s top three (`top: <day>` on the note). */
export function isTop(t: Pick<Task, "top">, day: string): boolean {
  return t.top === day;
}

export interface DayPlan {
  day: string;
  /** Planned for a day that has passed, or past their deadline: answered before the day starts. */
  leftovers: Task[];
  /** What the day already holds, open: timed tasks in clock order, then the rest. */
  planned: Task[];
  /** Starred for the day, open or done, in title order. */
  top: Task[];
  /** Could join the day: active tasks with no date at all. */
  inbox: Task[];
  /** Could join the day: active tasks planned for the next seven days. */
  soon: Task[];
  /** Events, training and busy calendars' events that take up time on the day, in clock order. */
  busy: CalendarItem[];
  /** The day's planned work against the time left by its events. */
  load: Workload;
}

const unique = (list: Task[]) => [...new Map(list.map((t) => [t.path, t])).values()];
const active = (t: Task) => t.status === "todo";

/**
 * The plan for `day` (normally today). `items` are the day's calendar items — events and training;
 * `trackedMinutes` is how much of a day counts (Settings → trackable hours).
 */
export function dayPlan(o: { tasks: Task[]; items: CalendarItem[]; day: string; trackedMinutes: number }): DayPlan {
  const { tasks, items, day } = o;
  const agenda = todayAgenda(tasks, items, day);
  const timed = agenda.timed.flatMap((r) => (r.task && !r.done && (r.kind === "task" || r.kind === "slot") ? [r.task] : []));
  const planned = unique([...timed, ...agenda.anytime]);
  const plannedPaths = new Set(planned.map((t) => t.path));
  const leftovers = unique([...agenda.overdue, ...agenda.carried]).filter((t) => !plannedPaths.has(t.path));
  const top = tasks.filter((t) => isTop(t, day)).sort((a, b) => a.title.localeCompare(b.title));
  const last = shiftISO(day, 7) ?? day;
  const inbox = tasks.filter((t) => active(t) && !t.scheduled && !t.due && !t.recurrence && !t.week && !t.month);
  const soon = tasks
    .filter((t) => active(t) && !t.recurrence && !!t.scheduled && t.scheduled > day && t.scheduled <= last)
    .sort((a, b) => (a.scheduled ?? "").localeCompare(b.scheduled ?? "") || a.title.localeCompare(b.title));
  const busy = items
    .filter((it) => it.date === day && !it.allDay && !!it.start && (it.kind === "event" || it.kind === "training" || it.kind === "external"))
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const load = workload(planned.map((t) => t.estimate), o.trackedMinutes - eventMinutesOn(items, day));
  return { day, leftovers, planned, top, inbox, soon, busy, load };
}

export interface DayClose {
  /** Ticked today: one-offs, then repeating tasks (each once). */
  done: Task[];
  /** Planned for the day and still open. */
  open: Task[];
  /** The day's top three: how many were done, and which are still open. */
  top: { done: number; total: number; open: Task[] };
}

/** How the day went, for Shut down: what was done, what is left, and the top three's outcome. */
export function dayClose(tasks: Task[], day: string, today: string): DayClose {
  const review = weekTaskReview(tasks, day, day, today);
  const done = unique([...review.doneOneOff, ...review.doneRecurring.map((r) => r.task)]);
  const donePaths = new Set(done.map((t) => t.path));
  const open = unique([...review.stillOpen, ...review.missedOneOff]).filter((t) => !donePaths.has(t.path) && t.status !== "done");
  const top = tasks.filter((t) => isTop(t, day));
  const topOpen = top.filter((t) => !donePaths.has(t.path) && t.status !== "done");
  return { done, open, top: { done: top.length - topOpen.length, total: top.length, open: topOpen } };
}

/** The top for `day` after starring or unstarring one — refusing a fourth. Null when refused. */
export function toggleTop(tasks: Task[], task: Task, day: string): string | null | undefined {
  if (isTop(task, day)) return null; // unstar
  const starred = tasks.filter((t) => isTop(t, day) && t.status !== "done" && t.path !== task.path).length;
  return starred >= TOP_LIMIT ? undefined : day;
}
