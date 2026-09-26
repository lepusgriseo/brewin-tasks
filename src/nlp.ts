// One-line natural-language capture. No Obsidian imports → unit-testable.
//
//   "Water plants every sunday at 9am @home !high ~20m"
//     → title "Water plants", FREQ=WEEKLY;BYDAY=SU, 09:00, @home, high, 20 min
//
// Two rules keep this trustworthy rather than merely clever:
//
//  1. **Anything recognised is removed from the title**, so the title is what's left over.
//     A parser that leaves "tomorrow" in the title has failed even when the date is right.
//  2. **Every match is reported** in `matched`, so the UI can show what it understood before
//     anything is saved. Silent mis-parsing is worse than no parsing at all — the user must
//     be able to see that "march" became a date and correct it.
//
// Explicit sigils (@context, !priority, ~estimate) are unambiguous and matched greedily.
// Prose (dates, times, repeats) is matched conservatively: patterns are anchored to word
// boundaries and to lead-in words like "at", "by" and "every", so an ordinary word in a task
// title doesn't get eaten.

import { parseEstimate } from "./estimate";
import { Priority } from "./types";

export interface ParsedCapture {
  title: string;
  /** Do-date. */
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  /** Hard deadline — set by "by <date>". */
  due: string | null;
  recurrence: string | null;
  priority: Priority | null;
  contexts: string[];
  estimate: number | null;
  /** What was recognised, for the preview. */
  matched: { text: string; label: string }[];
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function atUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

/** Day index for a weekday word or 3-letter abbreviation, or -1. */
function dayIndex(word: string): number {
  const w = word.toLowerCase();
  return DAYS.findIndex((d) => d === w || d.slice(0, 3) === w);
}
function monthIndex(word: string): number {
  const w = word.toLowerCase();
  return MONTHS.findIndex((m) => m === w || m.slice(0, 3) === w);
}

/** "9", "9am", "9:30", "0930", "19:00" → "HH:MM". Null when it isn't a time. */
function toHM(raw: string, meridiem?: string): string | null {
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  const mer = meridiem?.toLowerCase();
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  // Without a meridiem a bare 1–7 almost always means the evening in a planner context;
  // anything else is read literally. 24h input passes straight through.
  if (!mer && m[2] === undefined && h >= 1 && h <= 7) h += 12;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

interface Cut {
  start: number;
  end: number;
  text: string;
  label: string;
}

/**
 * Parse one line. `now` is injectable so tests don't depend on the wall clock.
 */
export function parseCapture(input: string, now: Date = new Date()): ParsedCapture {
  const today = atUTC(now);
  const out: ParsedCapture = {
    title: "",
    date: null,
    startTime: null,
    endTime: null,
    due: null,
    recurrence: null,
    priority: null,
    contexts: [],
    estimate: null,
    matched: [],
  };

  const s = input;
  const cuts: Cut[] = [];

  /**
   * The span a match really occupies, ignoring surrounding whitespace it happened to
   * swallow. This matters: several patterns end in `\s*`, so "20:00-21:30 " would claim the
   * space that "@obsidian" needs as its own leading boundary, and the later match would then
   * be rejected as overlapping. Trimming both ends makes adjacent matches independent.
   */
  const spanOf = (m: RegExpExecArray) => {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    return { start: m.index + lead, end: m.index + raw.length - trail, text: raw.trim() };
  };
  const overlaps = (start: number, end: number) => cuts.some((c) => start < c.end && end > c.start);

  const scan = (re: RegExp, fn: (m: RegExpExecArray) => string | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const sp = spanOf(m);
      if (sp.end <= sp.start || overlaps(sp.start, sp.end)) {
        if (!re.global) break;
        continue;
      }
      const label = fn(m);
      if (label) cuts.push({ ...sp, label });
      if (!re.global) break;
    }
  };

  // ── Sigils: unambiguous, so they go first ──
  scan(/(^|\s)@([\w-]+)/g, (m) => {
    out.contexts.push(m[2]);
    return `@${m[2]}`;
  });
  scan(/(^|\s)!(high|med|medium|normal|low|!|[123])(?![\w])/gi, (m) => {
    const v = m[2].toLowerCase();
    const p: Priority = v === "high" || v === "!" || v === "1" ? "high" : v === "low" || v === "3" ? "low" : "normal";
    out.priority = p;
    return `${p} priority`;
  });
  // Wide enough for "1h30" and "1h 30m"; parseEstimate is the real validator, so a bad
  // match simply isn't taken rather than becoming a wrong number.
  scan(/(^|\s)~\s*(\d[\d.]*\s*[a-z]*\s*(?:\d+\s*[a-z]*)?)/gi, (m) => {
    const est = parseEstimate(m[2]);
    if (est == null) return null;
    out.estimate = est;
    return `~${m[2].trim()} estimate`;
  });

  // ── Recurrence — before dates, so "every monday" isn't eaten as a plain weekday ──
  scan(/\bevery\s+(day|weekday|weekdays|week|month|year)\b/gi, (m) => {
    const unit = m[1].toLowerCase();
    out.recurrence =
      unit === "day" ? "FREQ=DAILY"
      : unit.startsWith("weekday") ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
      : unit === "week" ? "FREQ=WEEKLY"
      : unit === "month" ? "FREQ=MONTHLY"
      : "FREQ=YEARLY";
    return `repeats ${m[0].toLowerCase()}`;
  });
  scan(/\bevery\s+(\d+)\s+(day|days|week|weeks|month|months)\b/gi, (m) => {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase().replace(/s$/, "");
    const freq = unit === "day" ? "DAILY" : unit === "week" ? "WEEKLY" : "MONTHLY";
    out.recurrence = `FREQ=${freq};INTERVAL=${n}`;
    return `repeats ${m[0].toLowerCase()}`;
  });
  // "every monday", "every mon and thu", "every tue, thu"
  scan(
    /\bevery\s+((?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?(?:\s*(?:,|and|&)\s*(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?)*)/gi,
    (m) => {
      const codes = m[1]
        .split(/\s*(?:,|and|&)\s*/)
        .map((w) => dayIndex(w.slice(0, 3)))
        .filter((i) => i >= 0)
        .map((i) => DAY_CODES[i]);
      if (!codes.length) return null;
      out.recurrence = `FREQ=WEEKLY;BYDAY=${[...new Set(codes)].join(",")}`;
      return `repeats ${m[0].toLowerCase()}`;
    }
  );
  scan(/\b(daily|weekly|monthly|yearly|annually)\b/gi, (m) => {
    if (out.recurrence) return null;
    const w = m[1].toLowerCase();
    out.recurrence =
      w === "daily" ? "FREQ=DAILY" : w === "weekly" ? "FREQ=WEEKLY" : w === "monthly" ? "FREQ=MONTHLY" : "FREQ=YEARLY";
    return `repeats ${w}`;
  });

  // ── Times — anchored to "at"/"from", or an explicit am/pm or HH:MM ──
  // A range first: "9-10am", "from 14:00 to 15:30".
  scan(
    /\b(?:from\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?/gi,
    (m) => {
      // A trailing meridiem applies to both halves when the first has none: "9-10am".
      const end = toHM(m[3], m[4]);
      const start = toHM(m[1], m[2] ?? m[4]);
      if (!start || !end) return null;
      out.startTime = start;
      out.endTime = end;
      return `${start}–${end}`;
    }
  );
  scan(/\bat\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\b/gi, (m) => {
    const t = toHM(m[1], m[2]);
    if (!t || out.startTime) return null;
    out.startTime = t;
    return `at ${t}`;
  });
  scan(/\b(\d{1,2}(?::\d{2}))\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/gi, (m) => {
    if (out.startTime) return null;
    const t = m[1] ? toHM(m[1], m[2]) : toHM(m[3], m[4]);
    if (!t) return null;
    out.startTime = t;
    return `at ${t}`;
  });
  // "for 45m" → a block length when there's a start time, otherwise just an estimate.
  scan(/\bfor\s+(\d[\d.]*\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\s*(?:\d+\s*(?:m|min|mins|minute|minutes)?)?)/gi, (m) => {
    const mins = parseEstimate(m[1]);
    if (mins == null) return null;
    if (out.startTime && !out.endTime) {
      const [h, mm] = out.startTime.split(":").map(Number);
      const total = h * 60 + mm + mins;
      out.endTime = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      return `for ${m[1].trim()}`;
    }
    if (out.estimate == null) {
      out.estimate = mins;
      return `~${m[1].trim()} estimate`;
    }
    return null;
  });

  // ── Dates. "by <date>" is a deadline; everything else is a do-date. ──
  const setDate = (value: string, deadline: boolean) => {
    if (deadline) out.due = value;
    else out.date = value;
  };
  const dateScan = (re: RegExp, resolve: (m: RegExpExecArray) => string | null) => {
    scan(re, (m) => {
      const value = resolve(m);
      if (!value) return null;
      const deadline = /\bby\s*$/i.test(s.slice(0, m.index)) || /^by\b/i.test(m[0]);
      if (deadline ? out.due : out.date) return null;
      setDate(value, deadline);
      return `${deadline ? "due" : "on"} ${value}`;
    });
  };

  dateScan(/\b(?:by\s+)?(\d{4}-\d{2}-\d{2})\b/g, (m) => m[1]);
  dateScan(/\b(?:by\s+)?(today|tonight|tmr|tomorrow|yesterday)\b/gi, (m) => {
    const w = m[1].toLowerCase();
    if (w === "yesterday") return iso(addDays(today, -1));
    return iso(addDays(today, w === "tmr" || w === "tomorrow" ? 1 : 0));
  });
  dateScan(/\b(?:by\s+)?in\s+(\d+)\s*(day|days|week|weeks|month|months)\b/gi, (m) => {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u.startsWith("day")) return iso(addDays(today, n));
    if (u.startsWith("week")) return iso(addDays(today, n * 7));
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() + n);
    return iso(d);
  });
  dateScan(/\b(?:by\s+)?next\s+(week|month|year)\b/gi, (m) => {
    const u = m[1].toLowerCase();
    if (u === "week") return iso(addDays(today, 7));
    const d = new Date(today);
    if (u === "month") d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCFullYear(d.getUTCFullYear() + 1);
    return iso(d);
  });
  // "next friday" / "this friday" / bare "friday" → the coming one.
  dateScan(
    /\b(?:by\s+)?(?:(next|this)\s+)?(mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b/gi,
    (m) => {
      const target = dayIndex(m[2].slice(0, 3));
      if (target < 0) return null;
      const cur = today.getUTCDay();
      // Start from the COMING one — a bare weekday never means today, so a task typed on
      // Friday saying "friday" lands next Friday rather than in the past by lunchtime.
      let delta = (target - cur + 7) % 7 || 7;
      // "next friday" is then a further week on top of that.
      if (m[1]?.toLowerCase() === "next") delta += 7;
      return iso(addDays(today, delta));
    }
  );
  // "3 aug" / "aug 3" / "3rd august 2027"
  dateScan(/\b(?:by\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/gi, (m) => {
    const mi = monthIndex(m[2]);
    if (mi < 0) return null;
    const year = m[3] ? Number(m[3]) : today.getUTCFullYear();
    let d = new Date(Date.UTC(year, mi, Number(m[1])));
    if (d.getUTCMonth() !== mi) return null; // e.g. 31 Feb
    if (!m[3] && d < today) d = new Date(Date.UTC(year + 1, mi, Number(m[1])));
    return iso(d);
  });
  dateScan(/\b(?:by\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/gi, (m) => {
    const mi = monthIndex(m[1]);
    if (mi < 0) return null;
    const year = m[3] ? Number(m[3]) : today.getUTCFullYear();
    let d = new Date(Date.UTC(year, mi, Number(m[2])));
    if (d.getUTCMonth() !== mi) return null;
    if (!m[3] && d < today) d = new Date(Date.UTC(year + 1, mi, Number(m[2])));
    return iso(d);
  });

  // A repeat with no start date starts today, so it has something to recur from.
  if (out.recurrence && !out.date) out.date = iso(today);

  // ── Build the leftover title ──
  cuts.sort((a, b) => a.start - b.start);
  let title = "";
  let cursor = 0;
  for (const c of cuts) {
    if (c.start < cursor) continue;
    title += s.slice(cursor, c.start) + " ";
    cursor = c.end;
  }
  title += s.slice(cursor);

  out.title = title
    .replace(/\s*\b(on|at|from|by|for|every)\b\s*$/i, " ") // dangling lead-in words
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .trim();

  out.matched = cuts.map((c) => ({ text: c.text, label: c.label }));
  return out;
}

/** One-line summary of what was understood, for the capture preview. */
export function describeParse(p: ParsedCapture): string {
  return p.matched.map((m) => m.label).join(" · ");
}
