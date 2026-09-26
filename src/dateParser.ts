// First-party natural-language date shortcut, used alongside the calendar picker.
// Returns an ISO "YYYY-MM-DD" string or null. No dependency on the nldates plugin.

import { addDays, dayOfWeek, formatISO, parseISO, todayUTC, WEEKDAY_CODES } from "./dates";

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** Next date for a given weekday strictly after today (or today if allowToday). */
function nextWeekday(from: Date, weekday: number, allowToday: boolean): Date {
  let delta = (weekday - dayOfWeek(from) + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDays(from, delta);
}

/**
 * Parse a natural-language date. `now` override makes it deterministic for tests.
 * Recognises: today/tod, tomorrow/tmr/tom, yesterday, <weekday>, next <weekday>,
 * +Nd/+Nw/+Nm-ish (+3d, +2w), "next week", "this weekend"/"weekend", eom (end of month),
 * and raw ISO YYYY-MM-DD. Empty/"none"/"clear" → null.
 */
export function parseNaturalDate(input: string, now: Date = new Date()): string | null {
  const raw = (input || "").trim().toLowerCase();
  if (!raw || raw === "none" || raw === "clear" || raw === "-") return null;

  const today = todayUTC(now);

  // Raw ISO date
  const iso = parseISO(raw);
  if (iso) return formatISO(iso);

  if (raw === "today" || raw === "tod") return formatISO(today);
  if (raw === "tomorrow" || raw === "tmr" || raw === "tom") return formatISO(addDays(today, 1));
  if (raw === "yesterday") return formatISO(addDays(today, -1));
  if (raw === "next week") return formatISO(addDays(today, 7));
  if (raw === "weekend" || raw === "this weekend") return formatISO(nextWeekday(today, 6, true));

  if (raw === "eom" || raw === "end of month") {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return formatISO(d);
  }

  // +Nd / +Nw / in N days
  let m = /^\+?(\d+)\s*(d|day|days)$/.exec(raw);
  if (m) return formatISO(addDays(today, parseInt(m[1], 10)));
  m = /^\+?(\d+)\s*(w|wk|week|weeks)$/.exec(raw);
  if (m) return formatISO(addDays(today, parseInt(m[1], 10) * 7));
  m = /^in\s+(\d+)\s*(d|day|days)$/.exec(raw);
  if (m) return formatISO(addDays(today, parseInt(m[1], 10)));
  m = /^in\s+(\d+)\s*(w|wk|week|weeks)$/.exec(raw);
  if (m) return formatISO(addDays(today, parseInt(m[1], 10) * 7));

  // next <weekday>
  m = /^next\s+([a-z]+)$/.exec(raw);
  if (m && WEEKDAY_NAMES[m[1]] !== undefined) {
    // "next monday" = the monday of next week (strictly after this week)
    const base = nextWeekday(today, WEEKDAY_NAMES[m[1]], false);
    return formatISO(base);
  }

  // bare <weekday> → the coming one (today counts)
  if (WEEKDAY_NAMES[raw] !== undefined) {
    return formatISO(nextWeekday(today, WEEKDAY_NAMES[raw], true));
  }

  return null;
}

export const WEEKDAY_CODE_LIST = WEEKDAY_CODES;
