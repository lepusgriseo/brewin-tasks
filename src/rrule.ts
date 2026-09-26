// Minimal, first-party iCal RRULE engine — enough for the recurrence patterns this
// vault uses (the 3 migrated routines: monthly-last-Sunday, monthly-by-monthday,
// weekly-by-day) plus daily/yearly and INTERVAL/COUNT/UNTIL. No external deps.
//
// Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (with optional
// ordinal like -1SU / 2MO), BYMONTHDAY, COUNT, UNTIL, and an optional DTSTART
// prefix ("DTSTART:20260726;FREQ=..." or "DTSTART=2026-07-26;FREQ=...").

import {
  addDays,
  daysBetween,
  dayOfWeek,
  formatISO,
  monthsBetween,
  parseISO,
  startOfWeekMon,
  WEEKDAY_CODES,
  weekdayOrdinalInMonth,
} from "./dates";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface ByDay {
  ordinal: number | null; // e.g. -1 (last), 2 (second), or null (every)
  weekday: number; // 0=Sun..6=Sat
}

export interface RRule {
  freq: Freq;
  interval: number;
  byday: ByDay[];
  bymonthday: number[];
  count: number | null;
  until: Date | null;
  dtstart: Date | null;
}

function parseDateToken(v: string): Date | null {
  // Accepts "20260726", "2026-07-26", optionally with a T-time suffix.
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  if (compact) return new Date(Date.UTC(+compact[1], +compact[2] - 1, +compact[3]));
  return parseISO(v);
}

function parseByDay(v: string): ByDay[] {
  return v
    .split(",")
    .map((tok) => tok.trim())
    .filter(Boolean)
    .map((tok) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(tok);
      if (!m) return null;
      const wd = WEEKDAY_CODES.indexOf(m[2] as (typeof WEEKDAY_CODES)[number]);
      if (wd < 0) return null;
      return { ordinal: m[1] ? Number(m[1]) : null, weekday: wd } as ByDay;
    })
    .filter((x): x is ByDay => x !== null);
}

/** Parse an RRULE string (with optional DTSTART prefix). Returns null if unparseable. */
export function parseRRule(input: string | null | undefined): RRule | null {
  if (!input) return null;
  const parts: Record<string, string> = {};
  let dtstart: Date | null = null;

  for (const rawSeg of String(input).split(/[;\n]/)) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    // DTSTART can be "DTSTART:2026..." or "DTSTART=2026..."
    const dt = /^DTSTART[:=](.+)$/i.exec(seg);
    if (dt) {
      dtstart = parseDateToken(dt[1].trim());
      continue;
    }
    const kv = /^([A-Z]+)=(.+)$/i.exec(seg);
    if (kv) parts[kv[1].toUpperCase()] = kv[2].trim();
  }

  const freq = (parts.FREQ || "").toUpperCase() as Freq;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;

  return {
    freq,
    interval: parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10)) : 1,
    byday: parts.BYDAY ? parseByDay(parts.BYDAY) : [],
    bymonthday: parts.BYMONTHDAY
      ? parts.BYMONTHDAY.split(",").map((n) => parseInt(n.trim(), 10)).filter((n) => !Number.isNaN(n))
      : [],
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
    until: parts.UNTIL ? parseDateToken(parts.UNTIL) : null,
    dtstart,
  };
}

function bydayMatches(rule: RRule, date: Date): boolean {
  if (rule.byday.length === 0) return true;
  const dow = dayOfWeek(date);
  const ord = weekdayOrdinalInMonth(date);
  return rule.byday.some((bd) => {
    if (bd.weekday !== dow) return false;
    if (bd.ordinal == null) return true;
    return bd.ordinal === ord.fromStart || bd.ordinal === ord.fromEnd;
  });
}

/** Does `date` fall on an occurrence of `rule`, given its effective start `start`? */
function matches(rule: RRule, start: Date, date: Date): boolean {
  if (date < start) return false;
  if (rule.until && date > rule.until) return false;

  switch (rule.freq) {
    case "DAILY": {
      const diff = daysBetween(start, date);
      return diff % rule.interval === 0;
    }
    case "WEEKLY": {
      const weeks = Math.floor(daysBetween(startOfWeekMon(start), startOfWeekMon(date)) / 7);
      if (weeks % rule.interval !== 0) return false;
      if (rule.byday.length === 0) return dayOfWeek(date) === dayOfWeek(start);
      return bydayMatches(rule, date);
    }
    case "MONTHLY": {
      const months = monthsBetween(start, date);
      if (months < 0 || months % rule.interval !== 0) return false;
      if (rule.bymonthday.length > 0) {
        const dim = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        const day = date.getUTCDate();
        return rule.bymonthday.some((n) => (n < 0 ? dim + n + 1 === day : n === day));
      }
      if (rule.byday.length > 0) return bydayMatches(rule, date);
      return date.getUTCDate() === start.getUTCDate();
    }
    case "YEARLY": {
      const years = date.getUTCFullYear() - start.getUTCFullYear();
      if (years < 0 || years % rule.interval !== 0) return false;
      if (date.getUTCMonth() !== start.getUTCMonth()) return false;
      if (rule.bymonthday.length > 0) return rule.bymonthday.includes(date.getUTCDate());
      return date.getUTCDate() === start.getUTCDate();
    }
  }
}

