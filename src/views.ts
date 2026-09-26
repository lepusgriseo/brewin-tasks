// Pure selection + shaping for the dashboard's views. No Obsidian imports → testable.
//
// The dashboard used to be one long scroll of every bucket. These functions each answer a
// different question — "what am I doing today", "what's coming", "what still needs a date",
// "what's slipping" — so the view layer only has to render, never decide.

import { addMinutesHM, formatISO, isoWeekOf, isoWeeksOfMonth, minutesOfDay, parseISO, shortDate } from "./dates";
import { groupItemsByDay } from "./calendarItem";
import { effectiveStart, occurrencesInRange, parseRRule } from "./rrule";
import { doneTimesOn, slotProgress, TaskSlot } from "./slots";
import { isRecurring, taskCoversDay, taskDayIndex, taskLastDay, taskSpanDays } from "./task";
import { CalendarItem, CalendarKind, Task } from "./types";

export type DashView = "today" | "week" | "inbox" | "projects" | "attention" | "review" | "all";

export const DASH_VIEWS: { id: DashView; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "📅" },
  { id: "week", label: "Week", icon: "🗓" },
  { id: "inbox", label: "Inbox", icon: "📥" },
  { id: "projects", label: "Projects", icon: "⚡" },
  { id: "attention", label: "Attention", icon: "🔴" },
  { id: "review", label: "Review", icon: "📋" },
  { id: "all", label: "All", icon: "☰" },
];

/** One line in the Today timeline. Events are context only — they can't be ticked here. */
export interface AgendaRow {
  time: string; // "HH:MM"
  endTime: string | null;
  kind: "task" | "slot" | "event";
  title: string;
  done: boolean;
  path: string;
  /** For a slot row: which of the task's daily times this is. */
  slotTime?: string;
  /** Present for task/slot rows so the renderer can tick them. */
  task?: Task;
  /** Event rows only — the free-text location, when the event has one. */
  location?: string | null;
}

/** "3/5" when a task spans days, else "" — shown next to the title. */
export function spanLabel(task: Task, dateISO: string): string {
  const span = taskSpanDays(task);
  if (span <= 1) return "";
  return `${taskDayIndex(task, dateISO)}/${span}`;
}

export interface TodayAgenda {
  /** Past-due tasks, pinned above today's work. */
  overdue: Task[];
  /** Anything with a clock time, in clock order — tasks, task slots and events. */
  timed: AgendaRow[];
  /** Scheduled for today (or rolled over) but with no particular time. */
  anytime: Task[];
  /** All-day events today, shown as a thin context strip. */
  allDayEvents: { title: string; path: string; location: string | null }[];
  doneCount: number;
  openCount: number;
}

function isOpen(t: Task): boolean {
  return t.status !== "done" && t.status !== "hold";
}

/** A task's slots, tolerating notes written before multi-slot tasks existed. */
function slotsOf(t: Task): TaskSlot[] {
  return t.times ?? [];
}

/**
 * Everything today, shaped for a single screen.
 *
 * `events` are already-expanded calendar items for today (so recurrence and multi-day
 * splitting have been handled upstream); they're woven in purely as context.
 */
