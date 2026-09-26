// Pure model + RRULE (de)serialisation for the "Custom…" recurrence builder. No Obsidian
// imports, so the actual rule-shaping logic is unit-testable without a modal in the loop.
//
// This deliberately only exposes what the existing engine (rrule.ts) can actually evaluate —
// it's a UI over that engine's real capabilities, not a superset of them:
//   - WEEKLY: any combination of weekdays (BYDAY=MO,TH,...), any interval.
//   - MONTHLY: either "on day N of the month" (BYMONTHDAY, N may be negative for "from the
//     end" — -1 is the last day) OR "on the Nth <weekday>" (BYDAY with an ordinal, e.g. -1SU
//     for "the last Sunday") — the two existing migrated routines this engine was built for.
//   - YEARLY: interval only. The engine always anchors YEARLY to the event's own month/day
//     (`matches()` in rrule.ts hard-checks the month and defaults the day to the anchor's),
//     so there's no "3rd Thursday of November every year" to build here — only "every N years".
//   - DAILY: interval only.

import { dayOfWeek, parseISO, WEEKDAY_CODES, weekdayOrdinalInMonth } from "./dates";
import { parseRRule } from "./rrule";

export type CustomFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type MonthlyMode = "day" | "weekday";

export interface CustomRecurrence {
  freq: CustomFreq;
  interval: number;
  /** WEEKLY only. 0=Sun..6=Sat. Empty behaves the same as "the anchor's own weekday" — the
   *  builder always fills this in rather than leaving it empty, so the UI shows a real chip
   *  checked instead of an unexplained blank state. */
  byday: number[];
  /** MONTHLY only — which of the two mutually exclusive shapes below applies. */
  monthlyMode: MonthlyMode;
  /** MONTHLY "day" mode: 1..31, or -1 for "the last day of the month". */
  monthDay: number;
  /** MONTHLY "weekday" mode: 1..4 (first..fourth), or -1 for "last". */
  monthWeekOrdinal: number;
  /** MONTHLY "weekday" mode: 0=Sun..6=Sat. */
  monthWeekday: number;
}

/** Sensible starting values derived from the item's own date, for a given frequency. */
export function defaultCustomRecurrence(anchorISO: string, freq: CustomFreq): CustomRecurrence {
  const d = parseISO(anchorISO) ?? new Date();
  const wd = dayOfWeek(d);
  const ord = weekdayOrdinalInMonth(d);
  return {
    freq,
    interval: 1,
    byday: [wd],
    monthlyMode: "day",
    monthDay: d.getUTCDate(),
    // If the anchor genuinely IS the month's last occurrence of its weekday, default to
    // "last" rather than e.g. "fourth" — "last Friday" is the far more common intent, and
    // "fourth Friday" would silently stop firing in a month with only four.
    monthWeekOrdinal: ord.fromEnd === -1 ? -1 : ord.fromStart,
    monthWeekday: wd,
  };
}

/** Serialise a builder state to an RRULE string (no DTSTART, no UNTIL/COUNT — those are the
 *  caller's concern, same as every other recurrence in this codebase). */
export function buildRRule(c: CustomRecurrence): string {
  const parts = [`FREQ=${c.freq}`];
  if (c.interval > 1) parts.push(`INTERVAL=${c.interval}`);

  if (c.freq === "WEEKLY") {
    const days = [...new Set(c.byday)].sort((a, b) => a - b);
    if (days.length) parts.push(`BYDAY=${days.map((d) => WEEKDAY_CODES[d]).join(",")}`);
  } else if (c.freq === "MONTHLY") {
    if (c.monthlyMode === "weekday") {
      parts.push(`BYDAY=${c.monthWeekOrdinal}${WEEKDAY_CODES[c.monthWeekday]}`);
    } else {
      parts.push(`BYMONTHDAY=${c.monthDay}`);
    }
  }
  return parts.join(";");
}

/**
 * Decode an RRULE (UNTIL/COUNT already stripped by the caller) back into builder state, for
 * editing an existing custom recurrence. Returns null when the rule has a shape this builder
 * doesn't produce — a hand-written or otherwise exotic RRULE — so the caller can fall back to
 * showing it as a plain, non-editable "Custom" value rather than silently mangling it.
 */
export function parseCustomRecurrence(rrule: string, anchorISO: string): CustomRecurrence | null {
  const rule = parseRRule(rrule);
  if (!rule) return null;
  const base = defaultCustomRecurrence(anchorISO, rule.freq);
  const out: CustomRecurrence = { ...base, interval: rule.interval };

  switch (rule.freq) {
    case "DAILY":
      return out;

    case "WEEKLY":
      if (rule.byday.some((b) => b.ordinal != null)) return null; // e.g. "2MO" — not weekly-shaped
      out.byday = rule.byday.length ? rule.byday.map((b) => b.weekday) : base.byday;
      return out;

    case "MONTHLY":
      if (rule.bymonthday.length && rule.byday.length) return null; // builder never sets both
      if (rule.bymonthday.length > 1 || rule.byday.length > 1) return null;
      if (rule.byday.length === 1) {
        const bd = rule.byday[0];
        if (bd.ordinal == null) return null;
        out.monthlyMode = "weekday";
        out.monthWeekOrdinal = bd.ordinal;
        out.monthWeekday = bd.weekday;
        return out;
      }
      out.monthlyMode = "day";
      if (rule.bymonthday.length === 1) out.monthDay = rule.bymonthday[0];
      return out;

    case "YEARLY": {
      if (rule.byday.length) return null; // engine can't evaluate this for YEARLY anyway
      if (rule.bymonthday.length > 1) return null;
      if (rule.bymonthday.length === 1) {
        // A bymonthday different from the anchor's own day is a shape this builder has no
        // control for (yearly is interval-only here) — don't pretend it round-trips.
        const anchor = parseISO(anchorISO);
        if (!anchor || rule.bymonthday[0] !== anchor.getUTCDate()) return null;
      }
      return out;
    }
  }
}
