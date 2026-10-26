// What a stretch of days held, for the weekly and monthly review notes: the weekly review's
// done / missed / still-open verdicts over the range, and the one-off events and birthdays the
// Calendar placed in it. Repeating events are left out — the same blocks every week say nothing
// about how the week went.
// Pure: no Obsidian imports, so the review notes and the Planner can be tested to agree.

import { sortItems } from "./calendarItem";
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
}

export function rangeBrief(o: { from: string; to: string; today: string; items: CalendarItem[]; tasks: Task[] }): RangeBrief {
  const inRange = o.items.filter((it) => it.date >= o.from && it.date <= o.to);
  return {
    from: o.from,
    to: o.to,
    tasks: weekTaskReview(o.tasks, o.from, o.to, o.today),
    events: sortItems(inRange.filter((it) => it.kind === "event" && !it.recurring)),
    birthdays: sortItems(inRange.filter((it) => it.kind === "birthday")),
  };
}
