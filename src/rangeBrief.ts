// What a stretch of days held, for the weekly and monthly review notes: the weekly review's
// done / missed / still-open verdicts over the range, and the one-off events and birthdays the
// Calendar placed in it. Repeating events are left out — the same blocks every week say nothing
// about how the week went.
// Pure: no Obsidian imports, so the review notes and the Planner can be tested to agree.

import { sortItems } from "./calendarItem";
import { trackedInRange } from "./timeTrack";
import { CalendarItem, Task } from "./types";
import { weekTaskReview, WeekTaskReview } from "./views";

export interface RangeBrief {
  from: string;
  to: string;
  /** The weekly review's verdicts for the range — the same rules as the review command. */
  tasks: WeekTaskReview;
  /** One-off events in the range, in the Calendar's order. */
  events: CalendarItem[];
  /** Birthdays falling in the range. */
  birthdays: CalendarItem[];
  /** Focus-timer time per task in the range, most first. */
  tracked: { path: string; title: string; minutes: number }[];
  /** Tasks starred as a day's top three on a day in the range, and how many of them are done. */
  top: { starred: number; done: number };
}

/**
 * `focusCategory` is the calendar category focus sessions are filed under: they are time spent on
 * tasks, reported under `tracked`, so they are kept out of `events`.
 */
export function rangeBrief(o: { from: string; to: string; today: string; items: CalendarItem[]; tasks: Task[]; focusCategory?: string | null }): RangeBrief {
  const inRange = o.items.filter((it) => it.date >= o.from && it.date <= o.to);
  const starred = o.tasks.filter((t) => !!t.top && t.top >= o.from && t.top <= o.to);
  return {
    from: o.from,
    to: o.to,
    tasks: weekTaskReview(o.tasks, o.from, o.to, o.today),
    events: sortItems(inRange.filter((it) => it.kind === "event" && !it.recurring && (!o.focusCategory || it.category !== o.focusCategory))),
    birthdays: sortItems(inRange.filter((it) => it.kind === "birthday")),
    tracked: trackedInRange(o.tasks, o.from, o.to),
    top: { starred: starred.length, done: starred.filter((t) => t.status === "done").length },
  };
}