export function todayAgenda(
  tasks: Task[],
  events: CalendarItem[],
  todayISO: string
): TodayAgenda {
  const overdue: Task[] = [];
  const timed: AgendaRow[] = [];
  const anytime: Task[] = [];
  let doneCount = 0;

  for (const t of tasks) {
    if (t.status === "done") {
      if (t.completed === todayISO) doneCount++;
      continue;
    }
    if (t.status === "hold") continue;

    // Overdue is judged on the DUE date and pinned separately — a task can be both overdue
    // and scheduled today, and it should appear once, at the top, where it can't be missed.
    if (t.due && t.due < todayISO) {
      overdue.push(t);
      continue;
    }

    // `scheduled <= today` already covers both cases correctly: a span that started
    // earlier is still today's work, and one starting tomorrow isn't. A task whose day has
    // simply passed must keep showing up rather than vanishing, so this is NOT a
    // `taskCoversDay` check — that would silently drop rolled-over work.
    if (!t.scheduled || t.scheduled > todayISO) continue;

    const slots = slotsOf(t);
    if (slots.length) {
      const day = t.scheduled!;
      const done = doneTimesOn(t.completeSlots ?? {}, day);
      doneCount += done.length;
      for (const s of slots) {
        timed.push({
          time: s.time,
          endTime: null,
          kind: "slot",
          title: s.label ? `${t.title} — ${s.label}` : t.title,
          done: done.includes(s.time),
          path: t.path,
          slotTime: s.time,
          task: t,
        });
      }
      continue;
    }

    if (t.startTime) {
      timed.push({
        time: t.startTime,
        endTime: t.endTime,
        kind: "task",
        title: t.title,
        done: false,
        path: t.path,
        task: t,
      });
    } else {
      anytime.push(t);
    }
  }

  const allDayEvents: { title: string; path: string; location: string | null }[] = [];
  for (const ev of events) {
    if (ev.date !== todayISO) continue;
    if (ev.allDay || !ev.start) {
      allDayEvents.push({ title: ev.title, path: ev.path, location: ev.location ?? null });
      continue;
    }
    timed.push({
      time: ev.start,
      endTime: ev.end,
      kind: "event",
      title: ev.title,
      done: ev.done,
      path: ev.path,
      location: ev.location,
    });
  }

  timed.sort(
    (a, b) =>
      (minutesOfDay(a.time) ?? 0) - (minutesOfDay(b.time) ?? 0) ||
      a.title.localeCompare(b.title)
  );
  overdue.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "") || a.title.localeCompare(b.title));
  anytime.sort(byPriorityThenTitle);

  const openCount =
    overdue.length + anytime.length + timed.filter((r) => r.kind !== "event" && !r.done).length;

  return { overdue, timed, anytime, allDayEvents, doneCount, openCount };
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
function byPriorityThenTitle(a: Task, b: Task): number {
  return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || a.title.localeCompare(b.title);
}

export interface DayGroup {
  date: string;
  tasks: Task[];
}

/**
 * The next `days` days including today, one group per day — **empty days included**, so a
 * clear Thursday is visible as breathing room rather than silently absent.
 */
export function weekAgenda(tasks: Task[], fromISO: string, days = 7): DayGroup[] {
  const dates: string[] = [];
  const start = Date.parse(fromISO + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    dates.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
  }
  const last = dates[dates.length - 1];

  const groups = new Map<string, Task[]>(dates.map((d) => [d, []]));
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const day = t.scheduled ?? t.due;
    if (!day) continue;

    // A multi-day task occupies every day of its span that falls in the window.
    if (t.scheduled && taskSpanDays(t) > 1) {
      let placed = false;
      for (const d of dates) {
        if (taskCoversDay(t, d)) {
          groups.get(d)?.push(t);
          placed = true;
        }
      }
      // A span that both starts and ends before the window still needs surfacing.
      if (!placed && day < fromISO) groups.get(fromISO)?.push(t);
      continue;
    }

    // Anything already overdue or scheduled before the window lands on the first day.
    const key = day < fromISO ? fromISO : day;
    if (key > last) continue;
    groups.get(key)?.push(t);
  }
  for (const list of groups.values()) list.sort(byPriorityThenTitle);
  return dates.map((date) => ({ date, tasks: groups.get(date) ?? [] }));
}

/** Tasks with no date at all — the triage list after transferring from paper. */
export function inboxTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => isOpen(t) && !t.scheduled && !t.due).sort(byPriorityThenTitle);
}

/**
 * Open tasks with no do-date yet — candidates to slot into a day being reviewed. Broader than
 * `inboxTasks`: a task with a due date but no `scheduled` still needs a day picked for it, so
 * it belongs here even though it isn't "undated" in `inboxTasks`' stricter sense.
 */
export function unscheduledTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => isOpen(t) && !t.scheduled).sort(byPriorityThenTitle);
}

/** One section of the Month-view task panel — a specific ISO week, or the month-wide catch-all. */
export interface MonthPanelSection {
  /** Bucket key: an ISO week label ("2026-W37") or, for the catch-all, the month ("2026-09").
   *  Doubles as the per-section collapse key. */
  key: string;
  kind: "week" | "month";
  /** "Week 37" | "Anytime this month". */
  label: string;
  /** ISO dates of the week's Monday/Sunday for the muted date-range suffix; null for the catch-all. */
  start: string | null;
  end: string | null;
  /** Tasks filed to this bucket, done sorted last then by title. */
  tasks: Task[];
  /** Expand this section on first render (before the user has toggled it). */
  defaultOpen: boolean;
  /** The ISO week containing "today" — accented in the panel. */
  isCurrent: boolean;
  /** Passed to `bucketDragItem` for a task with no scheduled date. */
  fallbackDate: string;
}

