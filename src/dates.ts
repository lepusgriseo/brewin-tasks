// Pure date helpers. All internal math is done on UTC-midnight Date objects so
// there is never any DST/timezone drift; "today" is derived from the local
// calendar day then pinned to UTC midnight. No Obsidian imports.

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** Parse "YYYY-MM-DD" (optionally with trailing time) into a UTC-midnight Date, or null. */
export function parseISO(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

/** Format a UTC-midnight Date as "YYYY-MM-DD". */
export function formatISO(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Coerce an arbitrary frontmatter value (Date | string | number) into an ISO date string or null. */
export function coerceISO(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return formatISO(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())));
  const d = parseISO(String(v));
  return d ? formatISO(d) : null;
}

/** Local calendar "today" as a UTC-midnight Date. Pass an override for deterministic tests. */
export function todayUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function todayISO(now: Date = new Date()): string {
  return formatISO(todayUTC(now));
}

/** ISO "YYYY-MM" for the month a given ISO day falls in. */
export function monthOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

const MS_DAY = 86400000;

/**
 * ISO-8601 week label ("2026-W37") for the week a given ISO day belongs to — the same
 * scheme the vault's periodic week notes use. Resolved via the week's Thursday, which
 * defines both the year and the number, so year boundaries and 53-week years are handled.
 */
