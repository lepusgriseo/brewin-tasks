// Pure layout for all-day events rendered as spanning bars. No Obsidian imports → testable.
// Turns all-day EventItems into inclusive spans, then packs them into lanes per week row so
// overlapping events stack without collision.

import { addDays, daysBetween, formatISO, parseISO } from "./dates";
import { effectiveStart, occurrencesInRange, parseRRule } from "./rrule";
import { taskLastDay, taskSpanDays } from "./task";
import { EventItem, Task } from "./types";

export interface AllDaySpan {
  path: string;
  title: string;
  /** Distinguishes an event span from a task span — tasks have no category of their own
   *  (`category` is a fixed placeholder), so the bar renderer needs this to style each kind
   *  the same way its chip already is: category-coloured for an event, accent-coloured for
   *  a task. */
  kind: "task" | "event";
  category: string;
  done: boolean;
  recurring: boolean;
  start: string; // inclusive ISO
  end: string; // inclusive ISO
  location: string | null;
}

export interface BarSegment {
  span: AllDaySpan;
  startCol: number; // 0-6 within the week
  endCol: number; // 0-6 inclusive
  lane: number;
  continuesLeft: boolean; // the span started before this week
  continuesRight: boolean; // the span continues after this week
}

/** All all-day events as inclusive [start,end] spans, expanding recurrence, clipped to [from,to]. */
export function allDaySpans(events: EventItem[], fromISO: string, toISO: string): AllDaySpan[] {
  const spans: AllDaySpan[] = [];

  const pushSpan = (ev: EventItem, startISO: string) => {
    let end = startISO;
    if (ev.endDate && ev.endDate > ev.date) {
      // endDate is exclusive; inclusive length = daysBetween(date,endDate)-1 added to this occurrence's start
      const len = daysBetween(parseISO(ev.date)!, parseISO(ev.endDate)!);
      end = formatISO(addDays(parseISO(startISO)!, Math.max(0, len - 1)));
    }
    const s = startISO < fromISO ? fromISO : startISO;
    const e = end > toISO ? toISO : end;
    if (s <= e && e >= fromISO && s <= toISO) {
      spans.push({
        path: ev.path,
        title: ev.title,
        kind: "event",
        category: ev.category,
        done: ev.completed,
        recurring: !!ev.recurrence,
        start: s,
        end: e,
        location: ev.location,
      });
    }
  };

  for (const ev of events) {
    if (!ev.allDay || !ev.date) continue;
    if (ev.recurrence) {
      const rule = parseRRule(ev.recurrence);
      if (rule) {
        const from = parseISO(fromISO)!;
        const to = parseISO(toISO)!;
        const start = effectiveStart(rule, parseISO(ev.date), from);
        for (const occ of occurrencesInRange(rule, start, from, to)) {
          const occISO = formatISO(occ);
          if (ev.exdates.includes(occISO)) continue;
          pushSpan(ev, occISO);
        }
        continue;
      }
    }
    pushSpan(ev, ev.date);
  }
  return spans;
}

/**
 * Multi-day tasks as inclusive [start,end] spans, clipped to [from,to] — the task equivalent
 * of `allDaySpans`, so "Run 10k" scheduled Friday→Sunday gets ONE spanning bar instead of
 * three separate day chips ("Run 10k (1/3)", "(2/3)", "(3/3)"). Single-day tasks (span 1)
 * aren't included here — those stay ordinary chips, same as before.
 *
 * Recurring multi-day tasks aren't expanded here (a rare combination); they fall back to the
 * existing per-day chips rather than being silently dropped from the calendar.
 */
export function taskSpans(tasks: Task[], fromISO: string, toISO: string): AllDaySpan[] {
  const spans: AllDaySpan[] = [];
  for (const t of tasks) {
    if (t.recurrence || !t.scheduled) continue;
    if (taskSpanDays(t) <= 1) continue;
    const start = t.scheduled < fromISO ? fromISO : t.scheduled;
    const end = taskLastDay(t)!;
    const e = end > toISO ? toISO : end;
    if (start > e || e < fromISO || start > toISO) continue;
    spans.push({
      path: t.path,
      title: t.title,
      kind: "task",
      category: "task",
      done: t.status === "done",
      recurring: false,
      start,
      end: e,
      location: null,
    });
  }
  return spans;
}