/**
 * The Month-view panel as a list of week sections plus a trailing "Anytime this month"
 * catch-all. Pure — the view maps each section to its add-box / drag wiring.
 */
export function monthPanelSections(monthISO: string, tasks: Task[], todayISO: string): MonthPanelSection[] {
  const doneLast = (a: Task, b: Task) =>
    Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title);
  const currentWeek = isoWeekOf(todayISO);

  const sections: MonthPanelSection[] = isoWeeksOfMonth(monthISO).map((w) => {
    const wtasks = tasks.filter((t) => t.week === w.week).sort(doneLast);
    const isCurrent = w.week === currentWeek;
    return {
      key: w.week,
      kind: "week",
      label: "Week " + Number(w.week.slice(6)),
      start: w.start,
      end: w.end,
      tasks: wtasks,
      defaultOpen: isCurrent || wtasks.length > 0,
      isCurrent,
      fallbackDate: w.start,
    };
  });

  // `&& !t.week` keeps a legacy task that carries BOTH fields out of the catch-all — it shows
  // under its week only (the current UI never sets both; drops clear the other key).
  const anytime = tasks.filter((t) => t.month === monthISO && !t.week).sort(doneLast);
  sections.push({
    key: monthISO,
    kind: "month",
    label: "Anytime this month",
    start: null,
    end: null,
    tasks: anytime,
    defaultOpen: true,
    isCurrent: false,
    fallbackDate: todayISO.slice(0, 7) === monthISO ? todayISO : monthISO + "-01",
  });
  return sections;
}

export interface AttentionGroups {
  /** Due date already passed. */
  overdue: Task[];
  /** Scheduled for a day that's been and gone, and still not done. */
  slipped: Task[];
  /** Parked, and worth a periodic second look. */
  onhold: Task[];
}

/**
 * The weekly-review screen. `slipped` is deliberately separate from `overdue`: a missed
 * *scheduled* day is a plan that didn't survive contact, whereas a missed *due* date is a
 * promise broken — they deserve different reactions.
 */
export function attentionTasks(tasks: Task[], todayISO: string): AttentionGroups {
  const overdue: Task[] = [];
  const slipped: Task[] = [];
  const onhold: Task[] = [];

  for (const t of tasks) {
    if (t.status === "done") continue;
    if (t.status === "hold") {
      onhold.push(t);
      continue;
    }
    if (t.due && t.due < todayISO) overdue.push(t);
    else if (t.scheduled && t.scheduled < todayISO) slipped.push(t);
  }

  overdue.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
  slipped.sort((a, b) => (a.scheduled ?? "").localeCompare(b.scheduled ?? ""));
  onhold.sort((a, b) => a.title.localeCompare(b.title));
  return { overdue, slipped, onhold };
}

// ── Weekly-review snapshot ───────────────────────────────────────────────────
//
// A frozen, range-bounded account of one ISO week for the weekly-review note: what got done,
// what was missed, what's still live. Unlike `reviewWeek` (a day-by-day to-do transcription
// that drops anything finished) this keeps the done work — the review is about what happened.

/** A recurring task and the occurrence dates (ascending) that fell into one bucket this week. */
export interface RecurringHits {
  task: Task;
  dates: string[];
}

export interface WeekTaskReview {
  /** One-off tasks marked done with a `completed` date inside the week. */
  doneOneOff: Task[];
  /** Recurring tasks with ≥1 occurrence ticked this week. */
  doneRecurring: RecurringHits[];
  /** One-off tasks due/scheduled on a past day this week, still not done. */
  missedOneOff: Task[];
  /** Recurring tasks with ≥1 past occurrence this week left unticked (exdates excluded). */
  missedRecurring: RecurringHits[];
  /** Tasks (one-off or recurring) with work still due today or later this week. */
  stillOpen: Task[];
  /** Occurrence-level totals — recurring rows count once per date, so these exceed the row counts. */
  counts: { done: number; missed: number; open: number };
}

