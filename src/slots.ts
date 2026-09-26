// Pure logic for tasks that repeat at several fixed times WITHIN a day — "check the litter
// tray morning, afternoon and evening, then it's done until tomorrow". No Obsidian imports.
//
// The existing recurrence model can't express this: `complete_instances` holds one ISO DATE
// per occurrence, so a daily task is completable exactly once, and ticking it immediately
// rolls `scheduled` to tomorrow. A multi-slot task instead keeps a per-day list of which
// slots have been ticked, and only rolls forward once the day is finished.
//
// Rule for "finished": **the last slot of the day has been ticked.** Skipping the 13:00 check
// doesn't trap the task on today's list — ticking 20:00 closes the day and it starts clean
// tomorrow. Missed slots stay visibly unticked but never roll over.

import { minutesOfDay } from "./dates";

export interface TaskSlot {
  /** "HH:MM" — always normalised, so slots sort as strings. */
  time: string;
  /** Optional name, e.g. "Morning". Empty when the slot is just a time. */
  label: string;
}

const SLOT = /^(\d{1,2}):(\d{2})\s*(.*)$/;

function validHM(h: number, m: number): boolean {
  return h >= 0 && h < 24 && m >= 0 && m < 60;
}

/** Parse one stored slot line: `"08:00 Morning"` or `"8:00"`. Null when unusable. */
export function parseSlot(raw: unknown): TaskSlot | null {
  const m = SLOT.exec(String(raw ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!validHM(h, min)) return null;
  return { time: `${String(h).padStart(2, "0")}:${m[2]}`, label: m[3].trim() };
}

/**
 * Parse the `times:` list. Sorted by clock and de-duplicated by time — two slots at 08:00
 * would be indistinguishable once ticked, so the first one wins.
 */
export function parseSlots(raw: unknown): TaskSlot[] {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const seen = new Set<string>();
  const out: TaskSlot[] = [];
  for (const item of list) {
    const slot = parseSlot(item);
    if (!slot || seen.has(slot.time)) continue;
    seen.add(slot.time);
    out.push(slot);
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/** Serialise back to frontmatter lines. Round-trips with parseSlots. */
export function formatSlot(slot: TaskSlot): string {
  return slot.label ? `${slot.time} ${slot.label}` : slot.time;
}

/** How a slot reads in the UI: "Morning 13:00", or just "13:00". */
export function slotTitle(slot: TaskSlot): string {
  return slot.label ? `${slot.label} ${slot.time}` : slot.time;
}

/** Is this a multi-slot task at all? */
export function hasSlots(slots: TaskSlot[]): boolean {
  return slots.length > 0;
}

// ── Per-day completion ───────────────────────────────────────────────────────

/** Times ticked on a given day, normalised. */
export function doneTimesOn(completeSlots: Record<string, string[]>, dateISO: string): string[] {
  const raw = completeSlots[dateISO];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const slot = parseSlot(t);
    if (slot && !out.includes(slot.time)) out.push(slot.time);
  }
  return out.sort();
}

export function isSlotDone(
  completeSlots: Record<string, string[]>,
  dateISO: string,
  time: string
): boolean {
  return doneTimesOn(completeSlots, dateISO).includes(time);
}

export interface SlotProgress {
  done: number;
  total: number;
  /** The earliest slot still unticked, or null when every slot is done. */
  next: TaskSlot | null;
  /** The day is finished — the LAST slot has been ticked. */
  dayComplete: boolean;
}

export function slotProgress(
  slots: TaskSlot[],
  completeSlots: Record<string, string[]>,
  dateISO: string
): SlotProgress {
  const done = doneTimesOn(completeSlots, dateISO);
  const open = slots.filter((s) => !done.includes(s.time));
  const last = slots[slots.length - 1];
  return {
    done: slots.filter((s) => done.includes(s.time)).length,
    total: slots.length,
    next: open[0] ?? null,
    // Ticking the final slot closes the day even if an earlier one was skipped.
    dayComplete: !!last && done.includes(last.time),
  };
}

/**
 * Which slot a "just tick the next one" action should hit — the earliest still open.
 * Null when the day is already finished.
 */
export function nextOpenSlot(
  slots: TaskSlot[],
  completeSlots: Record<string, string[]>,
  dateISO: string
): TaskSlot | null {
  return slotProgress(slots, completeSlots, dateISO).next;
}

/**
 * Toggle one slot for one day, returning a NEW map (never mutates).
 * A day whose list empties is removed entirely, so the log doesn't accumulate `[]` entries.
 */
export function withSlotToggled(
  completeSlots: Record<string, string[]>,
  dateISO: string,
  time: string
): Record<string, string[]> {
  const next = { ...completeSlots };
  const done = doneTimesOn(completeSlots, dateISO);
  const after = done.includes(time) ? done.filter((t) => t !== time) : [...done, time].sort();
  if (after.length) next[dateISO] = after;
  else delete next[dateISO];
  return next;
}

/**
 * Drop day-logs older than `keepDays` before `todayISO`, so a task ticked three times a day
 * for years doesn't grow an unbounded frontmatter map. History beyond the window isn't used
 * by anything — the task's state is "what's left today".
 */
export function pruneSlotLog(
  completeSlots: Record<string, string[]>,
  todayISO: string,
  keepDays = 14
): Record<string, string[]> {
  const cutoff = new Date(Date.parse(todayISO + "T00:00:00Z") - keepDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const out: Record<string, string[]> = {};
  for (const [day, times] of Object.entries(completeSlots)) {
    if (day >= cutoff) out[day] = times;
  }
  return out;
}

/** Slot times as minutes-of-day, for placing blocks on the hour grid. */
export function slotMinutes(slot: TaskSlot): number {
  return minutesOfDay(slot.time) ?? 0;
}