const MAX_SCAN_DAYS = 366 * 12; // safety cap when scanning forward

/**
 * The effective anchor/start for the rule: explicit DTSTART wins, else the task's
 * own anchor date (its scheduled/due), else `fallback`.
 */
export function effectiveStart(rule: RRule, anchor: Date | null, fallback: Date): Date {
  return rule.dtstart ?? anchor ?? fallback;
}

/**
 * First occurrence strictly after `after`. Honours COUNT (occurrences counted from
 * start) and UNTIL. Returns null if the series has ended.
 */
export function nextAfter(rule: RRule, start: Date, after: Date): Date | null {
  let cursor = addDays(after < start ? addDays(start, -1) : after, 1);
  let scanned = 0;
  // If COUNT is set we must count matches from the start, not just from `after`.
  let countSoFar = 0;
  if (rule.count != null) {
    let c = new Date(start.getTime());
    let guard = 0;
    while (c < cursor && guard < MAX_SCAN_DAYS) {
      if (matches(rule, start, c)) countSoFar++;
      c = addDays(c, 1);
      guard++;
    }
  }
  while (scanned < MAX_SCAN_DAYS) {
    if (rule.until && cursor > rule.until) return null;
    if (matches(rule, start, cursor)) {
      if (rule.count != null && countSoFar >= rule.count) return null;
      return cursor;
    }
    cursor = addDays(cursor, 1);
    scanned++;
  }
  return null;
}

/** First occurrence on or after `from`. */
export function firstOnOrAfter(rule: RRule, start: Date, from: Date): Date | null {
  if (from <= start) {
    if (matches(rule, start, start)) return start;
    return nextAfter(rule, start, start);
  }
  if (matches(rule, start, from)) return from;
  return nextAfter(rule, start, from);
}

/** Does `date` fall on an occurrence of `rule` (public wrapper around the matcher)? */
export function isOccurrence(rule: RRule, start: Date, date: Date): boolean {
  return matches(rule, start, date);
}

/** Set (or replace) the UNTIL of an RRULE string to `untilISO` (inclusive). Drops any COUNT. */
export function setUntil(rrule: string, untilISO: string): string {
  const until = untilISO.replace(/-/g, "");
  const parts = rrule
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !/^UNTIL=/i.test(p) && !/^COUNT=/i.test(p));
  parts.push(`UNTIL=${until}`);
  return parts.join(";");
}

/** Set (or replace) COUNT — repeat N times then stop. Drops any UNTIL. */
export function setCount(rrule: string, count: number): string {
  const n = Math.max(1, Math.floor(count));
  const parts = rrule
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !/^UNTIL=/i.test(p) && !/^COUNT=/i.test(p));
  parts.push(`COUNT=${n}`);
  return parts.join(";");
}

/** Remove UNTIL/COUNT so a series continues indefinitely. */
export function stripEnd(rrule: string): string {
  return rrule
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !/^UNTIL=/i.test(p) && !/^COUNT=/i.test(p))
    .join(";");
}

/** All occurrence dates in [from, to] inclusive. Used to place recurring items on the calendar. */
export function occurrencesInRange(rule: RRule, start: Date, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cursor = from < start ? new Date(start.getTime()) : new Date(from.getTime());
  let guard = 0;
  while (cursor <= to && guard < MAX_SCAN_DAYS) {
    if (matches(rule, start, cursor)) out.push(new Date(cursor.getTime()));
    cursor = addDays(cursor, 1);
    guard++;
  }
  return out;
}

/** Convenience: is `dateISO` an occurrence of `recurrence` anchored at `startISO`? */
export function occursOnISO(recurrence: string, startISO: string | null, dateISO: string): boolean {
  const rule = parseRRule(recurrence);
  if (!rule) return false;
  const date = parseISO(dateISO);
  if (!date) return false;
  const start = effectiveStart(rule, parseISO(startISO), date);
  return matches(rule, start, date);
}

/** Convenience: parse + compute the next occurrence ISO string strictly after `afterISO`. */
export function nextOccurrenceISO(
  recurrence: string,
  anchorISO: string | null,
  afterISO: string,
  fallbackISO: string
): string | null {
  const rule = parseRRule(recurrence);
  if (!rule) return null;
  const anchor = parseISO(anchorISO);
  const fallback = parseISO(fallbackISO) ?? new Date(Date.UTC(2000, 0, 1));
  const start = effectiveStart(rule, anchor, fallback);
  const after = parseISO(afterISO) ?? fallback;
  const next = nextAfter(rule, start, after);
  return next ? formatISO(next) : null;
}