/**
 * Bucket one ISO week's tasks into done / missed / still-open. `todayISO` is the fence between
 * "missed" (a past day that didn't happen) and "still open" (today or later — no verdict yet).
 */
export function weekTaskReview(
  tasks: Task[],
  fromISO: string,
  toISO: string,
  todayISO: string
): WeekTaskReview {
  const doneOneOff: Task[] = [];
  const missedOneOff: Task[] = [];
  const stillOpen: Task[] = [];
  const doneRecurring: RecurringHits[] = [];
  const missedRecurring: RecurringHits[] = [];

  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  const oneOffDay = (t: Task) => taskLastDay(t) ?? t.scheduled ?? t.due;

  for (const t of tasks) {
    if (isRecurring(t) && from && to) {
      const rule = parseRRule(t.recurrence);
      if (!rule) continue;
      // A recurring task's scheduled/due rolls forward every time an occurrence is completed,
      // so its live anchor can sit *after* the week under review — seeding `occurrencesInRange`
      // from it would skip the occurrences actually completed earlier in the week. Seed from
      // the earliest date we have any record of instead (a real lattice point, so INTERVAL
      // phase stays correct). A DTSTART inside the rule still wins in `effectiveStart`.
      const known = [
        t.recurrenceAnchor === "due" ? t.due : t.scheduled,
        ...t.completeInstances,
        ...Object.keys(t.completeSlots ?? {}),
      ]
        .filter((d): d is string => !!d)
        .sort();
      const start = effectiveStart(rule, parseISO(known[0] ?? fromISO), from);
      const slots = t.times ?? [];

      const doneDates: string[] = [];
      const missedDates: string[] = [];
      let hasOpen = false;
      for (const occ of occurrencesInRange(rule, start, from, to)) {
        const d = formatISO(occ);
        if (t.exdates?.includes(d)) continue; // detached onto its own note
        const done = slots.length
          ? slotProgress(slots, t.completeSlots ?? {}, d).dayComplete
          : t.completeInstances.includes(d);
        if (done) doneDates.push(d);
        else if (d < todayISO) missedDates.push(d);
        else hasOpen = true;
      }
      if (doneDates.length) doneRecurring.push({ task: t, dates: doneDates });
      if (missedDates.length) missedRecurring.push({ task: t, dates: missedDates });
      if (hasOpen) stillOpen.push(t);
      continue;
    }

    if (t.status === "done") {
      if (t.completed && t.completed >= fromISO && t.completed <= toISO) doneOneOff.push(t);
      continue;
    }
    if (t.status === "hold") continue;

    const day = oneOffDay(t);
    if (!day || day < fromISO || day > toISO) continue;
    if (day < todayISO) missedOneOff.push(t);
    else stillOpen.push(t);
  }

  doneOneOff.sort(
    (a, b) => (a.completed ?? "").localeCompare(b.completed ?? "") || a.title.localeCompare(b.title)
  );
  missedOneOff.sort(
    (a, b) => (oneOffDay(a) ?? "").localeCompare(oneOffDay(b) ?? "") || a.title.localeCompare(b.title)
  );
  stillOpen.sort(byPriorityThenTitle);
  doneRecurring.sort((a, b) => a.task.title.localeCompare(b.task.title));
  missedRecurring.sort((a, b) => a.task.title.localeCompare(b.task.title));

  const sum = (rows: RecurringHits[]) => rows.reduce((n, r) => n + r.dates.length, 0);
  return {
    doneOneOff,
    doneRecurring,
    missedOneOff,
    missedRecurring,
    stillOpen,
    counts: {
      done: doneOneOff.length + sum(doneRecurring),
      missed: missedOneOff.length + sum(missedRecurring),
      open: stillOpen.length,
    },
  };
}

/**
 * The markdown that goes under `### Tasks this week` in the review note — grouped bullet
 * lists, recurring tasks collapsed to `Title ×N`, plain text (no wikilinks: it's meant to be
 * copied onto paper). Returns the body only; the heading is owned by `fillSection`.
 */
