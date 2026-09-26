// Pure event mapping. No Obsidian imports → unit-testable.

import { coerceISO, shiftISO } from "./dates";
import { parseRemindStart } from "./reminders";
import { EventItem } from "./types";

function asBool(v: unknown, dflt = false): boolean {
  if (v === true || v === false) return v;
  const s = String(v ?? "").toLowerCase();
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  return dflt;
}

function asHM(v: unknown): string | null {
  if (v == null || v === "") return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** Category name applied to archived events for display + filtering. */
export const ARCHIVED = "Archived";

/**
 * Where an event note belongs, given its category and date. An event's category IS its
 * subfolder, so changing the category must move the file — this is the single definition
 * of that mapping, used when creating and when editing.
 */
export function eventNotePath(root: string, category: string, dateISO: string, title: string): string {
  const dir = category && category !== "General" ? `${root}/${category}` : root;
  const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim() || "Event";
  return `${dir}/${dateISO} ${safe}.md`;
}

/** Category from the note's parent-folder name under the events root (else "General"). */
export function categoryFromPath(path: string, eventsFolder: string): string {
  const rel = path.startsWith(eventsFolder + "/") ? path.slice(eventsFolder.length + 1) : path;
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : "General";
}

export function eventFromFrontmatter(
  fm: Record<string, unknown>,
  path: string,
  basename: string,
  eventsFolder: string,
  archiveFolder?: string
): EventItem {
  const allDay = asBool(fm.allDay, true);
  // Archived events live under the archive folder but keep the category subfolder they
  // came from, so the real category survives for time reporting.
  const archived = !!archiveFolder && path.startsWith(archiveFolder + "/");
  const category = archived ? ARCHIVED : categoryFromPath(path, eventsFolder);
  const originalCategory = archived ? categoryFromPath(path, archiveFolder!) : category;
  return {
    path,
    title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : basename,
    date: coerceISO(fm.date) ?? "",
    endDate: coerceISO(fm.endDate),
    allDay,
    startTime: allDay ? null : asHM(fm.startTime),
    endTime: allDay ? null : asHM(fm.endTime),
    category,
    originalCategory,
    archived,
    completed: fm.completed != null && fm.completed !== false && String(fm.completed) !== "null",
    recurrence: fm.recurrence ? String(fm.recurrence) : null,
    exdates: Array.isArray(fm.recurrence_exdates)
      ? fm.recurrence_exdates.map((x) => coerceISO(x)).filter((x): x is string => !!x)
      : [],
    remind: fm.remind == null || fm.remind === "" ? null : String(fm.remind).trim(),
    remindStart: parseRemindStart(fm.remind_start),
    trip: fm.trip ? String(fm.trip).trim() || null : null,
    tripPath: null, // resolved by the store (needs the metadata cache)
    location: fm.location ? String(fm.location).trim() || null : null,
  };
}

/** Extract the link target from a stored wikilink (`"[[Trip|alias]]"` → `Trip`). */
export function tripLinkpath(trip: string | null): string | null {
  if (!trip) return null;
  const m = /^\[\[([^\]|#]+)/.exec(trip.trim());
  const raw = m ? m[1] : trip.trim();
  return raw.trim() || null;
}


/** The last calendar day an event covers (all-day endDate is exclusive, so subtract a day). */
export function eventLastCoveredISO(ev: EventItem): string {
  if (ev.endDate && ev.endDate > ev.date) {
    return ev.allDay ? shiftISO(ev.endDate, -1) ?? ev.date : ev.endDate;
  }
  return ev.date;
}

/** Does the event intersect [fromISO, toISO] (inclusive)? Handles multi-day via endDate. */
export function eventInRange(ev: EventItem, fromISO: string, toISO: string): boolean {
  if (!ev.date) return false;
  const start = ev.date;
  // endDate in this vault's all-day events is the exclusive next day; treat inclusive end as endDate-1 when present.
  const end = ev.endDate && ev.endDate > start ? ev.endDate : start;
  return start <= toISO && end >= fromISO;
}

/**
 * Convert an event's `endDate` when it flips between all-day and timed.
 *
 * The two carry **different conventions** (see `eventLastCoveredISO`): an all-day event's
 * `endDate` is EXCLUSIVE — the day after the last one covered — while a timed event's is the
 * actual day its end time falls on. Moving between them without adjusting silently gains or
 * loses a day on any multi-day event.
 *
 * Returns the new `endDate`, or null when there's no meaningful span left.
 */
export function convertEndDate(
  dateISO: string,
  endDate: string | null,
  toAllDay: boolean
): string | null {
  if (!endDate || endDate <= dateISO) return null;
  // timed (inclusive last day) → all-day (exclusive end): push one day out.
  if (toAllDay) return shiftISO(endDate, 1);
  // all-day (exclusive) → timed (inclusive): pull one day back, and drop it if that
  // collapses the span to a single day.
  const inclusive = shiftISO(endDate, -1);
  return inclusive && inclusive > dateISO ? inclusive : null;
}
