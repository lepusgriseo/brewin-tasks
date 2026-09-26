// Pure calendar helpers (no Obsidian imports): visible range per view + time-grid positioning.

import { addDays, formatISO, minutesOfDay, monthMatrix, parseISO, weekDates } from "./dates";

export type CalView = "month" | "week" | "day";

/** Inclusive [from,to] ISO range a view covers, anchored on `anchorISO`. */
export function visibleRange(view: CalView, anchorISO: string, weekStart: number): { from: string; to: string } {
  const anchor = parseISO(anchorISO)!;
  if (view === "day") return { from: anchorISO, to: anchorISO };
  if (view === "week") {
    const days = weekDates(anchor, weekStart);
    return { from: formatISO(days[0]), to: formatISO(days[6]) };
  }
  const rows = monthMatrix(anchor.getUTCFullYear(), anchor.getUTCMonth(), weekStart);
  return { from: formatISO(rows[0][0]), to: formatISO(rows[rows.length - 1][6]) };
}

/** Step the anchor by one unit of the current view (dir −1/+1). */
export function stepAnchor(view: CalView, anchorISO: string, dir: number): string {
  const anchor = parseISO(anchorISO)!;
  if (view === "day") return formatISO(addDays(anchor, dir));
  if (view === "week") return formatISO(addDays(anchor, dir * 7));
  // month
  const m = anchor.getUTCMonth() + dir;
  return formatISO(new Date(Date.UTC(anchor.getUTCFullYear(), m, 1)));
}

export interface TimeBox {
  topPx: number;
  heightPx: number;
}

/** Smallest block we'll draw — enough to stay readable and tappable. */
export const MIN_BLOCK_PX = 16;

/**
 * Vertical placement of a timed item in an hour grid.
 *
 * The height floor is an absolute pixel minimum, NOT a fraction of `hourPx`: at a zoomed-in
 * resolution (120px/hour) a real 15-minute block is 30px and must render at exactly that,
 * or it would overflow its slot and misrepresent its duration.
 */
export function blockRange(startHM: string | null, endHM: string | null, dayStartHour = 0): [number, number] {
  const s = minutesOfDay(startHM) ?? dayStartHour * 60;
  let e = minutesOfDay(endHM) ?? s + 30;
  if (e <= s) e = s + 30; // a missing or inverted end still occupies a visible slot
  return [s, e];
}

export function timeBox(startHM: string | null, endHM: string | null, hourPx: number, dayStartHour = 0): TimeBox {
  const [s, e] = blockRange(startHM, endHM, dayStartHour);
  const top = ((s - dayStartHour * 60) / 60) * hourPx;
  const height = ((e - s) / 60) * hourPx;
  return { topPx: Math.max(0, top), heightPx: Math.max(MIN_BLOCK_PX, height) };
}

export interface DayMarks {
  /** The value currently being picked. */
  selected: boolean;
  /** The paired date (e.g. the due date while picking `scheduled`). */
  related: boolean;
  /** Strictly between the selected and paired dates. */
  inSpan: boolean;
  today: boolean;
}

/**
 * Which marks a day cell in the date picker should carry. `selected` wins over `related`
 * when they're the same day, and the span never includes its own endpoints.
 */
export function dayMarks(
  iso: string,
  selectedISO: string | null,
  relatedISO: string | null,
  todayISO: string
): DayMarks {
  const selected = !!selectedISO && iso === selectedISO;
  const related = !!relatedISO && iso === relatedISO && !selected;
  const lo = selectedISO && relatedISO ? (selectedISO < relatedISO ? selectedISO : relatedISO) : null;
  const hi = selectedISO && relatedISO ? (selectedISO < relatedISO ? relatedISO : selectedISO) : null;
  const inSpan = !!lo && !!hi && iso > lo && iso < hi;
  return { selected, related, inSpan, today: iso === todayISO };
}

/** Human title for the current view (e.g. "July 2026", "Jul 20–26, 2026", "Fri 24 Jul 2026"). */
export function viewTitle(view: CalView, anchorISO: string, weekStart: number): string {
  const d = parseISO(anchorISO)!;
  const mLong = d.toLocaleString("default", { month: "long", timeZone: "UTC" });
  if (view === "month") return `${mLong} ${d.getUTCFullYear()}`;
  if (view === "day") {
    return d.toLocaleString("default", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  const days = weekDates(d, weekStart);
  const a = days[0];
  const b = days[6];
  const aM = a.toLocaleString("default", { month: "short", timeZone: "UTC" });
  const bM = b.toLocaleString("default", { month: "short", timeZone: "UTC" });
  return `${aM} ${a.getUTCDate()} – ${bM} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}
