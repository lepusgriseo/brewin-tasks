// Postpone: a task's do-date moved to a near day in one choice — tomorrow, the weekend, next week —
// rather than through the date picker. A repeating task moves this occurrence only (main.ts). Pure.

import { shiftISO } from "./dates";
import { nextWeekStart } from "./status";

export interface PostponeChoice {
  label: string;
  iso: string;
}

/** The coming Saturday: this week's on a weekday, next week's on a Saturday or Sunday. */
export function nextWeekendISO(todayISO: string): string {
  const d = new Date(`${todayISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

/** Tomorrow, the weekend and next week, as of `todayISO`. */
export function postponeChoices(todayISO: string, firstDayOfWeek: number): PostponeChoice[] {
  const weekday = new Date(`${todayISO}T00:00:00Z`).getUTCDay();
  return [
    { label: "tomorrow", iso: shiftISO(todayISO, 1) ?? todayISO },
    { label: weekday === 6 || weekday === 0 ? "next weekend" : "this weekend", iso: nextWeekendISO(todayISO) },
    { label: "next week", iso: nextWeekStart(todayISO, firstDayOfWeek) },
  ];
}
