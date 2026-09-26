// Pure data model — no Obsidian imports, so this stays unit-testable.

export type Status = "todo" | "hold" | "done";
export type Priority = "low" | "normal" | "high";
export type RecurrenceAnchor = "scheduled" | "due";
export type OnCompletion = "keep" | "archive";

/** One fixed time-of-day a task repeats at. See slots.ts. */
export interface TaskSlot {
  time: string; // "HH:MM"
  label: string; // optional, e.g. "Morning"
}

export interface Task {
  /** Vault-relative path of the task note, e.g. "00_Systems/Tasks/Items/Call plumber.md". */
  path: string;
  /** Display title — the note's basename (or an explicit `title` field). */
  title: string;
  status: Status;
  /** ISO "YYYY-MM-DD" do-date, or null. */
  scheduled: string | null;
  /**
   * ISO "YYYY-MM-DD" last day of a multi-day task, or null for a single day.
   * **Inclusive** — 01→05 Aug is five days. (Deliberately unlike an all-day EVENT's
   * `endDate`, which follows the iCal exclusive-end convention.)
   */
  endDate: string | null;
  /** "HH:MM" — when set, the task occupies a block on the calendar instead of the all-day band. */
  startTime: string | null;
  /** "HH:MM" — optional explicit end; defaults to a fixed duration after `startTime`. */
  endTime: string | null;
  /** ISO "YYYY-MM-DD" hard deadline, or null. */
  due: string | null;
  priority: Priority;
  /** Effort estimate in minutes, or null. Used to check a day's work against its free time. */
  estimate: number | null;
  /** Reminder override: "30m" for a custom lead, "none" to stay quiet. */
  remind: string | null;
  /** Override for the at-the-time reminder; null defers to the global setting. */
  remindStart: boolean | null;
  contexts: string[];
  /** iCal RRULE string (optionally with a DTSTART prefix), or null for one-offs. */
  recurrence: string | null;
  recurrenceAnchor: RecurrenceAnchor;
  /** For recurring tasks: ISO dates of completed occurrences. */
  completeInstances: string[];
  /** ISO occurrence dates to skip — a single occurrence detached onto its own note. */
  exdates: string[];
  /**
   * Fixed times this task repeats at WITHIN each day ("08:00 Morning"). Empty for an
   * ordinary task. When set, the day is only finished once the last slot is ticked.
   */
  times: TaskSlot[];
  /** date (ISO) → slot times ticked that day. Only meaningful alongside `times`. */
  completeSlots: Record<string, string[]>;
  onCompletion: OnCompletion;
  created: string | null;
  completed: string | null;
  /** Raw wikilink to the parent task as stored in frontmatter, e.g. `[[Ship v2]]`. */
  parent: string | null;
  /** Parent's resolved vault path (filled in by the store; null when unset/unresolvable). */
  parentPath: string | null;
  /** Raw wikilinks to tasks this one depends on, e.g. `["[[Buy paint]]"]`. Blocks completion
   *  only — no effect on dates or where the task appears. */
  dependsOn: string[];
  /** Resolved vault paths of `dependsOn` (filled in by the store; unresolvable links dropped). */
  dependsOnPaths: string[];
  /**
   * ISO "YYYY-MM" this task is dedicated to, independent of `scheduled`/`due` — a task can
   * belong to a month with no particular day yet ("4 hours of strength training this month"),
   * shown in the calendar's Month-view side panel rather than any one day cell. Null for an
   * ordinary task.
   */
  month: string | null;
  /**
   * ISO week label ("2026-W37") this task is dedicated to — the loose "do this sometime
   * this week" bucket shown in the Week-view side panel. Cleared automatically once the
   * task is dragged onto a real day or time slot. Null for an ordinary task.
   */
  week: string | null;
}

export interface EventItem {
  path: string;
  title: string;
  date: string; // ISO start day
  endDate: string | null; // ISO end day (multi-day / all-day exclusive-end)
  allDay: boolean;
  startTime: string | null; // "HH:MM"
  endTime: string | null;
  /** Display/filter category — "Archived" once the event has been archived. */
  category: string; // Personal | Professional | Social | General | Archived
  /**
   * The category the event actually belongs to, kept through archiving so historical
   * time totals stay attributed to real work rather than all landing in "Archived".
   */
  originalCategory: string;
  archived: boolean;
  completed: boolean;
  recurrence: string | null; // iCal RRULE, or null for one-off
  exdates: string[]; // ISO occurrence dates to skip (recurrence exceptions)
  /** Reminder override: "30m" for a custom lead, "none" to stay quiet. */
  remind: string | null;
  /** Override for the at-the-time reminder; null defers to the global setting. */
  remindStart: boolean | null;
  /** Raw wikilink to a linked trip note, e.g. `[[2026-08-31 - 09-24 London]]`, or null. */
  trip: string | null;
  /** Trip's resolved vault path (filled in by the store; null when unset/unresolvable). */
  tripPath: string | null;
  /** Free-text "where" — an address, venue name, or room, or null. Not a wikilink/note. */
  location: string | null;
}

export type CalendarKind = "task" | "event" | "project";

/** A normalised item placed on the unified calendar. */
export interface CalendarItem {
  kind: CalendarKind;
  path: string;
  title: string;
  date: string; // ISO day it renders on
  allDay: boolean;
  start: string | null; // "HH:MM" (timed events)
  end: string | null;
  done: boolean;
  category: string;
  /** True when this item comes from a recurring series (not freely draggable). */
  recurring: boolean;
  /** For project tasks: the 0-based line in the project note (to navigate to). */
  line?: number;
  /** For a multi-slot task: which of its daily times this block represents ("13:00"). */
  slotTime?: string;
  /** Task-kind items only — lets a caller group/sort by priority without a second lookup. */
  priority?: Priority;
  /** Event-kind items only — the free-text location, when the event has one. */
  location?: string | null;
}

export type Bucket =
  | "overdue"
  | "today"
  | "upcoming"
  | "unplanned"
  | "onhold";

export interface Buckets {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  unplanned: Task[];
  onhold: Task[];
}
