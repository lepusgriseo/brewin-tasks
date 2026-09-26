// Task effort estimates. No Obsidian imports → unit-testable.
//
// The calendar already knows how much of the day events occupy (v1.23's unallocated time).
// Tasks carrying no estimate made the other half of the question unanswerable: a 1-hour
// Project Work block might hold three hours of intended work, and nothing said so until the
// evening ran out. An estimate is minutes, stored as a plain number.

/** Accepts "45", "45m", "1h", "1h30", "1.5h", "90 min", "2 hours". Null when unusable. */
export function parseEstimate(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;

  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // "1h30" / "1h 30m" / "1:30"
  const split = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|:)\s*(\d+)\s*(?:m|min|mins|minute|minutes)?$/.exec(s);
  if (split) {
    const mins = Math.round(Number(split[1]) * 60 + Number(split[2]));
    return mins > 0 ? mins : null;
  }
  // "1.5h" / "2 hours"
  const hours = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/.exec(s);
  if (hours) {
    const mins = Math.round(Number(hours[1]) * 60);
    return mins > 0 ? mins : null;
  }
  // "45m" / "90 min" / bare "45"
  const mins = /^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)?$/.exec(s);
  if (mins) {
    const n = Math.round(Number(mins[1]));
    return n > 0 ? n : null;
  }
  return null;
}

/** "1h 30m" · "45m" · "" when there's no estimate. */
export function formatEstimate(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

export interface Workload {
  /** Minutes of estimated work. */
  estimated: number;
  /** How many of the tasks carry an estimate. */
  withEstimate: number;
  /** How many don't — the figure is a floor, not a total, while this is non-zero. */
  withoutEstimate: number;
  /** Minutes of the day not already occupied by events. */
  free: number;
  /** Estimated work minus free time; positive means over-committed. */
  over: number;
}

/**
 * Does the day's intended work fit the time left in it?
 *
 * `estimated` deliberately counts only tasks that have an estimate, and `withoutEstimate`
 * reports the rest — so an over-commitment warning is never based on a number that silently
 * treats unestimated work as free.
 */
export function workload(
  estimates: (number | null)[],
  freeMinutes: number
): Workload {
  let estimated = 0;
  let withEstimate = 0;
  let withoutEstimate = 0;
  for (const e of estimates) {
    if (e != null && e > 0) {
      estimated += e;
      withEstimate++;
    } else {
      withoutEstimate++;
    }
  }
  const free = Math.max(0, freeMinutes);
  return { estimated, withEstimate, withoutEstimate, free, over: estimated - free };
}
