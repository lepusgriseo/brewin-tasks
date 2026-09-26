// Pure mappers: tasks / events / project tasks → unified CalendarItem[]. No Obsidian imports.

import { addDays, addMinutesHM, END_OF_DAY, formatISO, minutesOfDay, parseISO } from "./dates";
import { doneTimesOn } from "./slots";
import { taskCoversDay, taskDayIndex, taskLastDay, taskSpanDays } from "./task";
import { effectiveStart, occurrencesInRange, parseRRule } from "./rrule";
import { CalendarItem, CalendarKind, EventItem, Task } from "./types";

function daysInRange(fromISO: string, toISO: string): string[] {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to || from > to) return [];
  const out: string[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard < 800) {
    out.push(formatISO(d));
    d = addDays(d, 1);
    guard++;
  }
  return out;
}

/**
 * Tasks placed on their scheduled day (falling back to due). A task with a `startTime`
 * becomes a timed block in the hour grid; without one it stays in the all-day band.
 *
 * `skipMultiDay` drops the per-day "(idx/span)" chips for a multi-day task instead of
 * emitting them — used by the calendar GRID, which renders those tasks as one spanning bar
 * (see `taskSpans` in calendarLayout.ts) rather than a chip per day. Other callers (the
 * dashboard's flat agenda list, which has no concept of a bar) leave this off and keep the
 * per-day breakdown, which reads fine in a plain list.
 */
export function tasksToItems(
  tasks: Task[],
  fromISO: string,
  toISO: string,
  slotMinutes = 15,
  opts: { skipMultiDay?: boolean } = {}
): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const t of tasks) {
    const day = t.scheduled ?? t.due;
    if (!day) continue;
    // Defensive: a recurring task's own anchor should never itself be exdated (detaching the
    // CURRENT occurrence also advances the anchor past it — see skipRecurringOccurrence), but
    // this is cheap insurance against hand-edited frontmatter leaving the two inconsistent.
    if (t.exdates?.includes(day)) continue;
    // A span may start before the window and still be visible inside it.
    const lastDay = taskLastDay(t) ?? day;
    if (lastDay < fromISO || day > toISO) continue;

    // A multi-slot task is several short blocks in one day, each tickable on its own,
    // rather than one chip — the whole point is seeing the 08:00 / 13:00 / 20:00 rhythm.
    if (t.times?.length) {
      const done = doneTimesOn(t.completeSlots ?? {}, day);
      for (const slot of t.times) {
        out.push({
          kind: "task",
          path: t.path,
          title: slot.label ? `${t.title} — ${slot.label}` : t.title,
          date: day,
          allDay: false,
          start: slot.time,
          end: addMinutesHM(slot.time, slotMinutes),
          done: done.includes(slot.time),
          category: "task",
          recurring: !!t.recurrence,
          slotTime: slot.time,
          priority: t.priority,
        });
      }
      continue;
    }
    // A multi-day task appears on every day it covers, labelled with its position in the
    // span, so a five-day job reads as ongoing work rather than five unrelated copies.
    const span = taskSpanDays(t);
    if (span > 1 && t.scheduled) {
      if (opts.skipMultiDay) continue;
      const last = taskLastDay(t)!;
      for (const covered of daysInRange(t.scheduled, last)) {
        if (covered < fromISO || covered > toISO) continue;
        const idx = taskDayIndex(t, covered);
        out.push({
          kind: "task",
          path: t.path,
          title: `${t.title} (${idx}/${span})`,
          date: covered,
          allDay: true,
          start: null,
          end: null,
          done: t.status === "done",
          category: "task",
          recurring: !!t.recurrence,
          priority: t.priority,
        });
      }
      continue;
    }

    // Only a task on its *scheduled* day can be timed — a due-date placement is a deadline.
    const timed = !!t.startTime && day === t.scheduled;
    out.push({
      kind: "task",
      path: t.path,
      title: t.title,
      date: day,
      allDay: !timed,
      start: timed ? t.startTime : null,
      end: timed ? t.endTime : null,
      done: t.status === "done",
      category: "task",
      recurring: !!t.recurrence,
      priority: t.priority,
    });
  }
  return out;
}