export function formatWeekTaskBlock(
  r: WeekTaskReview,
  m: { weekLabel: string; startISO: string; endISO: string; generatedISO: string }
): string {
  const lines: string[] = [
    `*${m.weekLabel} · ${shortDate(m.startISO)} – ${shortDate(m.endISO)} · generated ${m.generatedISO}*`,
  ];

  if (!r.counts.done && !r.counts.missed && !r.counts.open) {
    lines.push("", "_Nothing tracked for this week._");
    return lines.join("\n");
  }

  const dated = (t: Task): string => {
    const day = taskLastDay(t) ?? t.scheduled ?? t.due;
    if (!day) return t.title;
    const verb = t.due && !t.scheduled ? "due" : "scheduled";
    return `${t.title} — ${verb} ${shortDate(day)}`;
  };
  const section = (label: string, count: number, items: string[]) => {
    if (!items.length) return;
    lines.push("", `**${label} — ${count}**`, ...items.map((it) => `- ${it}`));
  };

  section("Done", r.counts.done, [
    ...r.doneOneOff.map((t) => t.title),
    ...r.doneRecurring.map((h) => `${h.task.title} ×${h.dates.length}`),
  ]);
  section("Missed", r.counts.missed, [
    ...r.missedOneOff.map(dated),
    ...r.missedRecurring.map((h) => `${h.task.title} ×${h.dates.length}`),
  ]);
  section("Still open", r.counts.open, [
    ...r.stillOpen.map((t) => (isRecurring(t) ? `${t.title} (recurring)` : dated(t))),
  ]);

  return lines.join("\n");
}

export interface ProjectGroup<T> {
  project: string;
  path: string;
  tasks: T[];
}

/** The fields grouping needs; generic so the caller keeps its full task objects. */
export interface ProjectTaskish {
  projectPath: string;
  projectName: string;
  line: number;
  scheduled: string | null;
  due: string | null;
}

/**
 * Project checkbox tasks grouped under their project note, biggest backlog first.
 * Generic so callers pass — and get back — their own richer objects intact, rather than a
 * reduced copy that would have to be cast back and could silently lose fields.
 */
export function groupByProject<T extends ProjectTaskish>(items: T[]): ProjectGroup<T>[] {
  const map = new Map<string, ProjectGroup<T>>();
  for (const it of items) {
    let g = map.get(it.projectPath);
    if (!g) {
      g = { project: it.projectName, path: it.projectPath, tasks: [] };
      map.set(it.projectPath, g);
    }
    g.tasks.push(it);
  }
  for (const g of map.values()) {
    g.tasks.sort((a, b) => (a.scheduled ?? a.due ?? "9999").localeCompare(b.scheduled ?? b.due ?? "9999") || a.line - b.line);
  }
  return [...map.values()].sort((a, b) => b.tasks.length - a.tasks.length || a.project.localeCompare(b.project));
}

/** Count of open slots left today, for the Today header. */
export function openSlotsToday(task: Task, todayISO: string): number {
  const slots = slotsOf(task);
  if (!slots.length) return 0;
  const p = slotProgress(slots, task.completeSlots ?? {}, todayISO);
  return p.total - p.done;
}

// ── Repeat-end helpers (shared by the task window) ───────────────────────────

export interface RepeatEnd {
  kind: "never" | "on" | "after";
  until: string | null;
  count: number | null;
}

/** Read how an RRULE ends, so the task window can show the right radio pre-selected. */
export function readRepeatEnd(rrule: string | null): RepeatEnd {
  if (!rrule) return { kind: "never", until: null, count: null };
  const until = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})/i.exec(rrule);
  if (until) return { kind: "on", until: `${until[1]}-${until[2]}-${until[3]}`, count: null };
  const count = /(?:^|;)COUNT=(\d+)/i.exec(rrule);
  if (count) return { kind: "after", until: null, count: Number(count[1]) };
  return { kind: "never", until: null, count: null };
}

/** Inclusive day count between two ISO dates (1 when there's no real span). */
export function spanOf(startISO: string | null, endISO: string | null): number {
  if (!startISO || !endISO || endISO <= startISO) return startISO ? 1 : 0;
  return Math.round((Date.parse(endISO + "T00:00:00Z") - Date.parse(startISO + "T00:00:00Z")) / 86400000) + 1;
}

/**
 * Minutes of `dateISO` already occupied by timed events — the union, so two overlapping
 * meetings take an hour of the day between them rather than two.
 */
