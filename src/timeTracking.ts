// Pure time-tracking maths: how much time was spent per category over a date range.
// No Obsidian imports → unit-testable.
//
// Only events with a real start AND end time count — all-day entries have no duration
// and would otherwise invent hours. Recurring events are expanded so every occurrence in
// range is counted. Archived events count under `originalCategory`, so history stays
// attributed to the work it actually was.

import { addDays, dayDelta, daysBetween, formatISO, minutesOfDay, parseISO, startOfWeekMon } from "./dates";
import { effectiveStart, occurrencesInRange, parseRRule } from "./rrule";
import { EventItem } from "./types";

export interface CategoryTotal {
  category: string;
  minutes: number;
  /** Number of occurrences counted. */
  count: number;
  /** Share of the grand total, 0–1. */
  share: number;
}

/**
 * Duration of one timed event in minutes, or 0 when it isn't a timed event.
 *
 * For timed events `endDate` (when set) is the day the end time falls on, so an event can
 * legitimately span midnight or several days. With no `endDate`, an end time earlier than
 * the start is read as running overnight into the next day.
 */
export function eventMinutes(ev: EventItem): number {
  if (ev.allDay) return 0;
  const s = minutesOfDay(ev.startTime);
  const e = minutesOfDay(ev.endTime);
  if (s == null || e == null) return 0;

  const spanDays = ev.endDate && ev.date && ev.endDate > ev.date ? dayDelta(ev.date, ev.endDate) : 0;
  if (spanDays > 0) return spanDays * 1440 + (e - s);
  return e >= s ? e - s : 1440 - s + e; // no end date → an earlier end means overnight
}

/** Every dated occurrence of `ev` inside [fromISO,toISO] (recurrence-aware, EXDATE-aware). */
export function occurrenceDates(ev: EventItem, fromISO: string, toISO: string): string[] {
  if (!ev.date) return [];
  if (!ev.recurrence) {
    return ev.date >= fromISO && ev.date <= toISO ? [ev.date] : [];
  }
  const rule = parseRRule(ev.recurrence);
  if (!rule) return [];
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to) return [];
  const start = effectiveStart(rule, parseISO(ev.date), from);
  return occurrencesInRange(rule, start, from, to)
    .map(formatISO)
    .filter((d) => !ev.exdates.includes(d));
}