function emitEventOn(out: CalendarItem[], ev: EventItem, startISO: string, fromISO: string, toISO: string, recurring: boolean): void {
  // How many days past the start day the event reaches. For all-day events `endDate` is
  // the exclusive next day; for timed events it's the day the end time falls on.
  let spanDays = 0;
  if (ev.endDate && ev.date && ev.endDate > ev.date) {
    spanDays = daysInRange(ev.date, ev.endDate).length - 1 - (ev.allDay ? 1 : 0);
    if (spanDays < 0) spanDays = 0;
  }
  const startDate = parseISO(startISO);
  const lastCovered = startDate ? formatISO(addDays(startDate, spanDays)) : startISO;

  const clampStart = startISO < fromISO ? fromISO : startISO;
  const clampEnd = lastCovered > toISO ? toISO : lastCovered;

  for (const day of daysInRange(clampStart, clampEnd)) {
    const isFirst = day === startISO;
    const isLast = day === lastCovered;
    // A timed event crossing midnight becomes one block per day: start→midnight,
    // full days in between, then midnight→end.
    const start = ev.allDay ? null : isFirst ? ev.startTime : "00:00";
    const end = ev.allDay ? null : isLast ? ev.endTime : END_OF_DAY;
    out.push({
      kind: "event",
      path: ev.path,
      title: ev.title,
      date: day,
      allDay: ev.allDay,
      start,
      end,
      done: ev.completed,
      category: ev.category,
      recurring,
      location: ev.location,
    });
  }
}

/** Events expanded across each covered day within the range (and across recurrences). */
export function eventsToItems(events: EventItem[], fromISO: string, toISO: string): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const ev of events) {
    if (!ev.date) continue;
    if (ev.recurrence) {
      const rule = parseRRule(ev.recurrence);
      if (rule) {
        const anchor = parseISO(ev.date);
        const from = parseISO(fromISO)!;
        const to = parseISO(toISO)!;
        const start = effectiveStart(rule, anchor, from);
        for (const occ of occurrencesInRange(rule, start, from, to)) {
          const occISO = formatISO(occ);
          if (ev.exdates.includes(occISO)) continue;
          emitEventOn(out, ev, occISO, fromISO, toISO, true);
        }
        continue;
      }
    }
    emitEventOn(out, ev, ev.date, fromISO, toISO, false);
  }
  return out;
}

/** Structural shape of a surfaced project checkbox task (matches projectTasks.ts's ProjectTask). */
export interface ProjectTaskLike {
  projectPath: string;
  projectName: string;
  line: number;
  text: string;
  scheduled: string | null;
  due: string | null;
}

/** Project tasks placed on their scheduled date (falling back to due), coloured as `category`. */
export function projectTasksToItems(tasks: ProjectTaskLike[], fromISO: string, toISO: string, category: string): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const t of tasks) {
    const day = t.scheduled ?? t.due;
    if (!day || day < fromISO || day > toISO) continue;
    out.push({
      kind: "project",
      path: t.projectPath,
      title: t.text || "(untitled task)",
      date: day,
      allDay: true,
      start: null,
      end: null,
      done: false,
      category,
      recurring: false,
      line: t.line,
    });
  }
  return out;
}

/**
 * Reading order within a day when nothing else separates two items: commitments to other
 * people first, then your own work. Project tasks sit just after tasks, since that's what
 * they are — surfaced from a project note rather than standing on their own.
 */
const KIND_RANK: Record<CalendarKind, number> = { event: 0, task: 1, project: 2 };

/**
 * Sort items within a day: outstanding work first and anything already completed last
 * (so completed items sink to the bottom of the all-day band and month cells), then
 * all-day before timed, then by start time, then by kind, then title.
 *
 * Kind is compared *after* start time on purpose. All-day items have no start, so both
 * sides read 0 and the comparison falls through to kind — which is what orders the all-day
 * band as events → tasks. Timed items still sort by the clock, where a 17:00 event must not
 * jump ahead of an 09:00 task.
 */
export function sortItems(items: CalendarItem[]): CalendarItem[] {
  return items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const sa = minutesOfDay(a.start) ?? 0;
    const sb = minutesOfDay(b.start) ?? 0;
    if (sa !== sb) return sa - sb;
    const ka = KIND_RANK[a.kind] ?? 9;
    const kb = KIND_RANK[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return a.title.localeCompare(b.title);
  });
}

/** Group items by ISO day. */
export function groupItemsByDay(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const it of sortItems(items)) {
    if (!map.has(it.date)) map.set(it.date, []);
    map.get(it.date)!.push(it);
  }
  return map;
}