export function eventMinutesOn(events: CalendarItem[], dateISO: string): number {
  const ranges: [number, number][] = [];
  for (const ev of events) {
    if (ev.date !== dateISO || ev.allDay || !ev.start || !ev.end) continue;
    const s = minutesOfDay(ev.start);
    const e = minutesOfDay(ev.end);
    if (s == null || e == null || e <= s) continue;
    ranges.push([s, e]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const r of ranges) {
    if (cur && r[0] <= cur[1]) cur[1] = Math.max(cur[1], r[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [r[0], r[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

// ── Weekly review ────────────────────────────────────────────────────────────
//
// One page to transcribe a whole week into a paper journal. The dashboard's Week view is
// tasks-only, so the fixed shape of the week — gym, work, the evening blocks — was missing
// entirely. This merges everything and orders it the way you'd write it down.

export interface ReviewRow {
  kind: CalendarKind;
  /** "HH:MM", or null for an all-day event / undated task. */
  time: string | null;
  endTime: string | null;
  title: string;
  path: string;
  slotTime?: string;
  /** Project checkbox line, for opening the note at the right place. */
  line?: number;
  done: boolean;
  /** Stable across renders — this is what the transfer tick is keyed on. */
  key: string;
}

export interface ReviewDay {
  date: string;
  /** All-day events: the day's context, written at the top of the page. */
  allDay: ReviewRow[];
  /** Anything with a clock time, in clock order. */
  timed: ReviewRow[];
  /** Dated but untimed work — the "and also today" list. */
  untimed: ReviewRow[];
}

function toReviewRow(it: CalendarItem): ReviewRow {
  return {
    kind: it.kind,
    time: it.allDay ? null : it.start,
    endTime: it.allDay ? null : it.end,
    title: it.title,
    path: it.path,
    slotTime: it.slotTime,
    line: it.line,
    done: it.done,
    // Path alone isn't unique: a multi-slot task contributes three rows on one day, and a
    // recurring event one per day. Date + slot/time disambiguates without being positional,
    // so a tick survives a re-render and can't drift onto a different row.
    key: `${it.path}|${it.date}|${it.slotTime ?? it.start ?? "all-day"}`,
  };
}

/**
 * Every day in `[fromISO, toISO]`, each split into all-day / timed / untimed.
 *
 * **Anything already done is dropped.** The page exists to be copied into a paper journal, so
 * it lists what's still to happen; a finished task is noise you'd have to skip past on every
 * line. This is applied here rather than by each caller because the three sources disagreed —
 * `expandRecurringTasks` filtered by status but `tasksToItems` never has, so completed
 * one-off tasks leaked through while completed recurring ones didn't.
 *
 * Empty days are kept — a clear Thursday is information when you're planning a week, not an
 * absence to hide. `items` should already be the expanded `CalendarItem[]` from
 * `eventsToItems` + `tasksToItems` + `projectTasksToItems`, so recurrence, multi-day spans
 * and multi-slot times are handled upstream.
 */
export function reviewWeek(
  items: CalendarItem[],
  fromISO: string,
  toISO: string,
  opts: { includeDone?: boolean } = {}
): ReviewDay[] {
  const dates: string[] = [];
  const start = Date.parse(fromISO + "T00:00:00Z");
  const end = Date.parse(toISO + "T00:00:00Z");
  for (let t = start; t <= end; t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }

  const byDay = groupItemsByDay(opts.includeDone ? items : items.filter((i) => !i.done));
  return dates.map((date) => {
    const rows = (byDay.get(date) ?? []).map(toReviewRow);
    return {
      date,
      // An all-day EVENT frames the day (Office Day, Parents Away); an untimed TASK is work
      // to fit in. `sortItems` lumps both under "all-day", so they're separated here.
      allDay: rows.filter((r) => r.time === null && r.kind === "event"),
      timed: rows
        .filter((r) => r.time !== null)
        .sort((a, b) => (minutesOfDay(a.time) ?? 0) - (minutesOfDay(b.time) ?? 0) || a.title.localeCompare(b.title)),
      untimed: rows.filter((r) => r.time === null && r.kind !== "event"),
    };
  });
}

/** Total rows in a week — the denominator for "12 of 34 transferred". */
export function reviewRowCount(days: ReviewDay[]): number {
  return days.reduce((n, d) => n + d.allDay.length + d.timed.length + d.untimed.length, 0);
}

export interface TasksByPriority {
  high: CalendarItem[];
  normal: CalendarItem[];
  low: CalendarItem[];
}

/**
 * A single day's open tasks, grouped by priority — "what are my three things today" at a
 * glance, separate from the chronological transcription list `reviewWeek` builds. `items`
 * should already be the day's expanded CalendarItem[] (tasksToItems + expandRecurringTasks),
 * same source the chronological list uses, so a recurring task shows up here too.
 */
export function tasksByPriority(items: CalendarItem[], dateISO: string): TasksByPriority {
  const out: TasksByPriority = { high: [], normal: [], low: [] };
  for (const it of items) {
    if (it.kind !== "task" || it.date !== dateISO || it.done) continue;
    out[it.priority ?? "normal"].push(it);
  }
  // Untimed first, then by clock — same convention as `sortItems` in calendarItem.ts.
  const byTime = (a: CalendarItem, b: CalendarItem) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (minutesOfDay(a.start) ?? 0) - (minutesOfDay(b.start) ?? 0) || a.title.localeCompare(b.title);
  };
  out.high.sort(byTime);
  out.normal.sort(byTime);
  out.low.sort(byTime);
  return out;
}

/**
 * Which week the review page should open on: **next** week when today is the last day of the
 * week (the review happens then, for the week ahead), otherwise the current week.
 *
 * Returns any date inside the target week; the caller passes it through `visibleRange` to get
 * the actual bounds, so week alignment lives in exactly one place.
 */
export function reviewAnchor(todayISO: string, weekStart: number): string {
  const d = new Date(todayISO + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return todayISO;
  // Day index within the week, 0 = the configured first day.
  const offset = (d.getUTCDay() - weekStart + 7) % 7;
  if (offset !== 6) return todayISO; // mid-week → this week
  return new Date(d.getTime() + 86400000).toISOString().slice(0, 10); // last day → next week
}

/**
 * Recurring tasks projected across a date range.
 *
 * `tasksToItems` places a task on its **current** `scheduled` date only — correct for the
 * calendar and for Today, because a recurring task advances when you complete it and has no
 * meaningful presence on future days until then. For a *review* of a week you haven't lived
 * yet that's wrong: a task like the litter tray, due three times every day, would vanish
 * completely from next week's page.
 *
 * So the review expands the rule instead. Callers must pass only recurring tasks here and
 * only non-recurring ones to `tasksToItems`, or the current occurrence appears twice.
 */
export function expandRecurringTasks(
  tasks: Task[],
  fromISO: string,
  toISO: string,
  slotMinutes = 15
): CalendarItem[] {
  const out: CalendarItem[] = [];
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to) return out;

  for (const t of tasks) {
    if (t.status === "done" || t.status === "hold") continue;
    const rule = parseRRule(t.recurrence);
    if (!rule) continue;
    const anchor = parseISO(t.scheduled ?? t.due ?? fromISO);
    const start = effectiveStart(rule, anchor, from);

    for (const occ of occurrencesInRange(rule, start, from, to)) {
      const date = formatISO(occ);
      if (t.exdates?.includes(date)) continue; // detached onto its own note — skip it here
      const slots = t.times ?? [];
      if (slots.length) {
        const done = doneTimesOn(t.completeSlots ?? {}, date);
        for (const s of slots) {
          out.push({
            kind: "task",
            path: t.path,
            title: s.label ? `${t.title} — ${s.label}` : t.title,
            date,
            allDay: false,
            start: s.time,
            end: addMinutesHM(s.time, slotMinutes),
            done: done.includes(s.time),
            category: "task",
            recurring: true,
            slotTime: s.time,
            priority: t.priority,
          });
        }
        continue;
      }
      out.push({
        kind: "task",
        path: t.path,
        title: t.title,
        date,
        allDay: !t.startTime,
        start: t.startTime,
        end: t.endTime,
        // Only the occurrence actually logged counts as done; future ones are open.
        done: t.completeInstances?.includes(date) ?? false,
        category: "task",
        recurring: true,
        priority: t.priority,
      });
    }
  }
  return out;
}