/** Total minutes per category over the range, largest first. */
export function totalsByCategory(events: EventItem[], fromISO: string, toISO: string): CategoryTotal[] {
  const mins = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const ev of events) {
    const per = eventMinutes(ev);
    if (per <= 0) continue; // not a timed event
    const occurrences = occurrenceDates(ev, fromISO, toISO).length;
    if (!occurrences) continue;
    const cat = ev.originalCategory || ev.category || "General";
    mins.set(cat, (mins.get(cat) ?? 0) + per * occurrences);
    counts.set(cat, (counts.get(cat) ?? 0) + occurrences);
  }

  const grand = [...mins.values()].reduce((a, b) => a + b, 0);
  return [...mins.entries()]
    .map(([category, minutes]) => ({
      category,
      minutes,
      count: counts.get(category) ?? 0,
      share: grand > 0 ? minutes / grand : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || a.category.localeCompare(b.category));
}

export function grandTotalMinutes(totals: CategoryTotal[]): number {
  return totals.reduce((sum, t) => sum + t.minutes, 0);
}

/** Merge overlapping [start,end) ranges so shared time isn't counted twice. */
export function mergeIntervals(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Wall-clock minutes actually occupied by events in the range — the UNION, so two
 * overlapping meetings count once. This is what "allocated" means; summing the
 * per-category totals would double-count them.
 */
export function allocatedMinutes(events: EventItem[], fromISO: string, toISO: string): number {
  const from = parseISO(fromISO);
  if (!from) return 0;
  const spanMinutes = (daysBetween(from, parseISO(toISO)!) + 1) * 1440;
  const ranges: [number, number][] = [];

  for (const ev of events) {
    const dur = eventMinutes(ev);
    if (dur <= 0) continue;
    for (const day of occurrenceDates(ev, fromISO, toISO)) {
      const d = parseISO(day);
      const startOfDay = d ? daysBetween(from, d) * 1440 : 0;
      const startAbs = startOfDay + (minutesOfDay(ev.startTime) ?? 0);
      // Clip to the range so an event running past the edge doesn't inflate the total.
      ranges.push([Math.max(0, startAbs), Math.min(spanMinutes, startAbs + dur)]);
    }
  }
  return mergeIntervals(ranges).reduce((sum, [s, e]) => sum + (e - s), 0);
}

export interface TimeBudget {
  /** Trackable minutes in the period (days × the day length you consider yours). */
  capacity: number;
  /** Occupied minutes (union — no double counting). */
  allocated: number;
  /** Whatever's left. Never negative. */
  unallocated: number;
  /** Per-category totals with shares measured against CAPACITY, not just tracked time. */
  totals: CategoryTotal[];
}

/**
 * How the period's time was spent, including the part that isn't accounted for.
 *
 * `dayMinutes` is how much of a day you consider trackable (waking hours by default), so
 * "unallocated" reads as free time rather than mostly sleep. When the range ends today,
 * pass `elapsedTodayMinutes` so the current day counts only as far as it's actually gone.
 */
export function timeBudget(
  events: EventItem[],
  fromISO: string,
  toISO: string,
  dayMinutes: number,
  elapsedTodayMinutes?: number
): TimeBudget {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to || from > to) {
    return { capacity: 0, allocated: 0, unallocated: 0, totals: [] };
  }

  const days = daysBetween(from, to) + 1;
  const lastDay = elapsedTodayMinutes == null ? dayMinutes : Math.max(0, Math.min(dayMinutes, elapsedTodayMinutes));
  const capacity = Math.max(0, (days - 1) * dayMinutes + lastDay);

  const allocated = Math.min(capacity, allocatedMinutes(events, fromISO, toISO));
  const base = totalsByCategory(events, fromISO, toISO);

  return {
    capacity,
    allocated,
    unallocated: Math.max(0, capacity - allocated),
    // Re-base each share on capacity so a category's slice reflects the real day.
    totals: base.map((t) => ({ ...t, share: capacity > 0 ? t.minutes / capacity : 0 })),
  };
}

/** "12h 30m" · "45m" · "0m" — compact and unambiguous. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

export interface WeekTotal {
  /** ISO date of the Monday starting the week. */
  weekStart: string;
  minutes: number;
}

/** Per-week totals across the range (Monday-based), oldest first — for the trend strip. */
export function weeklyTotals(events: EventItem[], fromISO: string, toISO: string): WeekTotal[] {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to || from > to) return [];

  const buckets = new Map<string, number>();
  let cursor = startOfWeekMon(from);
  let guard = 0;
  while (cursor <= to && guard < 520) {
    buckets.set(formatISO(cursor), 0);
    cursor = addDays(cursor, 7);
    guard++;
  }

  for (const ev of events) {
    const per = eventMinutes(ev);
    if (per <= 0) continue;
    for (const day of occurrenceDates(ev, fromISO, toISO)) {
      const d = parseISO(day);
      if (!d) continue;
      const key = formatISO(startOfWeekMon(d));
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + per);
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, minutes]) => ({ weekStart, minutes }));
}

/** Inclusive range for a named period ending today. */
export function periodRange(period: "week" | "month" | "year", todayISO: string): { from: string; to: string } {
  const today = parseISO(todayISO)!;
  if (period === "week") {
    const start = startOfWeekMon(today);
    return { from: formatISO(start), to: formatISO(addDays(start, 6)) };
  }
  if (period === "month") {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth();
    return {
      from: formatISO(new Date(Date.UTC(y, m, 1))),
      to: formatISO(new Date(Date.UTC(y, m + 1, 0))),
    };
  }
  const y = today.getUTCFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

export { daysBetween };
