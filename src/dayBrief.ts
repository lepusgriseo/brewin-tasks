// What one day holds, for the day note: the calendar items the Calendar shows on it, the weekly
// review's done / missed / still-open verdicts over a one-day range, and — when the day is today —
// what is overdue and which projects have stalled or have a deadline close.
// Pure: no Obsidian imports, so the day note and the Planner can be tested to agree.

import { classify } from "./buckets";
import { sortItems } from "./calendarItem";
import { deadline, isStalled, ProjectInfo } from "./projects";
import { trackedInRange } from "./timeTrack";
import { CalendarItem, Task } from "./types";
import { weekTaskReview, WeekTaskReview } from "./views";

/** A project as the brief needs it: its fields, and its open checkbox steps. */
export interface DayProject {
  info: ProjectInfo;
  openSteps: readonly { isNext: boolean }[];
}

export interface DayBrief {
  date: string;
  isToday: boolean;
  /** Everything placed on the day except task notes, which are under `tasks`: events (repeats
   *  included), training from the Fitness plan, birthdays and project steps. */
  schedule: CalendarItem[];
  /** The weekly review's verdicts for this one day. */
  tasks: WeekTaskReview;
  /** Today only: open tasks past their deadline. Empty on any other day. */
  overdue: Task[];
  /** Today only: active projects with nothing to do next. */
  stalled: { path: string; name: string }[];
  /** Today only: projects with a deadline within `soonDays`, or already past it. */
  deadlines: { path: string; name: string; due: string; days: number; overdue: boolean }[];
  /** Focus-timer time per task that day, most first. */
  tracked: { path: string; title: string; minutes: number }[];
}

/** How far ahead a project deadline counts as close. */
export const SOON_DAYS = 7;

export function dayBrief(o: {
  date: string;
  today: string;
  items: CalendarItem[];
  tasks: Task[];
  projects: DayProject[];
}): DayBrief {
  const isToday = o.date === o.today;
  const schedule = sortItems(o.items.filter((it) => it.kind !== "task" && it.date === o.date));
  const live = o.projects.filter((p) => p.info.status === "active" || p.info.status === "waiting");

  const deadlines: DayBrief["deadlines"] = [];
  if (isToday) {
    for (const p of live) {
      const d = deadline(p.info, o.today);
      if (d && d.days <= SOON_DAYS) deadlines.push({ path: p.info.path, name: p.info.name, due: d.iso, days: d.days, overdue: d.overdue });
    }
    deadlines.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
  }

  return {
    date: o.date,
    isToday,
    schedule,
    tasks: weekTaskReview(o.tasks, o.date, o.date, o.today),
    overdue: isToday ? classify(o.tasks, o.today).overdue : [],
    stalled: isToday
      ? live
          .filter((p) => isStalled(p.info, p.openSteps))
          .map((p) => ({ path: p.info.path, name: p.info.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [],
    deadlines,
    tracked: trackedInRange(o.tasks, o.date, o.date),
  };
}