/** Pack the spans overlapping a given week into lane-assigned bar segments. */
export function segmentsForWeek(spans: AllDaySpan[], weekDates: string[]): BarSegment[] {
  const weekStart = weekDates[0];
  const weekEnd = weekDates[weekDates.length - 1];
  const inWeek = spans
    .filter((s) => s.start <= weekEnd && s.end >= weekStart)
    .sort((a, b) => (a.start !== b.start ? (a.start < b.start ? -1 : 1) : b.end.localeCompare(a.end)));

  const laneCols: Set<number>[] = [];
  const segs: BarSegment[] = [];

  for (const s of inWeek) {
    const segStart = s.start < weekStart ? weekStart : s.start;
    const segEnd = s.end > weekEnd ? weekEnd : s.end;
    const startCol = weekDates.indexOf(segStart);
    const endCol = weekDates.indexOf(segEnd);
    if (startCol < 0 || endCol < 0) continue;

    let lane = 0;
    for (;;) {
      const occ = laneCols[lane] ?? new Set<number>();
      let conflict = false;
      for (let c = startCol; c <= endCol; c++) {
        if (occ.has(c)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        if (!laneCols[lane]) laneCols[lane] = occ;
        for (let c = startCol; c <= endCol; c++) occ.add(c);
        break;
      }
      lane++;
    }

    segs.push({
      span: s,
      startCol,
      endCol,
      lane,
      continuesLeft: s.start < weekStart,
      continuesRight: s.end > weekEnd,
    });
  }
  return segs;
}

/** Number of lanes used (max lane + 1), i.e. the vertical stack height in bar-rows. */
export function laneCount(segments: BarSegment[]): number {
  return segments.reduce((m, s) => Math.max(m, s.lane + 1), 0);
}

// ── Timed-block overlap layout ───────────────────────────────────────────────

/** Where one timed block sits horizontally within its day column. */
export interface Placement {
  /** 0-based column within this block's overlap cluster. */
  column: number;
  /** How many columns that cluster was split into. */
  columns: number;
  /** Columns this block widens across to its right — always ≥ 1. */
  span: number;
}

/**
 * Side-by-side placement for timed blocks that overlap in the same day column.
 *
 * Without this every block is full width and simultaneous events simply cover each other,
 * leaving only the last-drawn one readable.
 *
 * Blocks are grouped into **clusters** of transitively-overlapping items; each cluster is
 * divided into as many columns as its worst simultaneous pile-up needs. A block then widens
 * rightwards over any column that has nothing overlapping it, so two events that merely
 * *touch* a third don't all get squeezed to a third of the width.
 *
 * Touching edges do not overlap: an event ending at 10:00 and one starting at 10:00 are
 * sequential, and both stay full width.
 *
 * Returns placements in the same order as `ranges`.
 */
export function packOverlaps(ranges: [number, number][]): Placement[] {
  const out: Placement[] = ranges.map(() => ({ column: 0, columns: 1, span: 1 }));
  if (!ranges.length) return out;

  // Longest-first within the same start, so a long block takes the leftmost column and
  // shorter ones settle to its right — which is how calendars conventionally read.
  const order = ranges
    .map((r, i) => i)
    .sort((a, b) => ranges[a][0] - ranges[b][0] || ranges[b][1] - ranges[a][1] || a - b);

  let cluster: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    // Greedy column assignment: reuse the first column whose last block has finished.
    const colEnds: number[] = [];
    const colOf = new Map<number, number>();
    for (const i of cluster) {
      const [s, e] = ranges[i];
      let col = colEnds.findIndex((end) => end <= s);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(e);
      } else {
        colEnds[col] = e;
      }
      colOf.set(i, col);
    }
    const columns = colEnds.length;
    for (const i of cluster) {
      const col = colOf.get(i)!;
      const [s, e] = ranges[i];
      // Widen right while the next column holds nothing that overlaps this block.
      let span = 1;
      for (let c = col + 1; c < columns; c++) {
        const blocked = cluster.some((j) => colOf.get(j) === c && ranges[j][0] < e && ranges[j][1] > s);
        if (blocked) break;
        span++;
      }
      out[i] = { column: col, columns, span };
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const i of order) {
    const [s, e] = ranges[i];
    // A block starting at or after everything so far has ended begins a fresh cluster.
    if (cluster.length && s >= clusterEnd) flush();
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();

  return out;
}
