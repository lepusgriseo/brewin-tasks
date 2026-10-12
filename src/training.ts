// Brewin Fitness's plan, drawn on the Planner's calendar. Pure, no Obsidian imports.
//
// Workouts used to live twice: as recurring calendar events and as the Fitness plan. The two
// drifted — an old evening split kept repeating long after the plan replaced it — because nothing
// tied them together. Now the calendar draws what Fitness has scheduled, so there is one source of
// truth. The plan says *what* and in which order; the times here say *when*.

import { addMinutesHM, minutesOfDay } from "./dates";
import { CalendarItem } from "./types";

/** What the Fitness plugin knows, reduced to the three questions the calendar asks. */
export interface TrainingSource {
  /** Routines scheduled on a day, in training order (morning first). */
  slots(dateISO: string): string[];
  /** True when the plan says "rest" that day and schedules nothing. */
  isRest(dateISO: string): boolean;
  /** The session logged for a routine on a day, if one has been started. */
  session(routine: string, dateISO: string): { path: string; status: string } | null;
}

/** "06:15, 20:00" → ["06:15", "20:00"]; anything that is not a clock time is dropped. */
export function parseTimes(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s) && minutesOfDay(s) != null)
    .map((s) => (s.length === 4 ? `0${s}` : s));
}

/**
 * When the n-th session of a day starts. A day with more sessions than configured times puts the
 * extras an hour apart after the last one — rare, but it must not stack them on top of each other.
 */
export function slotTime(times: string[], index: number): string | null {
  if (!times.length) return null;
  if (index < times.length) return times[index];
  return addMinutesHM(times[times.length - 1], 60 * (index - times.length + 1));
}

function* days(fromISO: string, toISO: string): Generator<string> {
  const d = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) yield d.toISOString().slice(0, 10);
}

/**
 * Calendar items for every scheduled session in [fromISO, toISO], plus an all-day marker on rest
 * days. A session counts as done once Fitness has it finished; one started but unfinished is not.
 */
export function trainingItems(src: TrainingSource, fromISO: string, toISO: string, times: string[], minutes: number, category = "Health"): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const date of days(fromISO, toISO)) {
    const slots = src.slots(date);
    if (!slots.length) {
      if (src.isRest(date)) {
        out.push({
          kind: "training", path: `training:${date}:rest`, title: "Rest day", date, allDay: true,
          start: null, end: null, done: false, category, recurring: true,
          training: { routine: "", sessionPath: null, rest: true },
        });
      }
      continue;
    }
    slots.forEach((routine, i) => {
      const start = slotTime(times, i);
      const logged = src.session(routine, date);
      out.push({
        kind: "training",
        path: logged?.path ?? `training:${date}:${routine}`,
        title: routine,
        date,
        allDay: start == null,
        start,
        end: start ? addMinutesHM(start, minutes) : null,
        done: logged?.status === "complete",
        category,
        recurring: true, // never draggable: the plan owns it
        training: { routine, sessionPath: logged?.path ?? null, rest: false },
      });
    });
  }
  return out;
}

// ── Reading a Fitness plan without asking Fitness once per day ──────────────────
//
// Fitness answers "what's on day X?" by re-reading its plan and every session note. A month view
// asks that 42 times; on a phone that is tens of thousands of frontmatter reads per render. So the
// bridge reads the plan and sessions once, and this interprets the plan's schedule format — a
// weekday maps to a routine name, "rest", or a list of either (morning first).

const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dayEntries(schedule: Record<string, unknown>, dateISO: string): unknown[] {
  const key = WEEKDAY_KEYS[new Date(`${dateISO}T00:00:00Z`).getUTCDay()];
  const v = schedule[key];
  return Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
}

/** The routines a Fitness plan schedules on a date, in order. */
export function planSlots(schedule: Record<string, unknown>, dateISO: string): string[] {
  return dayEntries(schedule, dateISO).filter((v): v is string => typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "rest");
}

/** A rest day says "rest" and schedules nothing — an unset day is not a rest day. */
export function planIsRest(schedule: Record<string, unknown>, dateISO: string): boolean {
  const entries = dayEntries(schedule, dateISO);
  return entries.some((v) => typeof v === "string" && v.trim().toLowerCase() === "rest") && planSlots(schedule, dateISO).length === 0;
}