export function isoWeekOf(dateISO: string): string {
  const d = parseISO(dateISO);
  if (!d) return "";
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thu = addDays(d, 3 - dow); // the Thursday of this ISO week
  const year = thu.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.floor((thu.getTime() - jan1.getTime()) / (7 * MS_DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface MonthWeek {
  /** ISO week label, e.g. "2026-W37". */
  week: string;
  /** ISO date of the week's Monday. */
  start: string;
  /** ISO date of the week's Sunday. */
  end: string;
}

/**
 * Every ISO week (Mon–Sun) with at least one day in `monthISO` ("YYYY-MM"), in order.
 * Returns 4–6 entries. Boundary weeks that spill into the previous/next month are included
 * whole — they are real ISO weeks and stay consistent when the neighbouring month is viewed.
 */
export function isoWeeksOfMonth(monthISO: string): MonthWeek[] {
  const first = parseISO(monthISO + "-01");
  if (!first) return [];
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const out: MonthWeek[] = [];
  for (let mon = startOfWeekMon(first); mon.getTime() <= last.getTime(); mon = addDays(mon, 7)) {
    out.push({ week: isoWeekOf(formatISO(mon)), start: formatISO(mon), end: formatISO(addDays(mon, 6)) });
  }
  return out;
}

/**
 * The Mon–Sun ISO date range of an ISO-week label ("2026-W37"). Returns null if the label
 * is malformed or doesn't round-trip through `isoWeekOf` — e.g. "2025-W53" (2025 has only 52
 * ISO weeks), so callers can fall back rather than compute a bogus range.
 *
 * Inverse of `isoWeekOf`: ISO week 1 is the week containing Jan 4, so week N's Monday is
 * `startOfWeekMon(Jan 4)` + (N−1) weeks.
 */
export function weekRange(label: string): { start: string; end: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(label).trim());
  if (!m) return null;
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const week1Mon = startOfWeekMon(new Date(Date.UTC(Number(m[1]), 0, 4)));
  const start = addDays(week1Mon, (week - 1) * 7);
  const startISO = formatISO(start);
  if (isoWeekOf(startISO) !== `${m[1]}-W${m[2]}`) return null; // e.g. W53 of a 52-week year
  return { start: startISO, end: formatISO(addDays(start, 6)) };
}

/** An ISO date as a short human label, e.g. "6 Sep". Uses UTC to match the rest of this module. */
export function shortDate(dateISO: string): string {
  const d = parseISO(dateISO);
  return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : dateISO;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}

/** Add months, clamping the day to the target month's length (e.g. Jan 31 + 1mo → Feb 28). */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const day = d.getUTCDate();
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = daysInMonth(targetY, targetM);
  return new Date(Date.UTC(targetY, targetM, Math.min(day, lastDay)));
}

export function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/** 0=Sun … 6=Sat */
export function dayOfWeek(d: Date): number {
  return d.getUTCDay();
}

/** Whole days from a→b (b−a). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

/** Whole calendar months from a→b. */
export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** Monday-based start of the ISO week (RRULE default WKST=MO). */
export function startOfWeekMon(d: Date): Date {
  const dow = dayOfWeek(d); // 0=Sun..6=Sat
  const shift = (dow + 6) % 7; // Mon→0, Tue→1 … Sun→6
  return addDays(d, -shift);
}

/** 1-based ordinal of `d` among all same-weekday dates in its month, and the negative index from the end. */
export function weekdayOrdinalInMonth(d: Date): { fromStart: number; fromEnd: number } {
  const day = d.getUTCDate();
  const fromStart = Math.floor((day - 1) / 7) + 1;
  const dim = daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
  const fromEnd = -(Math.floor((dim - day) / 7) + 1);
  return { fromStart, fromEnd };
}

export function isBefore(a: string, b: string): boolean {
  return a < b; // ISO strings compare lexicographically == chronologically
}
export function isAfter(a: string, b: string): boolean {
  return a > b;
}
export function isSameOrBefore(a: string, b: string): boolean {
  return a <= b;
}

// ── Time-of-day helpers (for events + week/day calendar) ─────────────

/** Parse "HH:MM" (or "H:MM") → minutes since midnight, or null. */
export function minutesOfDay(hm: string | null | undefined): number | null {
  if (!hm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // "24:00" is the end-of-day marker used when a block runs to midnight.
  if (h === 24 && min === 0) return 1440;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The end-of-day sentinel used as the end time of a block that continues past midnight. */
export const END_OF_DAY = "24:00";

/** Minutes elapsed in the current LOCAL day — drives the calendar's now-line. */
export function nowMinutes(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** Format minutes-since-midnight → "HH:MM". */
export function formatHM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Whole-day difference bISO − aISO. */
export function dayDelta(aISO: string, bISO: string): number {
  const a = parseISO(aISO);
  const b = parseISO(bISO);
  return a && b ? daysBetween(a, b) : 0;
}

/** Shift an ISO date by `days`, or null if unparseable. */
export function shiftISO(iso: string, days: number): string | null {
  const d = parseISO(iso);
  return d ? formatISO(addDays(d, days)) : null;
}

/** Minutes between two "HH:MM" times (defaults to 60 when missing/invalid). */
export function durationMinutes(startHM: string | null, endHM: string | null): number {
  const s = minutesOfDay(startHM);
  const e = minutesOfDay(endHM);
  if (s == null || e == null || e <= s) return 60;
  return e - s;
}

/** Add minutes to an "HH:MM" time, clamped within the day. */
export function addMinutesHM(hm: string, minutes: number): string {
  const base = minutesOfDay(hm) ?? 0;
  return formatHM(Math.min(1439, base + minutes));
}

// ── Calendar grid helpers ────────────────────────────────────────────

/** The 7 dates of the week containing `d`, starting at `weekStart` (0=Sun,1=Mon). */
export function weekDates(d: Date, weekStart: number): Date[] {
  const dow = dayOfWeek(d);
  const back = (dow - weekStart + 7) % 7;
  const start = addDays(d, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * A month grid: whole weeks (rows of 7) spanning the month of `year`/`month0`,
 * padded to include leading/trailing days so every row is a full week.
 * Returns 4–6 rows.
 */
export function monthMatrix(year: number, month0: number, weekStart: number): Date[][] {
  const first = new Date(Date.UTC(year, month0, 1));
  const back = (dayOfWeek(first) - weekStart + 7) % 7;
  const gridStart = addDays(first, -back);
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const fwd = (weekStart + 6 - dayOfWeek(last) + 7) % 7;
  const gridEnd = addDays(last, fwd);
  const rows: Date[][] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    rows.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  }
  return rows;
}

/** Weekday header labels ordered from `weekStart`. */
export function weekdayHeaders(weekStart: number): string[] {
  const base = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Array.from({ length: 7 }, (_, i) => base[(weekStart + i) % 7]);
}
